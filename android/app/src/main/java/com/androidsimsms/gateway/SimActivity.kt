package com.androidsimsms.gateway

import android.Manifest
import android.os.Bundle
import android.widget.RadioButton
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.androidsimsms.gateway.databinding.ActivitySimBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Choose which physical SIM sends (dual-SIM phones). */
class SimActivity : AppCompatActivity() {
    private lateinit var b: ActivitySimBinding
    private lateinit var prefs: Prefs
    private val ask = registerForActivityResult(ActivityResultContracts.RequestPermission()) { load() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        b = ActivitySimBinding.inflate(layoutInflater)
        setContentView(b.root)
        prefs = Prefs(this)
        supportActionBar?.setDisplayHomeAsUpEnabled(true)
        b.btnSave.setOnClickListener { save() }
        if (!Phone.has(this, Manifest.permission.READ_PHONE_STATE)) ask.launch(Manifest.permission.READ_PHONE_STATE) else load()
    }

    override fun onSupportNavigateUp(): Boolean {
        finish()
        return true
    }

    private fun load() {
        b.radioSims.removeAllViews()
        val sims = Phone.activeSims(this)
        if (!Phone.hasTelephony(this)) {
            b.txtInfo.text = getString(R.string.no_telephony)
            return
        }
        if (sims.isEmpty()) {
            b.txtInfo.text = getString(if (Phone.has(this, Manifest.permission.READ_PHONE_STATE)) R.string.no_sims else R.string.need_phone_permission)
            b.btnSave.isEnabled = false
            return
        }
        b.txtInfo.text = getString(R.string.sim_choose_info)
        sims.forEach { s ->
            val rb = RadioButton(this).apply {
                id = s.subscriptionId + 1000
                text = getString(R.string.sim_row, s.simSlotIndex + 1, s.displayName, s.carrierName)
                isChecked = s.subscriptionId == prefs.simSubscriptionId || sims.size == 1
                tag = s.subscriptionId
            }
            b.radioSims.addView(rb)
        }
        b.btnSave.isEnabled = true
    }

    private fun save() {
        val rb = findViewById<RadioButton>(b.radioSims.checkedRadioButtonId) ?: return
        val subId = rb.tag as Int
        val sim = Phone.simFor(this, subId) ?: return
        prefs.simSubscriptionId = subId
        lifecycleScope.launch {
            if (prefs.isPaired) withContext(Dispatchers.IO) {
                runCatching { Api(prefs.serverUrl!!, prefs.token, prefs.certFingerprint).reportSim(subId, sim.simSlotIndex, sim.displayName?.toString(), sim.carrierName?.toString()) }
            }
            GatewayService.poke(this@SimActivity)
            finish()
        }
    }
}
