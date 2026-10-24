# Phase 2 report: database, backend API, authentication, tests

**Status:** complete. 91 automated tests pass against a real PostgreSQL 16 database.

## What was built

| Area | Delivered |
|---|---|
| Schema | `backend/migrations/001_init.sql`: 27 tables covering every entity in spec §8, with CHECK-constrained states, foreign keys, partial unique indexes, an append-only audit trigger, RBAC seed (5 roles, 18 permissions) and default settings. See [database.md](database.md). |
| Migrations | Checksummed runner with an advisory lock (`src/migrate.ts`), run at startup or with `npm run migrate`. |
| Auth | argon2id hashing; opaque session tokens (hash-only storage); HttpOnly SameSite=Strict cookie plus Bearer tokens; CSRF header on cookie writes; account lockout; per-IP login rate limit; forced password change for new and reset accounts; other sessions revoked on password change. |
| RBAC | Per-route permission checks. Phone numbers are masked unless the role has `contacts.read_full`. The last active super admin is protected. |
| Contacts | E.164 normalisation (Eswatini +268 default, configurable). Exact-match duplicate detection, never fuzzy merging. Invalid numbers rejected with a reason. Search, filters, pagination, bulk tag/group edits, soft delete. |
| Consent | Append-only consent history per purpose. Opt-outs suppress the **number**, cancel its queued messages in the same transaction, record consent withdrawal, and survive deletion and re-import. |
| Campaigns | DRAFT creation with **Idempotency-Key**. Template validation with an allow-list of fields and fallbacks. Schedule (window, days, cooldown, time zone), budgets, auto-pause thresholds. **Preview** dry run: exclusion counts by reason, personalised samples, GSM-7/UCS-2 segment totals, cost estimate, warnings. |
| Platform | Append-only audit log covering every write. Validated settings. Global kill switch. Helmet security headers. Global API rate limit. OpenAPI docs at `/docs`. |
| Ops | Dockerfile (non-root, health check), `docker-compose.yml` (DB bound to localhost only), `.env.example`, PowerShell scripts for backup (verified), restore (single transaction) and tests. |

## Files

```
docker-compose.yml  .env.example  .gitignore
docker/initdb/01-create-test-db.sql
scripts/backup.ps1  scripts/restore.ps1  scripts/run-tests.ps1
docs/architecture.md  docs/database.md  docs/api.md  docs/openapi.json  docs/phase-2-report.md
backend/
  package.json  package-lock.json  tsconfig.json  vitest.config.ts  Dockerfile  .dockerignore
  migrations/001_init.sql
  src/app.ts  src/server.ts  src/config.ts  src/db.ts  src/migrate.ts
  src/auth/password.ts  src/auth/session.ts
  src/lib/audit.ts  crypto.ts  errors.ts  idempotency.ts  phone.ts  segments.ts  settings.ts  template.ts
  src/services/eligibility.ts  src/services/suppression.ts
  src/routes/auth.ts  admins.ts  contacts.ts  groups.ts  consent.ts  campaigns.ts  audit.ts  settings.ts  util.ts  common.ts
  src/cli/migrate.ts  create-admin.ts  seed.ts  export-openapi.ts
  test/global-setup.ts  helpers.ts  unit.test.ts  database.test.ts  auth.test.ts
       rbac-contacts.test.ts  campaigns.test.ts  optout-settings.test.ts
```

## Run it (Windows PowerShell)

Prerequisites: Docker Desktop. Node.js 20+ is needed only for running tests or developing without Docker.

```powershell
cd "$env:USERPROFILE\Documents\PROJECTS\ANDROID SIM SMS"
Copy-Item .env.example .env
notepad .env            # set POSTGRES_PASSWORD (letters and digits only, 24+ chars)

docker compose up -d --build
docker compose logs -f backend      # wait for "SMS gateway backend on http://0.0.0.0:8443"

# First administrator (prints a one-time password)
docker compose exec backend node dist/src/cli/create-admin.js --email you@example.org --name "Your Name"
```

Open http://localhost:8443/docs, sign in with `POST /auth/login`, then change the password with `POST /auth/change-password`. The web dashboard arrives in Phase 4; until then the API docs page is the interface.

**Run the tests:**

```powershell
docker compose up -d db
.\scripts\run-tests.ps1
```

**Optional demo data (6,000 fake contacts, never send to them):**

```powershell
cd backend; npm ci
$env:DATABASE_URL = "postgres://smsgw:<your POSTGRES_PASSWORD>@localhost:5432/smsgw"
npm run seed -- --contacts 6000
```

