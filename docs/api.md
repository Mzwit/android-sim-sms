# API guide

- **Base URL:** `http://localhost:8443/api/v1`. This becomes `https://` once TLS is set up in Phase 3.
- **Interactive docs:** `http://localhost:8443/docs`, generated from the same schemas that validate requests. A static copy is in `docs/openapi.json` (regenerate it with `npm run openapi` from `backend/`).

## Authentication

1. `POST /auth/login` with `{ "email", "password" }`. The response sets an **HttpOnly, SameSite=Strict** cookie (`smsgw_session`) and also returns a `token`.
2. Browser (dashboard) requests use the cookie. **Every cookie-authenticated write must send the header `x-smsgw-csrf: 1`.** Cross-site forms cannot set custom headers, which blocks CSRF.
3. Scripts can send `Authorization: Bearer <token>` instead. No CSRF header is needed.
4. A new or reset account has `must_change_password: true`. Until `POST /auth/change-password` succeeds, every other endpoint returns `403 PASSWORD_CHANGE_REQUIRED`.

Sessions expire after `SESSION_TTL_HOURS` without activity (default 12).

**Login protections:**
- 10 attempts per minute per IP.
- Lockout for 15 minutes after 5 consecutive failures.
- The same error for an unknown email and a wrong password.

## Errors

Every error has the same shape:

```json
{ "error": { "code": "DUPLICATE_PHONE", "message": "A contact with this phone number already exists",
             "details": { "existing_contact_id": "1b6d…" } } }
```

| HTTP | Typical codes |
|---|---|
| 400 | `VALIDATION_FAILED`, `IDEMPOTENCY_KEY_REQUIRED`, `UNKNOWN_GROUP`, `INVALID_WINDOW`, `WEAK_PASSWORD` |
| 401 | `UNAUTHENTICATED`, `INVALID_CREDENTIALS` |
| 403 | `FORBIDDEN`, `CSRF_HEADER_MISSING`, `PASSWORD_CHANGE_REQUIRED` |
| 404 | `NOT_FOUND` |
| 409 | `DUPLICATE_PHONE`, `NOT_DRAFT`, `GROUP_EXISTS`, `EMAIL_TAKEN` |
| 422 | `INVALID_PHONE`, `INVALID_TEMPLATE`, `MESSAGE_TOO_LONG`, `IDEMPOTENCY_KEY_REUSED`, `OVER_RECIPIENT_CAP` |
| 423 | `ACCOUNT_LOCKED` |
| 429 | `RATE_LIMITED` |

## Idempotency

`POST /campaigns` requires an `Idempotency-Key` header (8–128 characters, for example a UUID). Keys are scoped per administrator.

- **Same key, same body:** returns the original response with header `Idempotent-Replayed: true`. No second campaign is created, even when 10 identical requests arrive at once (this is tested).
- **Same key, different body:** returns `422 IDEMPOTENCY_KEY_REUSED`.

The dashboard generates one key per "Create campaign" form, so a double-click or network retry is harmless.

