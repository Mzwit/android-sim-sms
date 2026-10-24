package com.androidsimsms.gateway

import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.PowerManager
import android.os.SystemClock
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import java.io.IOException

/**
 * Foreground service that turns the phone into the gateway.
 *
 * Loop: report outbox → heartbeat (config + commands) → lease a batch → for each job:
 *   confirm with server → journal SENDING → SmsManager → wait for sentIntent → report.
 * The phone never sends a message the server did not confirm moments earlier.
 */
class GatewayService : LifecycleService() {

    companion object {
        const val ACTION_START = "start"
        const val ACTION_PAUSE = "pause"
        const val ACTION_RESUME = "resume"
        const val ACTION_STOP = "stop"
        const val ACTION_EMERGENCY = "emergency"

        @Volatile var isRunning = false
            private set

        private val wake = Channel<Unit>(Channel.CONFLATED)

        /** Wake the loop early (new results to report, user action). */
        fun poke(ctx: Context) {
            wake.trySend(Unit)
        }

        fun command(ctx: Context, action: String) {
            val i = Intent(ctx, GatewayService::class.java).setAction(action)
            if (action == ACTION_START || isRunning) ContextCompat.startForegroundService(ctx, i)
        }

        private const val SENT_RESULT_TIMEOUT_MS = 120_000L
    }

    private lateinit var prefs: Prefs
    private lateinit var journal: Journal
    private var loop: Job? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var config: JSONObject? = null
    private var nextHeartbeatAt = 0L
    private var failures = 0
    private var lastProblem: String? = null
    private var stopRequested: String? = null

    override fun onCreate() {
        super.onCreate()
        prefs = Prefs(this)
        journal = Journal.get(this)
        config = prefs.lastConfigJson?.let { runCatching { JSONObject(it) }.getOrNull() }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)
        val type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
        ServiceCompat.startForeground(this, Notifications.ID_SERVICE, Notifications.service(this, "Starting…"), type)
        when (intent?.action) {
            ACTION_PAUSE -> { prefs.locallyPaused = true; poke(this) }
            ACTION_RESUME -> { prefs.locallyPaused = false; poke(this) }
            ACTION_STOP -> { stopRequested = "USER_STOPPED"; prefs.wantRunning = false; poke(this) }
            ACTION_EMERGENCY -> { stopRequested = "EMERGENCY_STOP"; prefs.wantRunning = false; poke(this) }
            else -> prefs.wantRunning = true
        }
        if (!prefs.isPaired) {
            stopSelf()
            return START_NOT_STICKY
        }
        if (loop?.isActive != true) {
            isRunning = true
            loop = lifecycleScope.launch(Dispatchers.IO) { runLoop() }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        isRunning = false
        releaseWake()
        GatewayState.update { it.copy(running = false, phase = "Stopped") }
        super.onDestroy()
    }

    private fun api() = Api(prefs.serverUrl!!, prefs.token, prefs.certFingerprint)

    private fun status(phase: String) {
        val s = GatewayState.state.value
        GatewayState.update { it.copy(running = true, phase = phase, pendingLocal = journal.countIn("LEASED", "CONFIRMING", "SENDING"), outbox = journal.outboxSize()) }
        val n = Notifications.service(this, "$phase · sent ${s.sentThisSession} · failed ${s.failedThisSession}")
        getSystemService(android.app.NotificationManager::class.java).notify(Notifications.ID_SERVICE, n)
    }

    private suspend fun waitOrPoke(ms: Long) {
        withTimeoutOrNull(ms) { wake.receive() }
    }

