package com.androidsimsms.gateway

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

class ApiException(val status: Int, val code: String, message: String) : IOException(message)

/**
 * Talks to the gateway server. All calls are outbound from the phone.
 * With a pinned fingerprint (self-hosted HTTPS with a self-signed certificate), only that
 * exact certificate is trusted; otherwise the normal Android trust store is used.
 */
class Api(private val baseUrl: String, private val token: String?, pinnedSha256: String? = null) {

    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .retryOnConnectionFailure(false) // never silently repeat a confirm
        .apply {
            if (pinnedSha256 != null) {
                val tm = PinnedTrustManager(pinnedSha256)
                val ctx = SSLContext.getInstance("TLS").apply { init(null, arrayOf<TrustManager>(tm), null) }
                sslSocketFactory(ctx.socketFactory, tm)
                // The pin authenticates the server; the certificate may be issued for an IP address.
                hostnameVerifier { _, _ -> true }
            }
        }
        .build()

    private val json = "application/json; charset=utf-8".toMediaType()

    private fun call(method: String, path: String, body: JSONObject? = null): JSONObject {
        val req = Request.Builder().url(baseUrl.trimEnd('/') + path)
            .header("User-Agent", "SimSmsGateway/${BuildConfig.VERSION_NAME}")
            .apply { token?.let { header("Authorization", "Gateway $it") } }
            .method(method, if (method == "GET") null else (body ?: JSONObject()).toString().toRequestBody(json))
            .build()
        client.newCall(req).execute().use { res ->
            val text = res.body?.string().orEmpty()
            val obj = try { if (text.isBlank()) JSONObject() else JSONObject(text) } catch (e: Exception) { JSONObject() }
            if (!res.isSuccessful) {
                val err = obj.optJSONObject("error")
                throw ApiException(res.code, err?.optString("code") ?: "HTTP_${res.code}", err?.optString("message") ?: "HTTP ${res.code}")
            }
            return obj
        }
    }

    fun pair(code: String, model: String, androidVersion: String, appVersion: String): JSONObject =
        call("POST", "/api/v1/gateway/pair", JSONObject().put("code", code).put("device_model", model).put("android_version", androidVersion).put("app_version", appVersion))

    fun heartbeat(health: JSONObject): JSONObject = call("POST", "/api/v1/gateway/heartbeat", health)

    fun reportSim(subId: Int, slot: Int, displayName: String?, carrier: String?): JSONObject =
        call("POST", "/api/v1/gateway/sim", JSONObject().put("subscription_id", subId).put("slot_index", slot).put("display_name", displayName ?: JSONObject.NULL).put("carrier_name", carrier ?: JSONObject.NULL))

    fun lease(max: Int): JSONObject = call("POST", "/api/v1/gateway/lease", JSONObject().put("max", max))

    /** Returns true only for an explicit SEND decision. */
    fun confirm(attemptId: String): Pair<Boolean, String?> {
        val r = call("POST", "/api/v1/gateway/attempts/$attemptId/confirm")
        return Pair(r.optString("decision") == "SEND", r.optString("reason", null))
    }

    fun events(events: JSONArray): JSONArray = call("POST", "/api/v1/gateway/events", JSONObject().put("events", events)).optJSONArray("acks") ?: JSONArray()

    fun release(attemptIds: List<String>, reason: String): JSONObject =
        call("POST", "/api/v1/gateway/release", JSONObject().put("attempt_ids", JSONArray(attemptIds)).put("reason", reason))

    fun config(): JSONObject = call("GET", "/api/v1/gateway/config")
}

private class PinnedTrustManager(private val pin: String) : X509TrustManager {
    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = throw CertificateException("client auth not supported")
    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        val leaf = chain?.firstOrNull() ?: throw CertificateException("no certificate")
        val fp = MessageDigest.getInstance("SHA-256").digest(leaf.encoded).joinToString("") { "%02x".format(it) }
        if (!fp.equals(pin, ignoreCase = true)) throw CertificateException("server certificate does not match the paired fingerprint")
        leaf.checkValidity()
    }
    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
}