## Administrator endpoints

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/auth/login` | none | |
| POST | `/auth/logout` | signed in | Revokes the current session. |
| GET | `/auth/me` | signed in | Role and permissions. |
| POST | `/auth/change-password` | signed in | Revokes your other sessions. |
| GET | `/roles` | signed in | |
| GET, POST | `/admins` | admins.manage | POST returns a one-time temporary password. |
| PATCH | `/admins/:id` | admins.manage | Cannot remove the last active super admin, or yourself. |
| POST | `/admins/:id/reset-password` | admins.manage | |
| GET | `/contacts` | contacts.read | `q, group_id, tag, valid, opted_out, consent, sort, page, page_size` |
| POST | `/contacts` | contacts.write | Normalises the phone to E.164. Optional `group_ids` and `consent`. |
| GET, PATCH | `/contacts/:id` | contacts.read / write | GET includes the consent history. |
| DELETE | `/contacts/:id` | contacts.delete | Soft delete. Suppressions stay. |
| POST | `/contacts/bulk-update` | contacts.write | Add or remove tags and groups for up to 10,000 contacts. |
| POST | `/contacts/:id/consent` | consent.write | GRANTED or WITHDRAWN, per purpose. |
| GET, POST, PATCH, DELETE | `/groups`, `/groups/:id` | contacts.read / groups.write | |
| POST, DELETE | `/groups/:id/members` | groups.write | |
| POST | `/opt-outs` | consent.write | Immediate. Cancels QUEUED messages to the number. |
| GET, POST | `/suppressions` | contacts.read / consent.write | |
| POST | `/suppressions/:id/lift` | consent.write | Needs a justification of at least 10 characters. |
| POST | `/campaigns` | campaigns.write | Idempotency-Key required. Creates a DRAFT. |
| GET | `/campaigns`, `/campaigns/:id` | campaigns.read | Includes template analysis and message counts. |
| PATCH, DELETE | `/campaigns/:id` | campaigns.write | DRAFT only. |
| POST | `/campaigns/:id/preview` | campaigns.read | Dry run: exclusions, samples, segments, cost, warnings. |
| GET | `/audit-logs` | audit.read | Filters: `action` (exact or prefix ending in `.`), `actor_id`, `entity_type`, `entity_id`, `from`, `to`. |
| GET | `/settings` | signed in | |
| PUT | `/settings/:key` | settings.write | Validated per key. |
| POST | `/kill-switch` | settings.write | `{ enabled, reason }` |
| POST | `/tools/sms-analyze` | signed in | Encoding, segments, characters that force Unicode. |
| POST | `/tools/phone-check` | signed in | Normalise up to 100 numbers without saving them. |

| POST | `/contacts/import` | contacts.write | Multipart `file` (.csv/.xlsx), optional `country`. Stages and validates every row; returns a summary and the problem rows. |
| GET | `/contacts/imports/:id`, `/contacts/imports/:id/problems.csv` | contacts.read | |
| POST | `/contacts/imports/:id/commit`, `/discard` | contacts.write | `on_existing` skip/update, `group_ids`, `add_tags`, `store_invalid`, `default_consent`. |
| GET | `/contacts/import/template.csv` | signed in | |
| GET | `/contacts/export.csv` | contacts.export | Streamed. Masked numbers unless contacts.read_full. Audited. |
| POST | `/contacts/:id/erase` | contacts.delete | Data-protection erasure (opt-out kept). |
| GET | `/contacts/:id/messages` | campaigns.read | Per-recipient history. |
| POST | `/campaigns/:id/test` | campaigns.write | `{ phone }`: must be an authorised test number. |
| POST | `/campaigns/:id/submit` | campaigns.write | DRAFT → PENDING_APPROVAL. |
| POST | `/campaigns/:id/return-to-draft` | campaigns.approve | `{ note }` |
| POST | `/campaigns/:id/approve` | campaigns.approve | `{ confirm_name }`. Re-checks everything, freezes recipients, queues messages. |
| POST | `/campaigns/:id/start` · `/pause` · `/resume` · `/cancel` | campaigns.operate | pause/cancel take `{ reason }`. |
| GET | `/campaigns/:id/progress` | campaigns.read | Counts, measured rate, ETA (estimate). |
| GET | `/campaigns/:id/report`, `/report.csv` | campaigns.read / reports.export | |
| POST | `/campaigns/:id/retry-failed` | messages.retry | One more attempt for dead letters. |
| GET | `/messages`, `/messages/:id` | campaigns.read | Filters: `status`, `campaign_id`, `dead_letter`, `is_test`, `phone`, `contact_id`. Detail has attempts, part results, delivery reports, retries, reconciliations. |
| POST | `/messages/:id/retry` | messages.retry | FAILED only. `{ note, force? }` |
| POST | `/messages/:id/reconcile` | messages.retry | UNKNOWN only. `{ decision: CONFIRMED_SENT \| CONFIRMED_NOT_SENT \| RESEND \| ABANDON, note }` |
| GET | `/gateways`, `/gateways/:id/health` | gateways.read | |
| POST | `/gateways/pairing-codes` | gateways.manage | `{ label }` → code, QR (PNG data URL), payload. |
| PATCH | `/gateways/:id` | gateways.manage | `name`, `send_interval_ms`, `batch_limit`. |
| POST | `/gateways/:id/pause` · `/resume` | campaigns.operate | `{ reason }` |
| POST | `/gateways/:id/emergency-stop` · `/revoke` | gateways.manage | `{ reason }` |
| GET | `/dashboard/summary` | signed in | |
| GET | `/alerts`, POST `/alerts/:id/ack` | signed in | |
| POST | `/maintenance/retention` | settings.write | `{ dry_run }` |

## Phone (gateway) protocol

The Android app authenticates with `Authorization: Gateway <device token>`. Admin sessions are never accepted here, and gateway tokens never work on admin routes.

| Call | Purpose |
|---|---|
| `POST /gateway/pair` `{ code, device_model, android_version, app_version }` | Exchange a one-time code for a device token and configuration. |
| `POST /gateway/heartbeat` `{ battery_pct, signal_level, network_type, sim_state, permissions, kind, … }` | Health in; configuration and commands out (`paused`, `emergency_stop`, `kill_switch`, `send_interval_ms`, `batch_limit`, `test_numbers`, `opt_out_keywords`). |
| `POST /gateway/sim` `{ subscription_id, slot_index, display_name, carrier_name }` | Report the SIM chosen for sending. |
| `POST /gateway/lease` `{ max }` | Receive jobs `{ attempt_id, message_id, phone, body, segments, lease_expires_at }`, or `idle_reason` + `next_poll_ms`. |
| `POST /gateway/attempts/:attempt_id/confirm` | Ask permission immediately before sending: `{ decision: "SEND" }` or `{ decision: "DO_NOT_SEND", reason }`. **The phone never sends without SEND.** |
| `POST /gateway/events` `{ events: [...] }` | Batched, idempotent reports (each event has a unique `id`). |
| `POST /gateway/release` `{ attempt_ids, reason }` | Hand back jobs that will not be sent. |

Event types:

| type | Fields | Meaning |
|---|---|---|
| `PART_SENT` | `attempt_id, part_index, parts_total, result_code` | sentIntent result for one part (`-1` = RESULT_OK). |
| `DELIVERY` | `attempt_id, part_index, tp_status` | Delivery report (TP-Status 0x00–0x1F delivered, 0x20–0x3F pending, ≥0x40 failed). |
| `SEND_ERROR` | `attempt_id, app_code, detail?` | Failed before reaching the radio (PERMISSION_DENIED, SIM_NOT_READY, SIM_CHANGED, SEND_EXCEPTION, INVALID_NUMBER_LOCAL). |
| `SUBMIT_UNKNOWN` | `attempt_id, app_code` | Handed to Android but no result (SENT_TIMEOUT, PROCESS_KILLED). The message becomes UNKNOWN. |
| `NOT_SENT` | `attempt_id, reason` | Certainly not sent. Requeued without using an attempt. |
| `INBOUND` | `from, body` | Only sent for replies matching an opt-out keyword. |
| `DIAGNOSTIC_SMS` | `to, result_code` | Result of a test SMS from the app's Diagnostics screen. |

The server classifies Android result codes (see `backend/src/lib/sms-errors.ts`):
- **Transient** codes (e.g. `GENERIC_FAILURE`, `NO_SERVICE`) are retried with exponential backoff and jitter.
- **Permanent** codes (e.g. `NETWORK_REJECT`, `FDN_CHECK_FAILURE`) are never retried automatically.
- **Phone-level** codes (`LIMIT_EXCEEDED`, `RADIO_OFF`, missing permission, SIM problems) pause the phone and return the message to the queue without spending one of its attempts.

## Examples (PowerShell)

```powershell
$base = 'http://localhost:8443/api/v1'
$login = Invoke-RestMethod "$base/auth/login" -Method Post -ContentType 'application/json' `
  -Body (@{ email = 'you@example.org'; password = 'your-password' } | ConvertTo-Json)
$h = @{ Authorization = "Bearer $($login.token)" }

# Create a contact with consent
Invoke-RestMethod "$base/contacts" -Method Post -Headers $h -ContentType 'application/json' -Body (@{
  phone = '7612 3456'; first_name = 'Thandeka'; last_name = 'Dlamini'
  consent = @{ source = 'Student registration form 2026'; evidence = 'FORM-0042' }
} | ConvertTo-Json)
```