    private suspend fun runLoop() {
        recover()
        status("Connecting")
        sendLifecycleHeartbeat("SERVICE_STARTED")
        while (lifecycleScope.isActive) {
            stopRequested?.let { reason ->
                shutdown(reason)
                return
            }
            if (!prefs.isPaired) { shutdown("UNPAIRED"); return }
            try {
                val api = api()
                flushOutbox(api)
                if (SystemClock.elapsedRealtime() >= nextHeartbeatAt) heartbeat(api)
                val cfg = config ?: JSONObject()

                val blocked = when {
                    cfg.optBoolean("emergency_stop") -> "EMERGENCY_STOP" to "Emergency stop (set on the dashboard)"
                    cfg.optBoolean("kill_switch") -> "KILL_SWITCH" to "Kill switch engaged: ${cfg.optString("kill_switch_reason")}"
                    cfg.optBoolean("paused") -> "GATEWAY_PAUSED" to "Paused on dashboard: ${cfg.optString("pause_reason")}"
                    prefs.locallyPaused -> "LOCAL_PAUSE" to "Paused on this phone"
                    else -> null
                }
                if (blocked != null) {
                    releaseUnconfirmed(api, blocked.first)
                    GatewayState.update { it.copy(serverPaused = cfg.optBoolean("paused"), pauseReason = blocked.second, killSwitch = cfg.optBoolean("kill_switch"), emergency = cfg.optBoolean("emergency_stop")) }
                    status(blocked.second)
                    releaseWake()
                    waitOrPoke(30_000)
                    continue
                }
                GatewayState.update { it.copy(serverPaused = false, pauseReason = null, killSwitch = false, emergency = false) }

                val problem = Phone.readiness(this, prefs.simSubscriptionId)
                if (problem != null) {
                    releaseUnconfirmed(api, problem)
                    if (problem != lastProblem) {
                        lastProblem = problem
                        val text = when (problem) {
                            "PERMISSION_DENIED" -> "SMS permission is not granted. Open the app and allow it."
                            "SIM_CHANGED" -> "The selected SIM is no longer present. Choose a SIM in the app."
                            else -> "The selected SIM is not ready (no SIM, PIN required, or not selected)."
                        }
                        journal.logError(text)
                        Notifications.alert(this, "Gateway cannot send", text)
                        sendLifecycleHeartbeat(if (problem == "PERMISSION_DENIED") "PERMISSION_LOST" else "SIM_CHANGED", JSONObject().put("problem", problem))
                    }
                    GatewayState.update { it.copy(lastError = problem) }
                    status("Cannot send: $problem")
                    waitOrPoke(30_000)
                    continue
                }
                lastProblem = null

                val job = journal.nextLeased()
                if (job == null) {
                    releaseWake()
                    status("Waiting for messages")
                    val lease = api.lease(cfg.optInt("batch_limit", 20))
                    val jobs = lease.optJSONArray("jobs")
                    if (jobs == null || jobs.length() == 0) {
                        val reason = lease.optString("idle_reason", "NO_WORK")
                        status(if (reason == "NO_WORK") "Idle (nothing to send)" else "Idle: $reason")
                        waitOrPoke(lease.optLong("next_poll_ms", 30_000).coerceIn(5_000, 120_000))
                    } else {
                        val now = SystemClock.elapsedRealtime()
                        val boot = Phone.bootCount(this)
                        journal.addJobs((0 until jobs.length()).map { i ->
                            val j = jobs.getJSONObject(i)
                            Journal.Job(
                                j.getString("attempt_id"), j.getString("message_id"), j.getString("phone"), j.getString("body"),
                                j.optInt("segments", 1), j.optBoolean("is_test"), Protocol.leaseDeadline(now, j.optInt("lease_seconds", 300)),
                                boot, "LEASED", 0, 0, 0,
                            )
                        })
                    }
                    failures = 0
                    GatewayState.update { it.copy(connected = true, lastContactAt = System.currentTimeMillis()) }
                    continue
                }

                acquireWake()
                process(api, job)
                failures = 0
                GatewayState.update { it.copy(connected = true, lastContactAt = System.currentTimeMillis()) }
                val interval = maxOf(cfg.optLong("send_interval_ms", 6_000), prefs.localMinIntervalMs)
                GatewayState.update { it.copy(sendIntervalMs = interval) }
                delay(interval) // pacing is not shortened by pokes
            } catch (e: ApiException) {
                if (e.status == 401 || e.status == 403) {
                    journal.logError("Server refused this phone (${e.code}). It may have been revoked; pair again.")
                    Notifications.alert(this, "Gateway unpaired", "The server no longer accepts this phone (${e.code}). Pair it again from the dashboard.")
                    prefs.unpair()
                    shutdown("REVOKED")
                    return
                }
                backoff("Server error ${e.status}: ${e.message}")
            } catch (e: IOException) {
                backoff("Cannot reach server: ${e.message ?: e.javaClass.simpleName}")
            } catch (e: Exception) {
                backoff("Unexpected error: ${e.javaClass.simpleName}: ${e.message}")
            }
        }
    }

