# Architecture and feasibility (Phase 1)

## Verdict

Sending 6,000+ consent-based SMS through one physical SIM on one Android phone is **technically feasible but slow, and carries operational risk**. The limits come from the handset OS and the carrier, not from this software.

### 1. Android's outgoing-SMS limit

- `SmsUsageMonitor` caps how many SMS one app may send in a rolling window. AOSP defaults to about 30 messages per 30 minutes.
- Above that cap, Android shows a confirmation dialog on the phone, and sending stalls until someone taps it.
- On many devices the phone's owner can raise the limit with ADB, a documented developer setting on their own device:
  ```
  adb shell settings put global sms_outgoing_check_max_count 1000
  adb shell settings put global sms_outgoing_check_interval_ms 60000
  ```
- Some manufacturer builds ignore these values or add their own limits.
- The gateway detects a stall (no `sentIntent` callback within a timeout) and reports it. It never assumes the messages went out.

### 2. Carrier fair-use terms

- Consumer SIMs on MTN Eswatini or Eswatini Mobile are priced and policed for person-to-person use.
- Sustained high volume from one SIM is the classic pattern that leads to throttling, silent drops or suspension.
- **Get the carrier's written confirmation or a suitable bundle before production.**
- The system auto-pauses on failure spikes and on the kill switch. It does not try to evade carrier limits.

### 3. Throughput

Planning numbers only, to be replaced with measured values from the pilot:

| Pacing | 6,000 single-segment SMS |
|---|---|
| 1 every 3 s (aggressive, high block risk) | ~5 h |
| 1 every 6 s (default `send_interval_ms`) | ~10 h |
| ~100 per hour (conservative) | ~60 h, spread over several days within sending windows |

### 4. Segments drive cost

| Encoding | Single SMS | Per part when multipart |
|---|---|---|
| GSM-7 | 160 characters | 153 |
| UCS-2 | 70 characters | 67 |

One emoji or curly quote switches the whole message to UCS-2. The composer and `/tools/sms-analyze` name the exact characters responsible.

### Recommendation

Build the system as specified, behind a **pluggable `SmsTransport` interface**. The Android SIM gateway is the first implementation. A licensed A2P bulk-SMS provider can be added later without touching contacts, campaigns or reports. That gives the institution an upgrade path if the carrier objects.

## System diagram

```
┌──────────────────────────── PC (Docker Compose) ───────────────────────────┐
│  Browser ──HTTPS──► Web dashboard (React + TS, served by backend)          │
│                         │                                                  │
│                    Fastify API (TypeScript)                                │
│        auth · RBAC · contacts · campaigns · reports · audit · opt-out      │
│                         │                                                  │
│      Dispatcher ── PostgreSQL (data + durable queue via SKIP LOCKED)       │
│          │                                                                 │
│   Gateway API (TLS, device token)  ◄───── outbound connection ──────┐      │
└──────────────────────────────────────────────────────────────────────┼─────┘
                                                                      │ LAN Wi-Fi (Mode A)
                                                                      │ or USB via `adb reverse` (Mode B)
┌──────────────────────────── Android phone ───────────────────────────┴─────┐
│  Foreground service ── Room DB (local job journal)                         │
│    pulls leased jobs → SmsManager(subId).sendMultipartTextMessage          │
│    sentIntent  → SUBMITTED / FAILED(code)                                  │
│    deliveryIntent → DELIVERED / FAILED (only if carrier returns a report)  │
│    pushes callbacks + health (battery, signal, SIM, queue) back to PC      │
└────────────────────────────────────────────────────────────────────────────┘
```

## Key design decisions

- **The phone connects out to the PC; the PC never calls the phone.** The phone exposes no listening SMS endpoint, so there is nothing on the network that could be abused to send SMS.
- **Pairing by QR code.**
  - The QR holds a one-time code (stored hashed, short expiry) and the PC certificate's SHA-256 fingerprint.
  - The phone pins that certificate, which gives real TLS on a LAN with no public CA.
  - The phone then receives a device token, stored in Android Keystore. Only the token's hash is stored on the PC.
- **Leases, not pushes.**
  - The phone asks for a small batch (`batch_limit`, default 20) under a time-limited lease and journals it in Room **before** sending.
  - If the PC disappears, the phone finishes the leased batch and reports back on reconnect.
  - If the phone disappears, the leases expire and those messages are reconciled.
