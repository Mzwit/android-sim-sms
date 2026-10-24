package com.androidsimsms.gateway

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.widget.ArrayAdapter
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.androidsimsms.gateway.databinding.ActivityDiagnosticsBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.text.DateFormat
import java.util.Date
import java.util.UUID

/** Checks everything that can stop the gateway, and sends a test SMS to an authorised number. */
class DiagnosticsActivity : AppCompatActivity() {
    private lateinit var b: ActivityDiagnosticsBinding
    private lateinit var prefs: Prefs

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        b = ActivityDiagnosticsBinding.inflate(layoutInflater)
        setContentView(b.root)
        prefs = Prefs(this)
        supportActionBar?.setDisplayHomeAsUpEnabled(true)
        b.btnRefresh.setOnClickListener { run() }
        b.btnBattery.setOnClickListener { requestBatteryExemption() }
        b.btnTestSms.setOnClickListener { sendTest() }
        b.txtAdb.text = getString(R.string.adb_hint)
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                GatewayState.state.collect { s -> s.diagnostic?.let { b.txtTestResult.text = it } }
            }
        }
        run()
    }

    override fun onSupportNavigateUp(): Boolean {
        finish()
        return true
    }

    private fun line(ok: Boolean?, text: String) = (when (ok) { true -> "✅ "; false -> "❌ "; null -> "⚠️ " }) + text

    private fun run() {
        val lines = mutableListOf<String>()
        lines += line(Phone.hasTelephony(this), "Phone can send SMS (telephony hardware)")
        Phone.permissionMap(this).forEach { (k, v) -> lines += line(v, "Permission $k") }
        val sims = Phone.activeSims(this)
        lines += line(sims.isNotEmpty(), "Active SIMs: ${sims.size}")
        val tm = getSystemService(android.telephony.TelephonyManager::class.java)
        sims.forEach { s -> lines += line(tm.getSimState(s.simSlotIndex) == android.telephony.TelephonyManager.SIM_STATE_READY, "SIM ${s.simSlotIndex + 1}: ${s.displayName} (${s.carrierName}) – ${Phone.simStateName(tm.getSimState(s.simSlotIndex))}") }
        val ready = Phone.readiness(this, prefs.simSubscriptionId)
        lines += line(ready == null, "Selected SIM ready to send" + (ready?.let { " ($it)" } ?: ""))
        val h = Phone.health(this, prefs.simSubscriptionId)
        lines += line(h.optInt("signal_level", -1) >= 1, "Signal level ${h.opt("signal_level")} / 4, network ${h.opt("network_type")}, service ${h.opt("service_state")}")
        lines += line(Phone.hasInternet(this), "Internet connection")
        lines += line(Phone.isIgnoringBatteryOptimizations(this), "Battery optimisation disabled for this app")
        lines += line(null, "Battery ${h.opt("battery_pct")}%${if (h.optBoolean("is_charging")) " (charging)" else " (keep the phone on a charger)"}")
        lines += line(prefs.isPaired, if (prefs.isPaired) "Paired as \"${prefs.gatewayName}\" with ${prefs.serverUrl}" else "Not paired")
        b.txtChecks.text = lines.joinToString("\n")

        val errors = Journal.get(this).recentErrors(15)
        val fmt = DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.MEDIUM)
        b.txtErrors.text = if (errors.isEmpty()) getString(R.string.no_errors) else errors.joinToString("\n") { "${fmt.format(Date(it.first))}  ${it.second}" }

        val tests = prefs.lastConfigJson?.let { runCatching { JSONObject(it).optJSONArray("test_numbers") }.getOrNull() }
        val list = (0 until (tests?.length() ?: 0)).map { tests!!.getString(it) }
        b.spinnerTest.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, list.ifEmpty { listOf(getString(R.string.no_test_numbers)) })
        b.btnTestSms.isEnabled = list.isNotEmpty() && ready == null

        if (prefs.isPaired) {
            lifecycleScope.launch {
                val r = withContext(Dispatchers.IO) { runCatching { Api(prefs.serverUrl!!, prefs.token, prefs.certFingerprint).config() } }
                b.txtServerCheck.text = r.fold(
                    { cfg ->
                        prefs.lastConfigJson = cfg.toString()
                        line(true, "Server reachable. Kill switch ${if (cfg.optBoolean("kill_switch")) "ON" else "off"}, gateway ${if (cfg.optBoolean("paused")) "PAUSED (${cfg.optString("pause_reason")})" else "active"}, interval ${cfg.optLong("send_interval_ms") / 1000.0}s")
                    },
                    { e -> line(false, "Server not reachable: ${e.message}") },
                )
            }
        }
    }

    @SuppressLint("BatteryLife")
    private fun requestBatteryExemption() {
        try {
            startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
        } catch (e: Exception) {
            startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        }
    }

    /** A real SMS through the selected SIM, only to numbers the server lists as authorised test numbers. */
    private fun sendTest() {
        val number = b.spinnerTest.selectedItem as? String ?: return
        val allowed = prefs.lastConfigJson?.let { cfg ->
            val arr = JSONObject(cfg).optJSONArray("test_numbers")
            (0 until (arr?.length() ?: 0)).map { arr!!.getString(it) }
        } ?: emptyList()
        if (!Protocol.isAuthorisedTestNumber(number, allowed) || !Phone.has(this, Manifest.permission.SEND_SMS)) return
        b.txtTestResult.text = getString(R.string.test_sending)
        try {
            Phone.send(this, prefs.simSubscriptionId, "diag-${UUID.randomUUID()}", number,
                number, "SIM SMS Gateway test from \"${prefs.gatewayName ?: "unpaired phone"}\" at ${DateFormat.getTimeInstance().format(Date())}. No reply needed.",
                SmsResultReceiver.KIND_DIAGNOSTIC)
        } catch (e: Exception) {
            b.txtTestResult.text = getString(R.string.test_exception, e.message ?: e.javaClass.simpleName)
        }
    }
}
