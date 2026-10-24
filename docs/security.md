# Security and compliance checklist

## Built in

### Authentication and access
- [x] **Passwords:** argon2id (64 MiB, t=3). Minimum 12 characters, with common and email-derived passwords rejected.
- [x] **No default credentials:**
  - The first administrator is created by a command or the one-time bootstrap.
  - Temporary passwords must be changed at first sign-in.
- [x] **Sessions:**
  - Opaque random tokens; only their SHA-256 is stored.
  - HttpOnly, SameSite=Strict, Secure cookie (when served over HTTPS).
  - Cookie-authenticated writes require a custom header, which blocks cross-site form posts.
- [x] **Sign-in protection:**
  - Lockout after 5 failures.
  - 10 sign-in attempts per minute per IP; global API rate limit.
  - The same answer for an unknown email and a wrong password.
- [x] **Roles:**
  - Five roles with 18 permissions, checked on every route.
  - Full phone numbers are visible only with `contacts.read_full`.
  - The last super administrator cannot be removed.

### Phone (gateway) access
- [x] **Pairing:**
  - One-time codes: 10 minutes, single use, hashed, rate-limited.
  - Device tokens are hashed on the server and encrypted on the phone with an Android Keystore key.
  - Phones are revocable instantly.
- [x] **No listening endpoint on the phone:** the server never connects to the phone, so nothing on the network can make the phone send SMS.
- [x] **Confirmation before every SMS:**
  - The server re-checks the kill switch, pauses, opt-outs and campaign state immediately before each message.
  - A revoked phone is refused at once.

### Transport, input and output
- [x] **Transport:**
  - HTTPS everywhere. Render terminates TLS; self-hosting uses a certificate that the app pins by SHA-256 fingerprint.
  - The app refuses plain HTTP except to 127.0.0.1 (USB).
  - HSTS is sent when served over TLS.
- [x] **Input validation:** JSON schemas on every endpoint, with unknown fields stripped.
- [x] **Queries:** parameterised SQL only. Search input has LIKE wildcards escaped.
- [x] **Output:**
  - React escapes all output.
  - Security headers via Helmet, including a strict CSP and `frame-ancestors 'none'`.
  - CSV exports neutralise spreadsheet formulas.

### Messaging rules
- [x] **Consent and opt-outs:**
  - Consent history per contact; contacts without consent are excluded automatically.
  - Opt-outs are keyed by number, so they survive deletion and re-import.
  - An opt-out or consent withdrawal cancels queued messages in the same transaction.
  - STOP replies are processed automatically. Other incoming SMS are never uploaded or stored.
- [x] **Duplicate and test protection:**
  - Idempotency keys on campaign creation.
  - Database uniqueness constraints mean one message per recipient per campaign.
  - Test messages go only to authorised numbers.
  - Campaigns containing generated demo contacts are refused.
- [x] **Approval:**
  - Typed-name confirmation.
  - Optional separate approver.
  - A submitted test message is required before approval (default on).

### Operational controls
- [x] **Kill switch:** global, takes effect at each phone's next confirmation.
- [x] **Stops and limits:**
  - Per-phone pause and emergency stop.
  - Daily and per-campaign segment budgets.
  - Automatic pause on failure spikes and on Android's SMS limit.
  - No mechanism to bypass carrier limits.
- [x] **Audit log:** append-only (a database trigger blocks edits). It covers sign-ins, every change, approvals, exports, phone events and automatic pauses.
- [x] **Retention and erasure:**
  - Configurable retention with a daily purge.
  - Per-person erasure that keeps the opt-out.
- [x] **Backups:** a verified backup script, a single-transaction restore, and an automated round-trip test.

## Your responsibilities before going live

- [ ] Confirm the lawful basis and consent wording with your institution, and record how each contact consented (import column `consent_source`).
- [ ] Decide where data may be hosted (EU cloud vs on-premises) under the Eswatini Data Protection Act, 2022, and register with the Eswatini Communications Commission / data protection authority if required.
- [ ] Get the carrier's agreement for your expected volume.
- [ ] Use a dedicated gateway phone and SIM, not a personal phone.
- [ ] **Signing key:**
  - Builds are currently signed with the committed **development** key.
  - For production, create your own key and add it as GitHub secrets `SIGNING_KEY_BASE64`, `SIGNING_STORE_PASSWORD`, `SIGNING_KEY_ALIAS` and `SIGNING_KEY_PASSWORD`.
  - The first install with the new key requires uninstalling the development build.
- [ ] Give each person their own administrator account with the least role they need. Turn on **require separate approver** if two people are available.
- [ ] Add your own number as an authorised test number. Always send a test first.
- [ ] Keep backups (cloud: `pg_dump` the Neon database regularly) on encrypted storage.
- [ ] Self-hosting:
  - Never port-forward the server to the internet.
  - Use a fixed LAN IP.
  - Keep Windows and Docker updated.
- [ ] Review the audit log and open alerts weekly.
