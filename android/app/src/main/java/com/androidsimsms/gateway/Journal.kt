package com.androidsimsms.gateway

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.util.UUID

/**
 * Local, crash-safe journal of every job the phone holds, plus an outbox of events
 * still to be reported. Every state change is written here BEFORE the action it
 * describes, so after a crash or reboot we know exactly what may have happened.
 *
 * Job states:
 *  LEASED      received from the server, nothing done
 *  CONFIRMING  asked the server for permission to send (answer unknown)
 *  SENDING     permission granted and the SMS handed to Android (radio)
 *  SUBMITTED / FAILED  all part results known
 *  UNKNOWN     handed to Android but no result arrived (timeout / crash)
 *  NOT_SENT    released without sending
 *  REFUSED     server said do not send
 */
class Journal private constructor(ctx: Context) : SQLiteOpenHelper(ctx, "journal.db", null, 1) {

    data class Job(
        val attemptId: String,
        val messageId: String,
        val phone: String,
        val body: String,
        val segments: Int,
        val isTest: Boolean,
        val leaseDeadline: Long,
        val bootCount: Int,
        val state: String,
        val partsTotal: Int,
        val partsOk: Int,
        val partsFailed: Int,
    )

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """CREATE TABLE jobs (
                attempt_id TEXT PRIMARY KEY, message_id TEXT NOT NULL, phone TEXT NOT NULL, body TEXT NOT NULL,
                segments INTEGER NOT NULL, is_test INTEGER NOT NULL, lease_deadline INTEGER NOT NULL, boot_count INTEGER NOT NULL,
                state TEXT NOT NULL, parts_total INTEGER NOT NULL DEFAULT 0, parts_ok INTEGER NOT NULL DEFAULT 0,
                parts_failed INTEGER NOT NULL DEFAULT 0, seq INTEGER NOT NULL, updated_at INTEGER NOT NULL)""",
        )
        db.execSQL("CREATE INDEX jobs_state ON jobs(state, seq)")
        db.execSQL("CREATE TABLE parts (attempt_id TEXT NOT NULL, part_index INTEGER NOT NULL, result_code INTEGER NOT NULL, PRIMARY KEY (attempt_id, part_index))")
        db.execSQL("CREATE TABLE outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, json TEXT NOT NULL, created_at INTEGER NOT NULL)")
        db.execSQL("CREATE TABLE errors (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, text TEXT NOT NULL)")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit

    private fun now() = System.currentTimeMillis()

    @Synchronized
    fun addJobs(jobs: List<Job>) {
        val db = writableDatabase
        db.beginTransaction()
        try {
            var seq = (db.rawQuery("SELECT coalesce(max(seq), 0) FROM jobs", null).use { it.moveToFirst(); it.getLong(0) })
            for (j in jobs) {
                db.insertWithOnConflict("jobs", null, ContentValues().apply {
                    put("attempt_id", j.attemptId); put("message_id", j.messageId); put("phone", j.phone); put("body", j.body)
                    put("segments", j.segments); put("is_test", if (j.isTest) 1 else 0); put("lease_deadline", j.leaseDeadline)
                    put("boot_count", j.bootCount); put("state", "LEASED"); put("seq", ++seq); put("updated_at", now())
                }, SQLiteDatabase.CONFLICT_IGNORE)
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    @Synchronized
    fun setState(attemptId: String, state: String, partsTotal: Int? = null) {
        writableDatabase.update("jobs", ContentValues().apply {
            put("state", state); put("updated_at", now()); partsTotal?.let { put("parts_total", it) }
        }, "attempt_id = ?", arrayOf(attemptId))
    }

    private fun cursorToJob(c: android.database.Cursor) = Job(
        c.getString(0), c.getString(1), c.getString(2), c.getString(3), c.getInt(4), c.getInt(5) == 1,
        c.getLong(6), c.getInt(7), c.getString(8), c.getInt(9), c.getInt(10), c.getInt(11),
    )

    private val cols = "attempt_id, message_id, phone, body, segments, is_test, lease_deadline, boot_count, state, parts_total, parts_ok, parts_failed"

    @Synchronized
    fun nextLeased(): Job? = readableDatabase.rawQuery("SELECT $cols FROM jobs WHERE state = 'LEASED' ORDER BY seq LIMIT 1", null).use {
        if (it.moveToFirst()) cursorToJob(it) else null
    }

    @Synchronized
    fun job(attemptId: String): Job? = readableDatabase.rawQuery("SELECT $cols FROM jobs WHERE attempt_id = ?", arrayOf(attemptId)).use {
        if (it.moveToFirst()) cursorToJob(it) else null
    }

    @Synchronized
    fun jobsIn(vararg states: String): List<Job> {
        val ph = states.joinToString(",") { "?" }
        return readableDatabase.rawQuery("SELECT $cols FROM jobs WHERE state IN ($ph) ORDER BY seq", states.toList().toTypedArray()).use {
            val out = mutableListOf<Job>()
            while (it.moveToNext()) out.add(cursorToJob(it))
            out
        }
    }

    @Synchronized
    fun countIn(vararg states: String): Int {
        val ph = states.joinToString(",") { "?" }
        return readableDatabase.rawQuery("SELECT count(*) FROM jobs WHERE state IN ($ph)", states.toList().toTypedArray()).use { it.moveToFirst(); it.getInt(0) }
    }

    /**
     * Record one part's sentIntent result. Returns the job's state after the update
     * (SUBMITTED when every part succeeded, FAILED when any part failed, else unchanged).
     * Duplicate results for the same part are ignored.
     */
    @Synchronized
    fun recordPart(attemptId: String, partIndex: Int, partsTotal: Int, resultCode: Int): String? {
        val db = writableDatabase
        db.beginTransaction()
        try {
            val inserted = db.insertWithOnConflict("parts", null, ContentValues().apply {
                put("attempt_id", attemptId); put("part_index", partIndex); put("result_code", resultCode)
            }, SQLiteDatabase.CONFLICT_IGNORE) != -1L
            val ok = if (inserted) 1 else 0
            if (inserted) {
                db.execSQL(
                    "UPDATE jobs SET parts_total = max(parts_total, ?), parts_ok = parts_ok + ?, parts_failed = parts_failed + ?, updated_at = ? WHERE attempt_id = ?",
                    arrayOf<Any>(partsTotal, if (resultCode == -1) ok else 0, if (resultCode != -1) ok else 0, now(), attemptId),
                )
            }
            val j = job(attemptId)
            var state = j?.state
            if (j != null && (j.state == "SENDING" || j.state == "UNKNOWN")) {
                state = when {
                    j.partsFailed > 0 -> "FAILED"
                    j.partsTotal > 0 && j.partsOk >= j.partsTotal -> "SUBMITTED"
                    else -> j.state
                }
                if (state != j.state) setState(attemptId, state!!)
            }
            db.setTransactionSuccessful()
            return state
        } finally {
            db.endTransaction()
        }
    }

    /** Drop finished jobs older than a day (results are already in the outbox or delivered). */
    @Synchronized
    fun prune() {
        val cutoff = now() - 24 * 3600_000L
        writableDatabase.execSQL("DELETE FROM parts WHERE attempt_id IN (SELECT attempt_id FROM jobs WHERE state IN ('SUBMITTED','FAILED','NOT_SENT','REFUSED','UNKNOWN') AND updated_at < ?)", arrayOf(cutoff))
        writableDatabase.execSQL("DELETE FROM jobs WHERE state IN ('SUBMITTED','FAILED','NOT_SENT','REFUSED','UNKNOWN') AND updated_at < ?", arrayOf(cutoff))
        writableDatabase.execSQL("DELETE FROM errors WHERE id NOT IN (SELECT id FROM errors ORDER BY id DESC LIMIT 100)")
    }

    // ---- outbox ----
    @Synchronized
    fun enqueueEvent(type: String, fields: Map<String, Any?>) {
        val id = UUID.randomUUID().toString()
        val o = JSONObject().put("id", id).put("type", type).put("at", Instant.now().toString())
        for ((k, v) in fields) o.put(k, v ?: JSONObject.NULL)
        writableDatabase.insert("outbox", null, ContentValues().apply { put("event_id", id); put("json", o.toString()); put("created_at", now()) })
    }

    @Synchronized
    fun peekEvents(limit: Int): List<Pair<Long, JSONObject>> =
        readableDatabase.rawQuery("SELECT id, json FROM outbox ORDER BY id LIMIT ?", arrayOf(limit.toString())).use {
            val out = mutableListOf<Pair<Long, JSONObject>>()
            while (it.moveToNext()) out.add(Pair(it.getLong(0), JSONObject(it.getString(1))))
            out
        }

    @Synchronized
    fun deleteEvents(ids: List<Long>) {
        if (ids.isEmpty()) return
        writableDatabase.execSQL("DELETE FROM outbox WHERE id IN (${ids.joinToString(",")})")
    }

    @Synchronized
    fun outboxSize(): Int = readableDatabase.rawQuery("SELECT count(*) FROM outbox", null).use { it.moveToFirst(); it.getInt(0) }

    fun eventsArray(events: List<Pair<Long, JSONObject>>) = JSONArray().apply { events.forEach { put(it.second) } }

    // ---- errors ----
    @Synchronized
    fun logError(text: String) {
        writableDatabase.insert("errors", null, ContentValues().apply { put("at", now()); put("text", text.take(300)) })
    }

    @Synchronized
    fun recentErrors(limit: Int = 20): List<Pair<Long, String>> =
        readableDatabase.rawQuery("SELECT at, text FROM errors ORDER BY id DESC LIMIT ?", arrayOf(limit.toString())).use {
            val out = mutableListOf<Pair<Long, String>>()
            while (it.moveToNext()) out.add(Pair(it.getLong(0), it.getString(1)))
            out
        }

    companion object {
        @Volatile private var instance: Journal? = null
        fun get(ctx: Context): Journal = instance ?: synchronized(this) { instance ?: Journal(ctx.applicationContext).also { instance = it } }
    }
}