    private suspend fun backoff(msg: String) {
        failures++
        journal.logError(msg)
        GatewayState.update { it.copy(connected = false, lastError = msg) }
        status("Offline – retrying")
        releaseWake()
        waitOrPoke(Protocol.backoffMs(failures))
    }

    /** One message: confirm → journal → radio → wait for the sent result. */
    private suspend fun process(api: Api, job: Journal.Job) {
        val now = SystemClock.elapsedRealtime()
        if (job.bootCount != Phone.bootCount(this) || now > job.leaseDeadline) {
            journal.setState(job.attemptId, "NOT_SENT")
            journal.enqueueEvent("NOT_SENT", mapOf("attempt_id" to job.attemptId, "reason" to "LEASE_EXPIRED_ON_PHONE"))
            return
        }
        status("Sending")
        journal.setState(job.attemptId, "CONFIRMING")
        val decision = try {
            api.confirm(job.attemptId)
        } catch (e: IOException) {
            // We do not know whether the server recorded the confirmation, but we certainly did not send.
            journal.setState(job.attemptId, "NOT_SENT")
            journal.enqueueEvent("NOT_SENT", mapOf("attempt_id" to job.attemptId, "reason" to "CONFIRM_FAILED"))
            throw e
        }
        if (!decision.first) {
            journal.setState(job.attemptId, "REFUSED")
            return
        }
        // Re-check locally right before the radio: SIM still there, permission still granted.
        Phone.readiness(this, prefs.simSubscriptionId)?.let { problem ->
            journal.setState(job.attemptId, "FAILED")
            journal.enqueueEvent("SEND_ERROR", mapOf("attempt_id" to job.attemptId, "app_code" to problem))
            return
        }
        journal.setState(job.attemptId, "SENDING") // written BEFORE handing the SMS to Android
        val parts = try {
            withContext(Dispatchers.Main) {
                Phone.send(this@GatewayService, prefs.simSubscriptionId, job.attemptId, job.messageId, job.phone, job.body)
            }
        } catch (e: IllegalArgumentException) {
            journal.setState(job.attemptId, "FAILED")
            journal.enqueueEvent("SEND_ERROR", mapOf("attempt_id" to job.attemptId, "app_code" to "INVALID_NUMBER_LOCAL", "detail" to (e.message ?: "")))
            return
        } catch (e: SecurityException) {
            journal.setState(job.attemptId, "FAILED")
            journal.enqueueEvent("SEND_ERROR", mapOf("attempt_id" to job.attemptId, "app_code" to "PERMISSION_DENIED", "detail" to (e.message ?: "")))
            return
        } catch (e: Exception) {
            journal.setState(job.attemptId, "FAILED")
            journal.enqueueEvent("SEND_ERROR", mapOf("attempt_id" to job.attemptId, "app_code" to "SEND_EXCEPTION", "detail" to "${e.javaClass.simpleName}: ${e.message}"))
            return
        }
        journal.setState(job.attemptId, "SENDING", partsTotal = parts)

        // Wait for every part's sentIntent (recorded by SmsResultReceiver).
        val deadline = SystemClock.elapsedRealtime() + SENT_RESULT_TIMEOUT_MS
        var state = "SENDING"
        while (SystemClock.elapsedRealtime() < deadline) {
            state = journal.job(job.attemptId)?.state ?: "SENDING"
            if (state == "SUBMITTED" || state == "FAILED") break
            delay(300)
        }
        when (state) {
            "SUBMITTED" -> GatewayState.update { it.copy(sentThisSession = it.sentThisSession + 1) }
            "FAILED" -> GatewayState.update { it.copy(failedThisSession = it.failedThisSession + 1) }
            else -> {
                // Handed to Android, but no result: the server must treat this as UNKNOWN.
                journal.setState(job.attemptId, "UNKNOWN")
                journal.enqueueEvent("SUBMIT_UNKNOWN", mapOf("attempt_id" to job.attemptId, "app_code" to "SENT_TIMEOUT"))
                journal.logError("No sent result from Android within ${SENT_RESULT_TIMEOUT_MS / 1000}s; reported as UNKNOWN")
            }
        }
        try { flushOutbox(api) } catch (_: IOException) { }
    }

