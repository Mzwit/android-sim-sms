# Status report: Phases 3–7 complete

All seven phases from the original brief are implemented, tested and hosted on free resources.

| Phase | Scope | Where |
|---|---|---|
| 1 | Architecture, carrier constraints, feasibility | [architecture.md](architecture.md), [capacity.md](capacity.md) |
| 2 | Schema, API, authentication, tests | [database.md](database.md), [api.md](api.md), [phase-2-report.md](phase-2-report.md) |
| 3 | Android app: SIM selection, permissions, foreground service, QR pairing with certificate pinning, diagnostics and test SMS, pause / stop / emergency stop, USB mode | `android/` |
| 4 | Contact import (CSV/XLSX, preview) and export, campaign workflow (test, submit, typed-name approval, schedule, start/pause/resume/cancel), persistent PostgreSQL queue | `backend/src/services/importer.ts`, `campaign-lifecycle.ts`, `dispatch.ts` |
| 5 | Submission tracking per part, delivery reports, error classification, backoff retries, dead letters, UNKNOWN reconciliation, lease sweeper | `backend/src/services/dispatch.ts`, `backend/src/workers.ts` |
| 6 | Web dashboard, progress and estimated completion, reports (screen, print, CSV), alerts, retention purge, erasure, kill switch | `dashboard/`, `backend/src/routes/system.ts` |
| 7 | Simulated phone, 6,000-recipient fault-injection load test, backup/restore test, CI, deployment, troubleshooting and security guides | `backend/test/`, `.github/workflows/`, `docs/` |

## How it is built and hosted (all free)

- **Code:** private GitHub repository `Mzwit/android-sim-sms`.
- **Android APK:**
  - Built, unit-tested and signed by GitHub Actions on every change under `android/`.
  - Published as the release `latest-apk`.
- **Backend tests:** the full suite (including the load test and the backup/restore round-trip) runs in GitHub Actions against PostgreSQL 16 on every push.
- **Hosting:**
  - Render free web service (backend + dashboard, HTTPS) with a Neon free PostgreSQL database. Blueprint: `render.yaml`. Steps: [deployment.md](deployment.md).
  - Alternatively, self-host on a Windows PC with Docker (`docker-compose.yml`).

## Test results

140 automated backend tests pass, run locally and in CI. The Android unit tests (pairing payload, URL policy, opt-out keyword matching, backoff, TP-Status) pass in CI.

Load test, 6,000 recipients through 3 simulated phones with faults injected and a backend restart mid-run:

```
approve+queue 0.6s, send loop 34.6s (~10,000/min server-side, no phone pacing)
final: DELIVERED 5,046 · SUBMITTED (no report) 821 · FAILED 94 · UNKNOWN 37 · CANCELLED 2
automatic retries 187; UNKNOWN = 25 from the simulated crash + 12 simulated, none retried blindly
checks: 6,000/6,000 accounted for, nothing in flight, no message submitted twice,
        no confirmation to the opted-out / withdrawn recipient after the event
```

**load-resilience.test.ts** (2)

- load: 6000 recipients through 3 simulated phones with faults > accounts for every recipient and never sends a message twice
- backup and recovery > pg_dump / pg_restore round-trips every table

**gateway-queue.test.ts** (35)

- pairing > pairs once with a valid code and rejects reuse, unknown and expired codes
- pairing > gateway routes need a device token; admin tokens and revoked tokens are refused
- pairing > heartbeat stores health and returns commands
- end-to-end campaign through a simulated phone > test message gates approval; campaign sends, receives delivery reports and completes
- end-to-end campaign through a simulated phone > distinguishes submitted from delivered, and times out missing reports as NO_REPORT
- end-to-end campaign through a simulated phone > late delivery reports still confirm delivery
- end-to-end campaign through a simulated phone > a failed delivery report marks the message FAILED (not retried automatically)
- the confirm step blocks sending > after the kill switch is engaged (message requeued)
- the confirm step blocks sending > after the recipient opts out (message cancelled)
- the confirm step blocks sending > after the campaign is paused or cancelled
- the confirm step blocks sending > after the lease expired, and is idempotent for a confirmed attempt
- the confirm step blocks sending > from a different gateway
- the confirm step blocks sending > emergency stop and gateway pause stop leasing
- failures and retries > transient failures retry with backoff, then dead-letter when attempts are exhausted
- failures and retries > permanent rejections are never retried automatically
- failures and retries > Android's SMS limit pauses the gateway instead of burning retries
- failures and retries > multipart messages are SUBMITTED only when every part succeeds
- failures and retries > auto-pauses a campaign when the failure ratio crosses the threshold
- unknown outcomes and reconciliation > a phone that dies after confirmation leaves UNKNOWN (never auto-retried); a late report resolves it
- unknown outcomes and reconciliation > SUBMIT_UNKNOWN from the app and CONFIRMED_SENT reconciliation is reported as inferred, not delivered
- unknown outcomes and reconciliation > released (NOT_SENT) jobs go straight back to the queue without using an attempt
- queue mechanics > two gateways leasing at the same time never get the same message
- queue mechanics > respects the daily segment budget
- queue mechanics > respects the campaign budget and pauses the campaign
- queue mechanics > refuses to approve a campaign that exceeds its budget
- queue mechanics > sends nothing outside the sending window
- queue mechanics > applies cooldowns after N messages
- queue mechanics > starts scheduled campaigns when their time comes
- queue mechanics > approval is not repeatable and cannot double-queue
- queue mechanics > requires a separate approver when configured
- queue mechanics > blocks campaigns containing generated demo contacts
- opt-outs during a campaign > an SMS reply STOP suppresses the sender and cancels their queued message
- opt-outs during a campaign > withdrawing consent cancels the contact’s queued messages
- dashboard > summary reflects contacts, messages and gateways
- simulator > is reproducible for a given seed

