package com.androidsimsms.gateway

import java.net.URI

/**
 * Pure logic shared by the app, kept free of Android classes so it is unit-tested on the JVM.
 */
object Protocol {

    data class PairingPayload(val url: String, val code: String, val fingerprint: String?)

    /** Parse the dashboard QR: {"v":1,"url":"https://…","code":"ABCDE12345","fp":"sha256hex or null"}. */
    fun parsePairingJson(json: String, getString: (String) -> String?, getInt: (String) -> Int?): PairingPayload? {
        if (getInt("v") != 1) return null
        val url = getString("url")?.trim()?.trimEnd('/') ?: return null
        val code = normaliseCode(getString("code") ?: return null) ?: return null
        val fp = getString("fp")?.lowercase()?.takeIf { it.matches(Regex("^[0-9a-f]{64}$")) }
        if (!isAllowedServerUrl(url, fp)) return null
        return PairingPayload(url, code, fp)
    }

    fun normaliseCode(code: String): String? {
        val c = code.uppercase().filter { it.isLetterOrDigit() }
        return if (c.length in 6..20) c else null
    }

    /**
     * HTTPS everywhere, except plain HTTP to this phone itself (USB mode via `adb reverse`).
     * A self-signed HTTPS server is only accepted with a pinned certificate fingerprint.
     */
    fun isAllowedServerUrl(url: String, fingerprint: String? = null): Boolean {
        val u = try { URI(url) } catch (e: Exception) { return false }
        val host = u.host ?: return false
        return when (u.scheme?.lowercase()) {
            "https" -> true
            "http" -> host == "127.0.0.1" || host == "localhost"
            else -> false
        } && (fingerprint == null || fingerprint.matches(Regex("^[0-9a-f]{64}$")))
    }

    /** Same rule as the server: the whole reply, or its first word, is a configured keyword. */
    fun isOptOut(body: String, keywords: List<String>): Boolean {
        val text = body.trim().uppercase().replace(Regex("[^A-Z ]"), "").replace(Regex("\\s+"), " ")
        if (text.isEmpty()) return false
        val first = text.substringBefore(' ')
        val set = keywords.map { it.trim().uppercase() }.toSet()
        return text in set || first in set
    }

    /** True when [number] (as Android reports it) is one of the authorised test numbers (E.164). */
    fun isAuthorisedTestNumber(number: String, allowed: List<String>): Boolean {
        val digits = number.filter { it.isDigit() }
        return allowed.any { it.filter { c -> c.isDigit() } == digits }
    }

    /**
     * Local lease deadline in elapsedRealtime milliseconds. We subtract a safety margin so the
     * phone stops trying to confirm well before the server would refuse.
     */
    fun leaseDeadline(nowElapsed: Long, leaseSeconds: Int): Long =
        nowElapsed + (leaseSeconds * 1000L * 0.9).toLong() - 5_000L

    /** Exponential backoff for talking to the server: 2s, 4s, 8s … capped at 60s. */
    fun backoffMs(failures: Int): Long = (2_000L shl (failures.coerceIn(0, 5))).coerceAtMost(60_000L)

    /** TP-Status classification identical to the server's. */
    fun deliveryStatus(tp: Int): String = when {
        tp < 0 || tp > 255 -> "FAILED"
        tp <= 0x1f -> "DELIVERED"
        tp <= 0x3f -> "PENDING"
        else -> "FAILED"
    }
}
