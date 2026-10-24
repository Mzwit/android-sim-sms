package com.androidsimsms.gateway

import android.Manifest
import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.telephony.SmsManager
import android.telephony.SubscriptionInfo
import android.telephony.SubscriptionManager
import android.telephony.TelephonyManager
import androidx.core.content.ContextCompat
import org.json.JSONObject

/** SIM, permission and health inspection, and the actual SmsManager call. */
object Phone {

    val REQUIRED_PERMISSIONS: List<String> = buildList {
        add(Manifest.permission.SEND_SMS)
        add(Manifest.permission.READ_PHONE_STATE)
        add(Manifest.permission.RECEIVE_SMS)
        if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
    }

    fun has(ctx: Context, perm: String) = ContextCompat.checkSelfPermission(ctx, perm) == PackageManager.PERMISSION_GRANTED

    fun permissionMap(ctx: Context): Map<String, Boolean> = (REQUIRED_PERMISSIONS + Manifest.permission.CAMERA)
        .associate { it.substringAfterLast('.') to has(ctx, it) }

    fun hasTelephony(ctx: Context) = ctx.packageManager.hasSystemFeature(PackageManager.FEATURE_TELEPHONY_MESSAGING) ||
        ctx.packageManager.hasSystemFeature(PackageManager.FEATURE_TELEPHONY)

    @SuppressLint("MissingPermission")
    fun activeSims(ctx: Context): List<SubscriptionInfo> {
        if (!has(ctx, Manifest.permission.READ_PHONE_STATE)) return emptyList()
        val sm = ctx.getSystemService(SubscriptionManager::class.java) ?: return emptyList()
        return try { sm.activeSubscriptionInfoList ?: emptyList() } catch (e: SecurityException) { emptyList() }
    }

    fun simFor(ctx: Context, subId: Int): SubscriptionInfo? = activeSims(ctx).firstOrNull { it.subscriptionId == subId }

    fun simStateName(state: Int) = when (state) {
        TelephonyManager.SIM_STATE_READY -> "READY"
        TelephonyManager.SIM_STATE_ABSENT -> "ABSENT"
        TelephonyManager.SIM_STATE_PIN_REQUIRED -> "PIN_REQUIRED"
        TelephonyManager.SIM_STATE_PUK_REQUIRED -> "PUK_REQUIRED"
        TelephonyManager.SIM_STATE_NETWORK_LOCKED -> "NETWORK_LOCKED"
        TelephonyManager.SIM_STATE_NOT_READY -> "NOT_READY"
        TelephonyManager.SIM_STATE_PERM_DISABLED -> "DISABLED"
        TelephonyManager.SIM_STATE_CARD_IO_ERROR -> "CARD_ERROR"
        TelephonyManager.SIM_STATE_CARD_RESTRICTED -> "RESTRICTED"
        else -> "UNKNOWN"
    }

    private fun telephonyFor(ctx: Context, subId: Int): TelephonyManager? {
        val tm = ctx.getSystemService(TelephonyManager::class.java) ?: return null
        return if (subId >= 0) tm.createForSubscriptionId(subId) else tm
    }

    /** Ready to send through the selected SIM? Returns null when ready, or an app error code. */
    fun readiness(ctx: Context, subId: Int): String? {
        if (!has(ctx, Manifest.permission.SEND_SMS)) return "PERMISSION_DENIED"
        if (subId < 0) return "SIM_NOT_READY"
        val sim = simFor(ctx, subId) ?: return "SIM_CHANGED"
        val tm = ctx.getSystemService(TelephonyManager::class.java) ?: return "SIM_NOT_READY"
        if (tm.getSimState(sim.simSlotIndex) != TelephonyManager.SIM_STATE_READY) return "SIM_NOT_READY"
        return null
    }