**import-export.test.ts** (12)

- import > maps common header names
- import > handles Excel numbers in scientific notation
- import > previews every problem before anything is saved
- import > commits valid rows with consent from the file, flags invalid rows when asked, and skips duplicates
- import > re-importing matches existing contacts; update mode refreshes them
- import > imports XLSX
- import > rejects files without a phone column, empty files and unsupported types
- import > streams a 6,000-row file within limits
- export > guards against spreadsheet formula injection but leaves phone numbers intact
- export > exports contacts with masking by role and audits the export
- export > serves the import template
- erasure > removes personal data but keeps the opt-out

**campaigns.test.ts** (11)

- campaign creation idempotency > requires an Idempotency-Key
- campaign creation idempotency > a retried request returns the same campaign instead of creating a second
- campaign creation idempotency > reusing a key with a different body is rejected
- campaign creation idempotency > concurrent requests with the same key create exactly one campaign
- campaign creation idempotency > concurrent creation with different keys creates independent campaigns
- campaign validation and lifecycle > rejects unknown personalisation fields and over-long messages
- campaign validation and lifecycle > rejects bad schedules and unknown groups
- campaign validation and lifecycle > enforces the configured recipient cap
- campaign validation and lifecycle > only drafts can be edited or deleted
- campaign preview (dry run) > counts exclusions, segments and cost without queueing anything
- campaign preview (dry run) > flags Unicode and multi-segment messages

**rbac-contacts.test.ts** (12)

- role-based access control > viewers can read but not write
- role-based access control > operators cannot approve-level actions such as changing settings or deleting contacts
- role-based access control > phone numbers are masked unless the role has contacts.read_full
- role-based access control > the last active super administrator cannot be demoted or deactivated
- role-based access control > a newly created admin must change the temporary password
- contacts > normalises to E.164 and rejects the same number written differently
- contacts > does not merge numbers that are merely similar
- contacts > rejects invalid numbers with a reason instead of altering them
- contacts > records consent at creation and exposes the history
- contacts > searches, filters and paginates
- contacts > bulk-updates tags and groups
- contacts > edits re-validate the phone and keep the audit trail

**auth.test.ts** (13)

- login > succeeds with correct credentials and sets an HttpOnly SameSite cookie
- login > returns the same error for unknown email and wrong password
- login > locks the account after repeated failures
- login > refuses inactive accounts
- login > validates input
- sessions > rejects missing, garbage and revoked tokens
- sessions > rejects expired sessions
- sessions > requires the CSRF header on cookie-authenticated writes, but not on reads or bearer calls
- password change > blocks everything except change-password until a temporary password is changed
- password change > revokes other sessions after a change
- password change > stores argon2id hashes, never plaintext
- rate limiting > limits login attempts per IP
- security headers and docs > sends helmet headers and serves OpenAPI

**optout-settings.test.ts** (8)

- opt-out > suppresses immediately, cancels queued messages and withdraws consent
- opt-out > is idempotent and works for numbers that are not contacts
- opt-out > survives contact deletion and re-creation of the same number
- opt-out > lifting requires a justification and leaves consent withdrawn
- settings and kill switch > validates settings and audits changes
- settings and kill switch > normalises authorised test numbers
- settings and kill switch > engages and releases the kill switch with an audit trail
- tools > analyses SMS text and checks numbers without saving

**database.test.ts** (11)

