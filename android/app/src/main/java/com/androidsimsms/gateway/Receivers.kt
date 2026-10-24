package com.androidsimsms.gateway

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Telephony
import android.telephony.SmsMessage
import androidx.core.content.ContextCompat
import org.json.JSONObject

/** sentIntent / deliveryIntent results for every part we hand to Android. */
class SmsResultReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val attempt = intent.getStringExtra(EXTRA_ATTEMPT) ?: return
        val part = intent.getIntExtra(EXTRA_PART, 0)
        val total = intent.getIntExtra(EXTRA_TOTAL, 1)
        val kind = intent.getStringExtra(EXTRA_KIND) ?: KIND_JOB
        val journal = Journal.get(ctx)
        when (intent.action) {
            ACTION_SENT -> {
                // Activity.RESULT_OK (-1) means the part was handed to the network.
                val code = resultCode
                if (kind == KIND_DIAGNOSTIC) {
                    GatewayState.diagnosticResult(code)
                    journal.enqueueEvent("DIAGNOSTIC_SMS", mapOf("to" to (intent.getStringExtra(EXTRA_MESSAGE) ?: ""), "result_code" to code))
                } else {
                    journal.recordPart(attempt, part, total, code)
                    journal.enqueueEvent("PART_SENT", mapOf("attempt_id" to attempt, "part_index" to part, "parts_total" to total, "result_code" to code))
                    if (code != -1) journal.logError("Send failed: result code $code (${errorName(code)})")
                }
            }
            ACTION_DELIVERED -> {
                if (kind == KIND_DIAGNOSTIC) return
                val pdu = intent.getByteArrayExtra("pdu") ?: return
                val format = intent.getStringExtra("format") ?: "3gpp"
                val status = try { SmsMessage.createFromPdu(pdu, format)?.status } catch (e: Exception) { null } ?: return
                // CDMA reports status in bits 24+; normalise to the GSM TP-Status range.
                val tp = if (format == "3gpp2") (status shr 24) and 0xff else status and 0xff
                journal.enqueueEvent("DELIVERY", mapOf("attempt_id" to attempt, "part_index" to part, "tp_status" to tp))
            }
        }
        GatewayService.poke(ctx)
    }

    companion object {
        const val ACTION_SENT = "com.androidsimsms.gateway.SMS_SENT"
        const val ACTION_DELIVERED = "com.androidsimsms.gateway.SMS_DELIVERED"
        const val EXTRA_ATTEMPT = "attempt"
        const val EXTRA_MESSAGE = "message"
        const val EXTRA_PART = "part"
        const val EXTRA_TOTAL = "total"
        const val EXTRA_KIND = "kind"
        const val KIND_JOB = "job"
        const val KIND_DIAGNOSTIC = "diag"

        fun errorName(code: Int) = when (code) {
            -1 -> "OK"; 1 -> "GENERIC_FAILURE"; 2 -> "RADIO_OFF"; 3 -> "NULL_PDU"; 4 -> "NO_SERVICE"
            5 -> "LIMIT_EXCEEDED (Android SMS limit)"; 6 -> "FDN_CHECK_FAILURE"; 7, 8 -> "SHORT_CODE_NOT_ALLOWED"
            10 -> "NETWORK_REJECT"; 17 -> "NETWORK_ERROR"; 19 -> "INVALID_SMSC_ADDRESS"; else -> "code $code"
        }
    }
}

/**
 * Incoming SMS. Only replies that are an opt-out keyword are forwarded to the server;
 * every other message stays on the phone and is never uploaded.
 */
class InboundSmsReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        val prefs = Prefs(ctx)
        if (!prefs.isPaired) return
        val keywords = prefs.lastConfigJson?.let { cfg ->
            try {
                val arr = JSONObject(cfg).optJSONArray("opt_out_keywords")
                (0 until (arr?.length() ?: 0)).map { arr!!.getString(it) }
            } catch (e: Exception) { null }
        } ?: listOf("STOP")
        val msgs = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
        msgs.groupBy { it.originatingAddress }.forEach { (from, parts) ->
            if (from == null) return@forEach
            val body = parts.joinToString("") { it.messageBody ?: "" }
            if (Protocol.isOptOut(body, keywords)) {
                Journal.get(ctx).enqueueEvent("INBOUND", mapOf("from" to from, "body" to body.trim().take(40)))
                GatewayService.poke(ctx)
            }
        }
    }
}

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val prefs = Prefs(ctx)
        if (prefs.isPaired && prefs.wantRunning) {
            try {
                ContextCompat.startForegroundService(ctx, Intent(ctx, GatewayService::class.java))
            } catch (e: Exception) {
                Notifications.restartNeeded(ctx, if (Build.VERSION.SDK_INT >= 31) e.javaClass.simpleName else "")
            }
        }
    }
}