    @SuppressLint("MissingPermission")
    fun health(ctx: Context, subId: Int): JSONObject {
        val o = JSONObject()
        val bm = ctx.getSystemService(BatteryManager::class.java)
        o.put("battery_pct", bm?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)?.takeIf { it in 0..100 } ?: JSONObject.NULL)
        o.put("is_charging", bm?.isCharging ?: JSONObject.NULL)
        val tm = telephonyFor(ctx, subId)
        if (tm != null) {
            if (Build.VERSION.SDK_INT >= 28) {
                val ss = try { tm.signalStrength } catch (e: SecurityException) { null }
                o.put("signal_level", ss?.level ?: JSONObject.NULL)
                val dbm = if (Build.VERSION.SDK_INT >= 29) ss?.cellSignalStrengths?.firstOrNull()?.dbm else null
                o.put("signal_dbm", dbm?.takeIf { it in -200..0 } ?: JSONObject.NULL)
            }
            o.put("network_type", try { if (has(ctx, Manifest.permission.READ_PHONE_STATE)) networkTypeName(tm.dataNetworkType) else JSONObject.NULL } catch (e: SecurityException) { JSONObject.NULL })
            val sim = simFor(ctx, subId)
            val baseTm = ctx.getSystemService(TelephonyManager::class.java)
            o.put("sim_state", if (sim != null && baseTm != null) simStateName(baseTm.getSimState(sim.simSlotIndex)) else if (subId < 0) "NOT_SELECTED" else "MISSING")
            o.put("service_state", try { tm.serviceState?.state?.let { serviceStateName(it) } ?: JSONObject.NULL } catch (e: Exception) { JSONObject.NULL })
        }
        val perms = JSONObject()
        permissionMap(ctx).forEach { (k, v) -> perms.put(k, v) }
        o.put("permissions", perms)
        val details = JSONObject()
        details.put("battery_optimisation_ignored", isIgnoringBatteryOptimizations(ctx))
        details.put("internet", hasInternet(ctx))
        details.put("model", "${Build.MANUFACTURER} ${Build.MODEL}")
        o.put("details", details)
        o.put("app_version", BuildConfig.VERSION_NAME)
        return o
    }

    private fun networkTypeName(t: Int) = when (t) {
        TelephonyManager.NETWORK_TYPE_NR -> "5G"
        TelephonyManager.NETWORK_TYPE_LTE -> "LTE"
        TelephonyManager.NETWORK_TYPE_HSPAP, TelephonyManager.NETWORK_TYPE_HSPA, TelephonyManager.NETWORK_TYPE_HSDPA,
        TelephonyManager.NETWORK_TYPE_HSUPA, TelephonyManager.NETWORK_TYPE_UMTS -> "3G"
        TelephonyManager.NETWORK_TYPE_EDGE, TelephonyManager.NETWORK_TYPE_GPRS -> "2G"
        TelephonyManager.NETWORK_TYPE_UNKNOWN -> "UNKNOWN"
        else -> "OTHER_$t"
    }

    private fun serviceStateName(s: Int) = when (s) {
        android.telephony.ServiceState.STATE_IN_SERVICE -> "IN_SERVICE"
        android.telephony.ServiceState.STATE_OUT_OF_SERVICE -> "OUT_OF_SERVICE"
        android.telephony.ServiceState.STATE_EMERGENCY_ONLY -> "EMERGENCY_ONLY"
        android.telephony.ServiceState.STATE_POWER_OFF -> "POWER_OFF"
        else -> "UNKNOWN"
    }

    fun isIgnoringBatteryOptimizations(ctx: Context): Boolean =
        ctx.getSystemService(PowerManager::class.java)?.isIgnoringBatteryOptimizations(ctx.packageName) ?: false

    fun hasInternet(ctx: Context): Boolean {
        val cm = ctx.getSystemService(ConnectivityManager::class.java) ?: return false
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    fun bootCount(ctx: Context): Int = try { Settings.Global.getInt(ctx.contentResolver, Settings.Global.BOOT_COUNT) } catch (e: Exception) { 0 }

    @Suppress("DEPRECATION")
    fun smsManager(ctx: Context, subId: Int): SmsManager =
        if (Build.VERSION.SDK_INT >= 31) ctx.getSystemService(SmsManager::class.java).createForSubscriptionId(subId)
        else SmsManager.getSmsManagerForSubscriptionId(subId)

    /**
     * Hand one message to Android. sentIntent/deliveryIntent broadcasts come back to
     * [SmsResultReceiver] with the attempt id and part index. Returns the number of parts.
     */
    fun send(ctx: Context, subId: Int, attemptId: String, messageId: String, phone: String, body: String, kind: String = SmsResultReceiver.KIND_JOB): Int {
        val sms = smsManager(ctx, subId)
        val parts = sms.divideMessage(body)
        val sent = ArrayList<PendingIntent>(parts.size)
        val delivered = ArrayList<PendingIntent>(parts.size)
        parts.indices.forEach { i ->
            sent.add(resultIntent(ctx, SmsResultReceiver.ACTION_SENT, kind, attemptId, messageId, i, parts.size))
            delivered.add(resultIntent(ctx, SmsResultReceiver.ACTION_DELIVERED, kind, attemptId, messageId, i, parts.size))
        }
        if (parts.size == 1) sms.sendTextMessage(phone, null, parts[0], sent[0], delivered[0])
        else sms.sendMultipartTextMessage(phone, null, parts, sent, delivered)
        return parts.size
    }

    private fun resultIntent(ctx: Context, action: String, kind: String, attemptId: String, messageId: String, part: Int, total: Int): PendingIntent {
        val i = Intent(ctx, SmsResultReceiver::class.java).apply {
            this.action = action
            // A unique data URI keeps each part's PendingIntent distinct.
            data = android.net.Uri.parse("smsgw://$action/$attemptId/$part")
            putExtra(SmsResultReceiver.EXTRA_KIND, kind)
            putExtra(SmsResultReceiver.EXTRA_ATTEMPT, attemptId)
            putExtra(SmsResultReceiver.EXTRA_MESSAGE, messageId)
            putExtra(SmsResultReceiver.EXTRA_PART, part)
            putExtra(SmsResultReceiver.EXTRA_TOTAL, total)
        }
        // MUTABLE is required: the system adds the delivery PDU to the intent. The intent is explicit.
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
        return PendingIntent.getBroadcast(ctx, (attemptId.hashCode() * 31 + part) * 2 + (if (action == SmsResultReceiver.ACTION_SENT) 0 else 1), i, flags)
    }
}