- migrations > are idempotent: re-running applies nothing
- migrations > refuse to run when an applied migration was edited
- migrations > serialise concurrent runners with an advisory lock
- constraints > a phone number can only belong to one live contact
- constraints > a soft-deleted contact frees its number
- constraints > rejects malformed E.164 and valid-without-number
- constraints > a recipient cannot be added to the same campaign twice
- constraints > message state must agree with its lease
- constraints > only one active suppression per number
- audit log > is append-only
- audit log > can be purged only inside an explicit retention transaction

**unit.test.ts** (36)

- phone normalisation (Eswatini default +268) > accepts 76123456 -> +26876123456
- phone normalisation (Eswatini default +268) > accepts 7612 3456 -> +26876123456
- phone normalisation (Eswatini default +268) > accepts +268 7612 3456 -> +26876123456
- phone normalisation (Eswatini default +268) > accepts (+268) 7612-3456 -> +26876123456
- phone normalisation (Eswatini default +268) > accepts 0026876123456 -> +26876123456
- phone normalisation (Eswatini default +268) > accepts 26876123456 -> +26876123456
- phone normalisation (Eswatini default +268) > accepts 78123456 -> +26878123456
- phone normalisation (Eswatini default +268) > accepts 79123456 -> +26879123456
- phone normalisation (Eswatini default +268) > accepts +27 82 123 4567 -> +27821234567
- phone normalisation (Eswatini default +268) > rejects "" with EMPTY
- phone normalisation (Eswatini default +268) > rejects "   " with EMPTY
- phone normalisation (Eswatini default +268) > rejects "7612O456" with INVALID_CHARACTERS
- phone normalisation (Eswatini default +268) > rejects "76123456 ext 2" with INVALID_CHARACTERS
- phone normalisation (Eswatini default +268) > rejects "76+123456" with INVALID_CHARACTERS
- phone normalisation (Eswatini default +268) > rejects "7612345" with INVALID_NUMBER
- phone normalisation (Eswatini default +268) > rejects "761234567" with INVALID_NUMBER
- phone normalisation (Eswatini default +268) > rejects "0821234567" with INVALID_NUMBER
- phone normalisation (Eswatini default +268) > rejects "22404000" with NOT_MOBILE
- phone normalisation (Eswatini default +268) > allows fixed lines only when explicitly requested (opt-out handling)
- phone normalisation (Eswatini default +268) > respects a different default country
- phone normalisation (Eswatini default +268) > masks the middle of numbers
- SMS segment calculation > GSM-7 single and multipart boundaries (160 / 153)
- SMS segment calculation > extension characters cost two septets and are not split across parts
- SMS segment calculation > a single non-GSM character switches the whole message to UCS-2 (70 / 67)
- SMS segment calculation > emoji take two UTF-16 units and surrogate pairs are never split
- SMS segment calculation > siSwati and English text without special characters stays GSM-7
- SMS segment calculation > typographic quotes force UCS-2 and are reported
- SMS segment calculation > empty text is one segment
- SMS segment calculation > estimates cost
- templates > validates fields
- templates > renders with fallbacks and reports missing values
- templates > does not interpret contact data as template syntax
- recipient eligibility > excludes invalid, suppressed, unconsented, duplicate and over-limit recipients in that order
- recipient eligibility > suppression wins over consent
- misc > password policy
- misc > stable JSON ignores key order

## Known limitations

1. **Real-device testing is yours to do.**
   - Everything up to the radio was tested with the simulator, and the Android app compiles and passes its unit tests.
   - Sending real SMS through a real SIM could not be done from the build environment.
   - Follow the pilot in [capacity.md](capacity.md): pair the phone, send a diagnostic test SMS, then a 20–50 message campaign.
2. **Android's SMS limit** (about 30 per 30 minutes) stalls unattended sending unless it is raised with adb on the phone. The system detects it and pauses the phone with an alert.
3. **Delivery confirmation depends on the carrier.** Without delivery reports, messages are shown as submitted, never as delivered.
4. **Exactly-once delivery is impossible** with a SIM gateway. If the app is killed in the moment between handing an SMS to Android and hearing back, that message is UNKNOWN and needs a person to reconcile it. The system never guesses.
5. **Free hosting limits:**
   - Render sleeps after 15 minutes idle; the first request then takes about a minute.
   - Neon offers 0.5 GB of storage.
   - Both are fine for an institution of this size, but are not a service-level guarantee.
6. **Signing key:** APKs are signed with a committed development key until you add your own key as GitHub secrets ([security.md](security.md)).
7. **Docker Compose** was validated but not run in the build environment, because Docker Hub was blocked there. The same image steps run natively in CI.
8. **Data location:** cloud hosting stores personal data in the EU (Frankfurt). Confirm this is acceptable under Eswatini's Data Protection Act, or self-host.