Response `201`:

```json
{ "id": "5f0c…", "phone_e164": "+26876123456", "is_valid": true, "first_name": "Thandeka",
  "last_name": "Dlamini", "consent_general": "GRANTED", "opted_out": false, "group_ids": [],
  "phone_masked": false, "created_at": "2026-10-24T18:51:43.190Z" }
```

```powershell
# Create a draft campaign (idempotent)
$c = Invoke-RestMethod "$base/campaigns" -Method Post -Headers ($h + @{ 'Idempotency-Key' = [guid]::NewGuid() }) `
  -ContentType 'application/json' -Body (@{
    name = 'Exam timetable'; group_ids = @('<group-id>'); cost_per_segment = 0.45
    body_template = 'Sawubona {{first_name|Student}}, exams start Monday 08:00. Reply STOP to opt out.'
    schedule = @{ window_start = '08:00'; window_end = '17:00'; days_of_week = @(1,2,3,4,5) }
  } | ConvertTo-Json -Depth 5)

# Dry-run checks
Invoke-RestMethod "$base/campaigns/$($c.id)/preview" -Method Post -Headers $h -ContentType 'application/json' -Body '{"sample_size":3}'
```

Preview response for the 6,000-contact demo data:

```json
{
  "summary": { "candidates": 6000, "included": 5280,
    "excluded": { "INVALID_NUMBER": 150, "SUPPRESSED": 210, "NO_CONSENT": 360, "DUPLICATE_NUMBER": 0, "OVER_LIMIT": 0 },
    "segmentsTotal": 5280, "maxSegmentsPerMessage": 1, "encodings": { "GSM7": 5280, "UCS2": 0 } },
  "estimated_cost": { "amount": 2376, "currency": "SZL", "note": "Estimate from configured cost per segment; …" },
  "samples": [ { "phone": "+2687*****64", "text": "Sawubona Nokuthula, your reference is REF-03465. Reply STOP to opt out.", "segments": 1 } ],
  "warnings": [ "Needs 5280 segments; the daily budget of 2000 means it will span at least 3 days.",
                "360 contact(s) excluded for missing consent." ]
}
```

```powershell
# Opt a number out (cancels anything still queued to it)
Invoke-RestMethod "$base/opt-outs" -Method Post -Headers $h -ContentType 'application/json' `
  -Body '{"phone":"+268 7611 2233","source":"Phoned reception"}'
# -> { "suppression_id": "…", "already_suppressed": false, "cancelled_messages": 2 }
```

## Personalisation fields

`{{first_name}}`, `{{last_name}}`, `{{full_name}}`, `{{reference_no}}`, each with an optional fallback: `{{first_name|Member}}`. Any other field name is rejected when the campaign is saved. Contact data is inserted literally, never interpreted as template syntax.