## Test results

Run on 2026-10-24 against PostgreSQL 16.15 and Node 22:

```
 ✓ test/campaigns.test.ts > campaign creation idempotency > requires an Idempotency-Key 172ms
 ✓ test/campaigns.test.ts > campaign creation idempotency > a retried request returns the same campaign instead of creating a second 119ms
 ✓ test/campaigns.test.ts > campaign creation idempotency > reusing a key with a different body is rejected 108ms
 ✓ test/campaigns.test.ts > campaign creation idempotency > concurrent requests with the same key create exactly one campaign 153ms
 ✓ test/campaigns.test.ts > campaign creation idempotency > concurrent creation with different keys creates independent campaigns 177ms
 ✓ test/campaigns.test.ts > campaign validation and lifecycle > rejects unknown personalisation fields and over-long messages 94ms
 ✓ test/campaigns.test.ts > campaign validation and lifecycle > rejects bad schedules and unknown groups 111ms
 ✓ test/campaigns.test.ts > campaign validation and lifecycle > enforces the configured recipient cap 87ms
 ✓ test/campaigns.test.ts > campaign validation and lifecycle > only drafts can be edited or deleted 119ms
 ✓ test/campaigns.test.ts > campaign preview (dry run) > counts exclusions, segments and cost without queueing anything 206ms
 ✓ test/campaigns.test.ts > campaign preview (dry run) > flags Unicode and multi-segment messages 123ms
 ✓ test/auth.test.ts > login > succeeds with correct credentials and sets an HttpOnly SameSite cookie 141ms
 ✓ test/auth.test.ts > login > returns the same error for unknown email and wrong password 108ms
 ✓ test/auth.test.ts > login > locks the account after repeated failures 130ms
 ✓ test/auth.test.ts > login > refuses inactive accounts 77ms
 ✓ test/auth.test.ts > login > validates input 76ms
 ✓ test/auth.test.ts > sessions > rejects missing, garbage and revoked tokens 84ms
 ✓ test/auth.test.ts > sessions > rejects expired sessions 72ms
 ✓ test/auth.test.ts > sessions > requires the CSRF header on cookie-authenticated writes, but not on reads or bearer calls 86ms
 ✓ test/auth.test.ts > password change > blocks everything except change-password until a temporary password is changed 114ms
 ✓ test/auth.test.ts > password change > revokes other sessions after a change 85ms
 ✓ test/auth.test.ts > password change > stores argon2id hashes, never plaintext 58ms
 ✓ test/auth.test.ts > rate limiting > limits login attempts per IP 194ms
 ✓ test/auth.test.ts > security headers and docs > sends helmet headers and serves OpenAPI 71ms
 ✓ test/rbac-contacts.test.ts > role-based access control > viewers can read but not write 152ms
 ✓ test/rbac-contacts.test.ts > role-based access control > operators cannot approve-level actions such as changing settings or deleting contacts 119ms
 ✓ test/rbac-contacts.test.ts > role-based access control > phone numbers are masked unless the role has contacts.read_full 112ms
 ✓ test/rbac-contacts.test.ts > role-based access control > the last active super administrator cannot be demoted or deactivated 133ms
 ✓ test/rbac-contacts.test.ts > role-based access control > a newly created admin must change the temporary password 127ms
 ✓ test/rbac-contacts.test.ts > contacts > normalises to E.164 and rejects the same number written differently 119ms
 ✓ test/rbac-contacts.test.ts > contacts > does not merge numbers that are merely similar 108ms
 ✓ test/rbac-contacts.test.ts > contacts > rejects invalid numbers with a reason instead of altering them 72ms
 ✓ test/rbac-contacts.test.ts > contacts > records consent at creation and exposes the history 93ms
 ✓ test/rbac-contacts.test.ts > contacts > searches, filters and paginates 259ms
 ✓ test/rbac-contacts.test.ts > contacts > bulk-updates tags and groups 139ms
 ✓ test/rbac-contacts.test.ts > contacts > edits re-validate the phone and keep the audit trail 114ms
 ✓ test/optout-settings.test.ts > opt-out > suppresses immediately, cancels queued messages and withdraws consent 176ms
 ✓ test/optout-settings.test.ts > opt-out > is idempotent and works for numbers that are not contacts 154ms
 ✓ test/optout-settings.test.ts > opt-out > survives contact deletion and re-creation of the same number 127ms
 ✓ test/optout-settings.test.ts > opt-out > lifting requires a justification and leaves consent withdrawn 108ms
 ✓ test/optout-settings.test.ts > settings and kill switch > validates settings and audits changes 101ms
 ✓ test/optout-settings.test.ts > settings and kill switch > normalises authorised test numbers 106ms
 ✓ test/optout-settings.test.ts > settings and kill switch > engages and releases the kill switch with an audit trail 114ms
 ✓ test/optout-settings.test.ts > tools > analyses SMS text and checks numbers without saving 100ms
 ✓ test/database.test.ts > migrations > are idempotent: re-running applies nothing 217ms
 ✓ test/database.test.ts > migrations > refuse to run when an applied migration was edited 66ms
 ✓ test/database.test.ts > migrations > serialise concurrent runners with an advisory lock 78ms
 ✓ test/database.test.ts > constraints > a phone number can only belong to one live contact 81ms
 ✓ test/database.test.ts > constraints > a soft-deleted contact frees its number 77ms
 ✓ test/database.test.ts > constraints > rejects malformed E.164 and valid-without-number 67ms
 ✓ test/database.test.ts > constraints > a recipient cannot be added to the same campaign twice 103ms
 ✓ test/database.test.ts > constraints > message state must agree with its lease 104ms
 ✓ test/database.test.ts > constraints > only one active suppression per number 96ms
 ✓ test/database.test.ts > audit log > is append-only 78ms
 ✓ test/database.test.ts > audit log > can be purged only inside an explicit retention transaction 148ms
 ✓ test/unit.test.ts > phone normalisation (Eswatini default +268) > accepts 76123456 -> +26876123456 7ms
 ✓ test/unit.test.ts > phone normalisation (Eswatini default +268) > accepts 7612 3456 -> +26876123456 1ms
 ✓ test/unit.test.ts > phone normalisation (Eswatini default +268) > accepts +268 7612 3456 -> +26876123456 1ms
 ✓ test/unit.test.ts > phone normalisation (Eswatini default +268) > accepts (+268) 7612-3456 -> +26876123456 1ms
 ✓ test/unit.test.ts > phone normalisation (Eswatini default +268) > accepts 0026876123456 -> +26876123456 1ms
 ✓ test/unit.test.ts > phone normalisation (Eswatini default +268) > accepts 26876123456 -> +26876123456 0ms
 ✓ test/unit.test.ts > phone normalisation (Eswatini default +268) > accepts 78123456 -> +26878123456 0ms
 ✓ test/unit.test.ts > phone normalisation (Eswatini default +268) > accepts 79123456 -> +26879123456 0ms
 ✓ test/unit.test.ts > phone normalisation (Eswatini default +268) > accepts +27 82 123 4567 -> +27821234567 2ms
 ✓ test/unit.test.ts > phone normalisation (Eswatini default +268) > rejects "" with EMPTY 0ms
 ✓ test/unit.test.ts > phone normalisation (Eswatini default +268) > rejects "   " with EMPTY 0ms
 ✓ test/unit.test.ts > phone normalisation (Eswatini default +268) > rejects "7612O456" with INVALID_CHARACTERS 0ms
 ✓ test/unit.test.ts > phone normalisation (Eswatini default +268) > rejects "76123456 ext 2" with INVALID_CHARACTERS 0ms
 ✓ test/unit.test.ts > phone normalisation (Eswatini default +268) > rejects "76+123456" with INVALID_CHARACTERS 0ms
 ✓ test/unit.test.ts > phone normalisation (Eswatini default +268) > rejects "7612345" with INVALID_NUMBER 0ms
 ✓ test/unit.test.ts > phone normalisation (Eswatini default +268) > rejects "761234567" with INVALID_NUMBER 0ms
 ✓ test/unit.test.ts > phone normalisation (Eswatini default +268) > rejects "0821234567" with INVALID_NUMBER 0ms
 ✓ test/unit.test.ts > phone normalisation (Eswatini default +268) > rejects "22404000" with NOT_MOBILE 0ms
 ✓ test/unit.test.ts > phone normalisation (Eswatini default +268) > allows fixed lines only when explicitly requested (opt-out handling) 0ms
 ✓ test/unit.test.ts > phone normalisation (Eswatini default +268) > respects a different default country 1ms
 ✓ test/unit.test.ts > phone normalisation (Eswatini default +268) > masks the middle of numbers 0ms
 ✓ test/unit.test.ts > SMS segment calculation > GSM-7 single and multipart boundaries (160 / 153) 2ms
 ✓ test/unit.test.ts > SMS segment calculation > extension characters cost two septets and are not split across parts 3ms
 ✓ test/unit.test.ts > SMS segment calculation > a single non-GSM character switches the whole message to UCS-2 (70 / 67) 1ms
 ✓ test/unit.test.ts > SMS segment calculation > emoji take two UTF-16 units and surrogate pairs are never split 0ms
 ✓ test/unit.test.ts > SMS segment calculation > siSwati and English text without special characters stays GSM-7 0ms
 ✓ test/unit.test.ts > SMS segment calculation > typographic quotes force UCS-2 and are reported 0ms
 ✓ test/unit.test.ts > SMS segment calculation > empty text is one segment 0ms
 ✓ test/unit.test.ts > SMS segment calculation > estimates cost 0ms
 ✓ test/unit.test.ts > templates > validates fields 1ms
 ✓ test/unit.test.ts > templates > renders with fallbacks and reports missing values 1ms
 ✓ test/unit.test.ts > templates > does not interpret contact data as template syntax 0ms
 ✓ test/unit.test.ts > recipient eligibility > excludes invalid, suppressed, unconsented, duplicate and over-limit recipients in that order 1ms
 ✓ test/unit.test.ts > recipient eligibility > suppression wins over consent 0ms
 ✓ test/unit.test.ts > misc > password policy 0ms
 ✓ test/unit.test.ts > misc > stable JSON ignores key order 0ms
 Test Files  6 passed (6)
      Tests  91 passed (91)
   Duration  11.47s (tests 77%, import 22%, transform 1%)
```

