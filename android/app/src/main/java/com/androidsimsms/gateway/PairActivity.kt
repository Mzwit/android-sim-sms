package com.androidsimsms.gateway

import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.androidsimsms.gateway.databinding.ActivityPairBinding
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

class PairActivity : AppCompatActivity() {
    private lateinit var b: ActivityPairBinding
    private lateinit var prefs: Prefs

    private val scan = registerForActivityResult(ScanContract()) { result ->
        val text = result.contents ?: return@registerForActivityResult
        val payload = try {
            val o = JSONObject(text)
            Protocol.parsePairingJson(text, { k -> if (o.isNull(k)) null else o.optString(k, null) }, { k -> if (o.has(k)) o.optInt(k) else null })
        } catch (e: Exception) {
            null
        }
        if (payload == null) {
            b.txtStatus.text = getString(R.string.qr_invalid)
            return@registerForActivityResult
        }
        b.editUrl.setText(payload.url)
        b.editCode.setText(payload.code)
        b.editFingerprint.setText(payload.fingerprint ?: "")
        pair()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        b = ActivityPairBinding.inflate(layoutInflater)
        setContentView(b.root)
        prefs = Prefs(this)
        supportActionBar?.setDisplayHomeAsUpEnabled(true)
        prefs.serverUrl?.let { b.editUrl.setText(it) }
        b.btnScan.setOnClickListener {
            scan.launch(ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE).setPrompt(getString(R.string.scan_prompt)).setBeepEnabled(false).setOrientationLocked(false))
        }
        b.btnPair.setOnClickListener { pair() }
    }

    override fun onSupportNavigateUp(): Boolean {
        finish()
        return true
    }

    private fun pair() {
        val url = b.editUrl.text.toString().trim().trimEnd('/')
        val code = Protocol.normaliseCode(b.editCode.text.toString())
        val fp = b.editFingerprint.text.toString().trim().lowercase().replace(":", "").ifBlank { null }
        if (!Protocol.isAllowedServerUrl(url, fp)) {
            b.txtStatus.text = getString(R.string.url_not_allowed)
            return
        }
        if (code == null) {
            b.txtStatus.text = getString(R.string.code_invalid)
            return
        }
        b.btnPair.isEnabled = false
        b.txtStatus.text = getString(R.string.pairing)
        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    Api(url, null, fp).pair(code, "${Build.MANUFACTURER} ${Build.MODEL}", Build.VERSION.RELEASE, BuildConfig.VERSION_NAME)
                }
            }
            b.btnPair.isEnabled = true
            result.onSuccess { r ->
                if (GatewayService.isRunning) GatewayService.command(this@PairActivity, GatewayService.ACTION_STOP)
                prefs.serverUrl = url
                prefs.certFingerprint = fp
                prefs.token = r.getString("token")
                val cfg = r.getJSONObject("config")
                prefs.gatewayId = cfg.getString("gateway_id")
                prefs.gatewayName = cfg.optString("name")
                prefs.lastConfigJson = cfg.toString()
                // A new pairing starts with the SIM choice reported again.
                if (prefs.simSubscriptionId >= 0) {
                    val sim = Phone.simFor(this@PairActivity, prefs.simSubscriptionId)
                    if (sim != null) withContext(Dispatchers.IO) {
                        runCatching { Api(url, prefs.token, fp).reportSim(sim.subscriptionId, sim.simSlotIndex, sim.displayName?.toString(), sim.carrierName?.toString()) }
                    }
                }
                Toast.makeText(this@PairActivity, getString(R.string.paired_ok, prefs.gatewayName), Toast.LENGTH_LONG).show()
                finish()
            }.onFailure { e ->
                b.txtStatus.text = when (e) {
                    is ApiException -> getString(R.string.pair_failed, e.message)
                    is javax.net.ssl.SSLException -> getString(R.string.pair_tls_failed, e.message)
                    else -> getString(R.string.pair_unreachable, e.message ?: e.javaClass.simpleName)
                }
            }
        }
    }
}
