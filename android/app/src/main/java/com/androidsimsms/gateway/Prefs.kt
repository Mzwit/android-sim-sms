package com.androidsimsms.gateway

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Settings, plus the device token encrypted with a key that never leaves Android Keystore. */
class Prefs(context: Context) {
    private val sp: SharedPreferences = context.getSharedPreferences("gateway", Context.MODE_PRIVATE)

    var serverUrl: String?
        get() = sp.getString("server_url", null)
        set(v) = sp.edit().putString("server_url", v).apply()

    var certFingerprint: String?
        get() = sp.getString("cert_fp", null)
        set(v) = sp.edit().putString("cert_fp", v).apply()

    var gatewayId: String?
        get() = sp.getString("gateway_id", null)
        set(v) = sp.edit().putString("gateway_id", v).apply()

    var gatewayName: String?
        get() = sp.getString("gateway_name", null)
        set(v) = sp.edit().putString("gateway_name", v).apply()

    /** SubscriptionInfo.subscriptionId of the SIM used for sending; -1 = not chosen. */
    var simSubscriptionId: Int
        get() = sp.getInt("sim_sub_id", -1)
        set(v) = sp.edit().putInt("sim_sub_id", v).apply()

    var simIccTail: String?
        get() = sp.getString("sim_label", null)
        set(v) = sp.edit().putString("sim_label", v).apply()

    /** The user wants the gateway running (restored after reboot / crash). */
    var wantRunning: Boolean
        get() = sp.getBoolean("want_running", false)
        set(v) = sp.edit().putBoolean("want_running", v).apply()

    /** Local pause (does not change the server state). */
    var locallyPaused: Boolean
        get() = sp.getBoolean("local_paused", false)
        set(v) = sp.edit().putBoolean("local_paused", v).apply()

    /** Phone-side minimum interval between messages; the larger of this and the server's value wins. */
    var localMinIntervalMs: Long
        get() = sp.getLong("local_min_interval", 3_000L)
        set(v) = sp.edit().putLong("local_min_interval", v.coerceIn(1_000L, 600_000L)).apply()

    var lastConfigJson: String?
        get() = sp.getString("last_config", null)
        set(v) = sp.edit().putString("last_config", v).apply()

    var token: String?
        get() = sp.getString("token_enc", null)?.let { decrypt(it) }
        set(v) {
            if (v == null) sp.edit().remove("token_enc").apply() else sp.edit().putString("token_enc", encrypt(v)).apply()
        }

    val isPaired: Boolean get() = serverUrl != null && sp.contains("token_enc")

    fun unpair() {
        sp.edit().remove("token_enc").remove("gateway_id").remove("gateway_name").remove("last_config")
            .putBoolean("want_running", false).apply()
    }

    // ---- Keystore AES-GCM ----
    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    private fun encrypt(plain: String): String {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, key())
        val out = c.iv + c.doFinal(plain.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(out, Base64.NO_WRAP)
    }

    private fun decrypt(enc: String): String? = try {
        val raw = Base64.decode(enc, Base64.NO_WRAP)
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, raw.copyOfRange(0, 12)))
        String(c.doFinal(raw.copyOfRange(12, raw.size)), Charsets.UTF_8)
    } catch (e: Exception) {
        null
    }

    companion object {
        private const val KEY_ALIAS = "gateway_token_key"
    }
}