Spec §12 coverage in this phase:
- Valid and invalid phone numbers ✓
- Duplicate contacts and campaign jobs ✓
- Unicode and multipart SMS ✓
- Opt-out (with queued-message cancellation) ✓
- Concurrent campaign creation ✓
- Authorization failures ✓

The remaining §12 items depend on the gateway, queue and import code, and are scheduled for:
- **Phase 3:** missing permissions, SIM unavailable, no network
- **Phase 4:** CSV import errors, campaign cancellation, backend restart with queued messages, opt-out *during* a running campaign
- **Phase 5:** carrier rejection, delayed or missing delivery reports, app restart, PC disconnection, retry exhaustion
- **Phase 7:** backup and recovery drill, 6,000-recipient simulated load

**Real-server smoke test:**
- Compiled build, then `create-admin`, then a forced password change, which blocked all other endpoints until it was done.
- 6,000 seeded contacts, then a campaign `preview`.
- The preview correctly excluded 150 invalid numbers, 210 opted out and 360 without consent, leaving 5,280 recipients. It estimated 5,280 segments and SZL 2,376 at 0.45 per segment, and warned that the 2,000/day budget means at least 3 days. **Time: 0.2 s.**

## Known limitations

1. **Docker Compose was validated (`docker compose config`) but not run end-to-end here,** because Docker Hub is unreachable from the build environment. The backend, migrations and all tests were run natively against PostgreSQL 16. Your first `docker compose up` is the first real container run; send me any error output.
2. **No web UI yet.** Phase 2 is the API. Use `/docs` (Swagger UI) to try it.
3. **Plain HTTP until Phase 3.** The API is bound to `127.0.0.1` by default, so it is not reachable from the network. Do not set `BIND_ADDRESS` to a LAN address until TLS is configured in Phase 3.
4. **Opt-out race:** an opt-out cancels QUEUED messages immediately, but a message already LEASED to the phone (a batch of at most 20) is stopped only by the phone's pre-send check, added in Phase 3. A message the phone has already handed to the radio cannot be recalled.
5. **Retention purge not scheduled yet** (Phase 6). Retention values are stored but nothing is deleted automatically.
6. **Phone numbers sharing one handset:** one live contact per E.164 number. Two people sharing a phone are one contact. This is deliberate, so nobody gets duplicate messages.
7. **Seed data numbers** are syntactically valid Eswatini numbers that may belong to real people. They are tagged `SEED_DATA`, and Phase 4 will block approving campaigns that contain them.
8. **Password URL encoding:** `DATABASE_URL` is built from `POSTGRES_PASSWORD`, so use letters and digits only. URL-reserved characters such as `@ / : #` would break it.

## Next: Phase 3

The Android Studio project (Kotlin) will include:
- SIM and permission checks, and dual-SIM selection
- A foreground service with a Room job journal
- QR pairing with certificate pinning
- TLS certificate generation for the PC
- Gateway API endpoints on the backend (pair, heartbeat, lease, callbacks)
- A diagnostic screen with test SMS to authorised numbers only
- Pause, resume and emergency stop
- `adb reverse` USB mode
