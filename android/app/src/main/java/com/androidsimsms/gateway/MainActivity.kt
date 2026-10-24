package com.androidsimsms.gateway

import android.content.Intent
import android.os.Bundle
import android.text.format.DateUtils
import android.view.View
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.androidsimsms.gateway.databinding.ActivityMainBinding
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import kotlinx.coroutines.launch

class MainActivity : AppCompatActivity() {
    private lateinit var b: ActivityMainBinding
    private lateinit var prefs: Prefs

    private val permissionLauncher = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { refresh() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        b = ActivityMainBinding.inflate(layoutInflater)
        setContentView(b.root)
        prefs = Prefs(this)

        b.btnPair.setOnClickListener { startActivity(Intent(this, PairActivity::class.java)) }
        b.btnSim.setOnClickListener { startActivity(Intent(this, SimActivity::class.java)) }
        b.btnDiagnostics.setOnClickListener { startActivity(Intent(this, DiagnosticsActivity::class.java)) }
        b.btnPermissions.setOnClickListener { permissionLauncher.launch(Phone.REQUIRED_PERMISSIONS.toTypedArray()) }
        b.btnStart.setOnClickListener { start() }
        b.btnPause.setOnClickListener {
            val pause = !prefs.locallyPaused
            prefs.locallyPaused = pause
            GatewayService.command(this, if (pause) GatewayService.ACTION_PAUSE else GatewayService.ACTION_RESUME)
            refresh()
        }
        b.btnStop.setOnClickListener { GatewayService.command(this, GatewayService.ACTION_STOP) }
        b.btnEmergency.setOnClickListener {
            MaterialAlertDialogBuilder(this)
                .setTitle(R.string.emergency_title)
                .setMessage(R.string.emergency_message)
                .setPositiveButton(R.string.emergency_confirm) { _, _ -> GatewayService.command(this, GatewayService.ACTION_EMERGENCY) }
                .setNegativeButton(android.R.string.cancel, null)
                .show()
        }

        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                GatewayState.state.collect { render(it) }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    private fun start() {
        val missing = Phone.REQUIRED_PERMISSIONS.filterNot { Phone.has(this, it) }
        if (missing.isNotEmpty()) {
            permissionLauncher.launch(missing.toTypedArray())
            return
        }
        if (prefs.simSubscriptionId < 0) {
            startActivity(Intent(this, SimActivity::class.java))
            return
        }
        prefs.locallyPaused = false
        GatewayService.command(this, GatewayService.ACTION_START)
    }

    private fun refresh() {
        val paired = prefs.isPaired
        b.txtServer.text = if (paired) getString(R.string.paired_with, prefs.gatewayName ?: "", prefs.serverUrl) else getString(R.string.not_paired)
        b.btnPair.text = getString(if (paired) R.string.pair_again else R.string.pair)
        val sim = Phone.simFor(this, prefs.simSubscriptionId)
        b.txtSim.text = when {
            prefs.simSubscriptionId < 0 -> getString(R.string.sim_not_selected)
            sim == null -> getString(R.string.sim_missing)
            else -> getString(R.string.sim_selected, sim.simSlotIndex + 1, sim.displayName, sim.carrierName)
        }
        val missing = Phone.REQUIRED_PERMISSIONS.filterNot { Phone.has(this, it) }
        b.txtPermissions.text = if (missing.isEmpty()) getString(R.string.permissions_ok)
        else getString(R.string.permissions_missing, missing.joinToString { it.substringAfterLast('.') })
        b.btnPermissions.visibility = if (missing.isEmpty()) View.GONE else View.VISIBLE
        b.txtBattery.visibility = if (Phone.isIgnoringBatteryOptimizations(this)) View.GONE else View.VISIBLE
        b.btnStart.isEnabled = paired
        b.btnSim.isEnabled = true
        b.btnPause.text = getString(if (prefs.locallyPaused) R.string.resume else R.string.pause)
        render(GatewayState.state.value)
    }

    private fun render(s: GatewayState.Snapshot) {
        b.txtPhase.text = s.phase
        b.txtConnection.text = when {
            !s.running -> getString(R.string.service_stopped)
            s.connected -> getString(R.string.connected_ago, DateUtils.getRelativeTimeSpanString(s.lastContactAt))
            else -> getString(R.string.disconnected)
        }
        b.txtCounts.text = getString(R.string.counts, s.sentThisSession, s.failedThisSession, s.pendingLocal, s.outbox)
        b.txtInterval.text = if (s.sendIntervalMs > 0) getString(R.string.interval, s.sendIntervalMs / 1000.0) else ""
        b.txtError.text = s.lastError ?: ""
        b.txtError.visibility = if (s.lastError.isNullOrBlank()) View.GONE else View.VISIBLE
        b.btnStart.visibility = if (s.running) View.GONE else View.VISIBLE
        b.groupRunning.visibility = if (s.running) View.VISIBLE else View.GONE
        b.statusDot.setBackgroundResource(
            when {
                !s.running -> R.drawable.dot_grey
                s.killSwitch || s.emergency || !s.connected -> R.drawable.dot_red
                s.serverPaused || prefs.locallyPaused -> R.drawable.dot_amber
                else -> R.drawable.dot_green
            },
        )
    }
}
