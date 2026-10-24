package com.androidsimsms.gateway

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ProtocolTest {
    private fun parse(json: String): Protocol.PairingPayload? {
        val o = JSONObject(json)
        return Protocol.parsePairingJson(json, { k -> if (!o.has(k) || o.isNull(k)) null else o.getString(k) }, { k -> if (o.has(k)) o.getInt(k) else null })
    }

    @Test fun parsesDashboardQr() {
        val p = parse("""{"v":1,"url":"https://smsgw.onrender.com/","code":"abcde-23456","fp":null}""")
        assertNotNull(p)
        assertEquals("https://smsgw.onrender.com", p!!.url)
        assertEquals("ABCDE23456", p.code)
        assertNull(p.fingerprint)
    }

    @Test fun rejectsPlainHttpExceptLocalhost() {
        assertNull(parse("""{"v":1,"url":"http://192.168.1.20:8443","code":"ABCDE23456"}"""))
        assertNotNull(parse("""{"v":1,"url":"http://127.0.0.1:8443","code":"ABCDE23456"}"""))
        assertFalse(Protocol.isAllowedServerUrl("ftp://x"))
        assertFalse(Protocol.isAllowedServerUrl("not a url"))
    }

    @Test fun rejectsWrongVersionAndBadFingerprint() {
        assertNull(parse("""{"v":2,"url":"https://x.org","code":"ABCDE23456"}"""))
        val p = parse("""{"v":1,"url":"https://192.168.1.20:8443","code":"ABCDE23456","fp":"${"a".repeat(64)}"}""")
        assertEquals("a".repeat(64), p!!.fingerprint)
        assertNull(parse("""{"v":1,"url":"https://x.org","code":"ABC"}"""))
    }

    @Test fun optOutKeywordsMatchServerRules() {
        val k = listOf("STOP", "UNSUBSCRIBE", "OPT OUT")
        assertTrue(Protocol.isOptOut(" stop ", k))
        assertTrue(Protocol.isOptOut("Stop please", k))
        assertTrue(Protocol.isOptOut("opt out", k))
        assertTrue(Protocol.isOptOut("STOP!", k))
        assertFalse(Protocol.isOptOut("Please don't stop", k))
        assertFalse(Protocol.isOptOut("", k))
    }

    @Test fun testNumbersCompareDigits() {
        assertTrue(Protocol.isAuthorisedTestNumber("+268 7612 3456", listOf("+26876123456")))
        assertFalse(Protocol.isAuthorisedTestNumber("+26876123457", listOf("+26876123456")))
    }

    @Test fun leaseDeadlineLeavesMargin() {
        assertEquals(1_000L + 270_000L - 5_000L, Protocol.leaseDeadline(1_000L, 300))
    }

    @Test fun backoffCaps() {
        assertEquals(2_000L, Protocol.backoffMs(0))
        assertEquals(4_000L, Protocol.backoffMs(1))
        assertEquals(60_000L, Protocol.backoffMs(10))
    }

    @Test fun deliveryStatusMatchesServer() {
        assertEquals("DELIVERED", Protocol.deliveryStatus(0))
        assertEquals("PENDING", Protocol.deliveryStatus(0x20))
        assertEquals("FAILED", Protocol.deliveryStatus(0x41))
    }
}