    /** Upload pending events in order; remove only those the server acknowledged. */
    private fun flushOutbox(api: Api) {
        repeat(20) {
            val batch = journal.peekEvents(100)
            if (batch.isEmpty()) return
            val acks = api.events(journal.eventsArray(batch))
            val okIds = mutableSetOf<String>()
            for (i in 0 until acks.length()) {
                val a = acks.getJSONObject(i)
                if (a.optBoolean("ok")) okIds.add(a.getString("id"))
            }
            val done = batch.filter { it.second.getString("id") in okIds }.map { it.first }
            // Events the server rejected (e.g. malformed) would block the queue forever; drop them after logging.
            val rejected = batch.filter { it.second.getString("id") !in okIds }
            rejected.forEach { journal.logError("Server rejected event ${it.second.optString("type")}") }
            journal.deleteEvents(done + rejected.map { it.first })
            if (batch.size < 100) return
        }
    }

    private fun heartbeat(api: Api, kind: String = "HEARTBEAT", details: JSONObject? = null) {
        val h = Phone.health(this, prefs.simSubscriptionId)
        h.put("kind", kind)
        h.put("queue_pending", journal.countIn("LEASED", "CONFIRMING", "SENDING"))
        h.put("service_running", true)
        if (details != null) {
            val d = h.optJSONObject("details") ?: JSONObject()
            details.keys().forEach { d.put(it, details.get(it)) }
            h.put("details", d)
        }
        val cfg = api.heartbeat(h)
        config = cfg
        prefs.lastConfigJson = cfg.toString()
        prefs.gatewayName = cfg.optString("name", prefs.gatewayName ?: "")
        nextHeartbeatAt = SystemClock.elapsedRealtime() + cfg.optLong("heartbeat_interval_ms", 60_000).coerceIn(15_000, 300_000)
    }

    private fun sendLifecycleHeartbeat(kind: String, details: JSONObject? = null) {
        try { heartbeat(api(), kind, details) } catch (e: Exception) { journal.logError("Could not report $kind: ${e.message}") }
    }

    /** Give back every job we have not asked to send yet. */
    private fun releaseUnconfirmed(api: Api, reason: String) {
        val jobs = journal.jobsIn("LEASED")
        if (jobs.isEmpty()) return
        jobs.forEach { journal.setState(it.attemptId, "NOT_SENT") }
        try {
            api.release(jobs.map { it.attemptId }, reason)
        } catch (e: IOException) {
            jobs.forEach { journal.enqueueEvent("NOT_SENT", mapOf("attempt_id" to it.attemptId, "reason" to reason)) }
        }
    }

    /**
     * After a crash, reboot or kill: decide what each unfinished job means.
     *  LEASED / CONFIRMING → certainly not sent (SENDING is written before the radio call).
     *  SENDING → may or may not have gone out: UNKNOWN (a late sentIntent can still resolve it).
     */
    private fun recover() {
        for (j in journal.jobsIn("LEASED", "CONFIRMING")) {
            journal.setState(j.attemptId, "NOT_SENT")
            journal.enqueueEvent("NOT_SENT", mapOf("attempt_id" to j.attemptId, "reason" to "APP_RESTARTED"))
        }
        for (j in journal.jobsIn("SENDING")) {
            journal.setState(j.attemptId, "UNKNOWN")
            journal.enqueueEvent("SUBMIT_UNKNOWN", mapOf("attempt_id" to j.attemptId, "app_code" to "PROCESS_KILLED"))
            journal.logError("Recovered after restart: 1 message may or may not have been sent (reported UNKNOWN)")
        }
        journal.prune()
    }

    private fun shutdown(reason: String) {
        try {
            val api = api()
            releaseUnconfirmed(api, reason)
            flushOutbox(api)
            heartbeat(api, if (reason == "EMERGENCY_STOP") "EMERGENCY_STOP" else "SERVICE_STOPPED", JSONObject().put("reason", reason))
        } catch (e: Exception) {
            journal.logError("Stopped without reaching the server: ${e.message}")
        }
        isRunning = false
        GatewayState.update { it.copy(running = false, phase = if (reason == "EMERGENCY_STOP") "Emergency stopped" else "Stopped") }
        releaseWake()
        lifecycleScope.launch(Dispatchers.Main) {
            ServiceCompat.stopForeground(this@GatewayService, ServiceCompat.STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
    }

    private fun acquireWake() {
        if (wakeLock?.isHeld == true) return
        wakeLock = getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "SimSmsGateway:sending").apply {
            setReferenceCounted(false)
            acquire(10 * 60_000L)
        }
    }

    private fun releaseWake() {
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
    }
}