- **PostgreSQL is the queue** (`SELECT … FOR UPDATE SKIP LOCKED`). At thousands of messages a day, Redis/BullMQ would add a moving part with no benefit.

## The never-double-send rule

`QUEUED → LEASED → SENDING → SUBMITTED → DELIVERED`, with exits to `FAILED`, `UNKNOWN` and `CANCELLED`.

- The phone records `SENDING` in its journal **before** calling `SmsManager`.
  - If the app dies between that write and the `sentIntent` callback, no one can know whether the SMS left.
  - That message becomes **UNKNOWN** and is never retried automatically.
  - An administrator reconciles it: confirmed sent, confirmed not sent, resend (accepting the duplicate risk), or abandon.
- **Multipart messages:** `SUBMITTED` only when every part reports `RESULT_OK`.
- **Retries:** only for transient errors (`NO_SERVICE`, `RADIO_OFF`, `GENERIC_FAILURE`), with exponential backoff, jitter and a cap. Never for invalid numbers, opted-out recipients or permanent rejections.
- **Three separate records:** the request (`messages`), what the handset said (`sms_submission_attempts`), and what the network said (`delivery_reports`).
- **Delivery reports are best-effort.** Without one, a message stays `SUBMITTED – awaiting report`, then becomes `SUBMITTED – no report` after `delivery_report_timeout_hours`. It is never shown as delivered.
- **Exactly-once delivery is not claimed.** It cannot be guaranteed by any SIM-based gateway.

## Android platform constraints

| Concern | Approach |
|---|---|
| `SEND_SMS` permission | Fine for a sideloaded APK. Google Play rejects apps that are not the default SMS handler, so the app is distributed as a signed APK. |
| Dual SIM | `SubscriptionManager` lists SIMs (needs `READ_PHONE_STATE`). Sending uses `SmsManager.createForSubscriptionId(subId)`. |
| Long-running work | Android 14+ requires a foreground service type. `dataSync` is capped at 6 h per day on Android 15, so the app uses `specialUse` with a declared reason, plus a persistent notification. |
| Doze and OEM battery killers | Battery-optimisation exemption request, a manufacturer guide (Samsung, Xiaomi, Tecno, Infinix), a WorkManager watchdog and a `BOOT_COMPLETED` restart. |
| Emergency stop | A server-side kill switch checked before every lease, plus a local button that drops all unsent leases. |

## Mode B: USB

Plugging the phone in by USB **does not by itself let the PC send SMS**.

What does work is `adb reverse tcp:8443 tcp:8443`. The phone then reaches the PC backend over the cable, using exactly the same protocol as Wi-Fi.

| Capability | Through Android APIs | Needs USB debugging / ADB | Unsupported or unsuitable |
|---|---|---|---|
| Phone ↔ PC transport over cable | | `adb reverse` | |
| Sending SMS | `SmsManager` in the app (same as Wi-Fi) | | Driving the Messages app with ADB taps (fragile; not built) |
| Raising the OS send limit | | `settings put global …` | |
| Unattended production use | | | Replugging the cable or rebooting the PC drops the ADB link; a USB debugging prompt is required |

**Conclusion:** LAN (Mode A) is the standard deployment. USB (Mode B) is a fallback or demo mode, and Phase 3 documents it.

## Stack

| Part | Technologies |
|---|---|
| Android | Kotlin, minSdk 26, targetSdk 35, Room, WorkManager, OkHttp |
| Backend | Node.js 20+, Fastify 5, TypeScript, PostgreSQL 16 via `pg` with plain SQL migrations, TypeBox validation (also generates OpenAPI), argon2id (`@node-rs/argon2`), Vitest |
| Dashboard | React + Vite + TypeScript (Phase 4/6), served by the backend |
| Testing | A mock telephony layer runs the 6,000-recipient load test with no airtime. Real-device tests use only authorised test numbers. |

## Before production

1. Pilot 20–50 messages to authorised test numbers on the real phone and SIM. Measure throughput, failure codes and whether delivery reports arrive.
2. Get the carrier's position on volume in writing.
3. Set `daily_segment_budget`, the campaign budgets and the sending windows from the pilot results.
