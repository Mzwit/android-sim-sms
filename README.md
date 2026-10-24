# Android SIM SMS Gateway

A consent-based bulk SMS system for an institution's own registered recipients (tested at 6,000+).

- An **Android phone with a physical SIM** does the sending.
- A **web dashboard** manages contacts, consent, campaigns, approvals and reports.
- A **server** keeps a durable queue so that nothing is lost and nothing is sent twice by accident.

> Message only people who agreed to receive these messages. Agree volumes with your carrier before large campaigns. See [docs/capacity.md](docs/capacity.md).

## What is in this repository

| Folder | What it is |
|---|---|
| `backend/` | Node.js 22 + Fastify + TypeScript API, PostgreSQL migrations, background workers, simulated phone, 140 automated tests |
| `dashboard/` | React web dashboard (served by the backend) |
| `android/` | Kotlin Android app (the gateway). Built and signed by GitHub Actions |
| `docs/` | Architecture, deployment, database/ERD, API, security, capacity, troubleshooting, status report |
| `templates/` | Contact import CSV template, campaign report template |
| `scripts/` | Windows PowerShell backup, restore and test scripts |
| `render.yaml` | Free cloud hosting blueprint (Render + Neon) |
| `docker-compose.yml`, `Dockerfile` | Self-hosting on a Windows PC |

## Get it running

1. **Server and dashboard**: free cloud (Render + Neon) or your own PC. Step by step: [docs/deployment.md](docs/deployment.md).
2. **Phone**: download the APK from the [latest-apk release](https://github.com/Mzwit/android-sim-sms/releases/tag/latest-apk), install it, grant permissions, choose the SIM, and scan the pairing QR from **Phones → Pair a phone**.
3. **Try it without a phone** (no SMS sent):
   ```powershell
   cd backend; npm ci
   npm run simulate -- --url https://YOUR-SERVER --code PAIRING-CODE
   ```

## How sending stays safe

- **No send without confirmation:** the phone asks the server for confirmation immediately before every SMS. The kill switch, pauses, opt-outs and cancellations therefore take effect within seconds, and a message that was never confirmed was provably never sent.
- **Crash-safe journal:** every state change on the phone is journalled before it happens. After a crash, uncertain messages are marked **Unknown** for a person to reconcile. They are never resent blindly.
- **Honest delivery states:** *submitted* (handed to the network), *delivered* (delivery report received) and *no report* are always shown separately.
- **Retries:** temporary errors retry with backoff. Permanent rejections and opted-out recipients are never retried. Phone problems (Android's SMS limit, airplane mode, missing permission, SIM removed) pause that phone and raise an alert.
- **Before sending:** consent is checked for every recipient. Opt-outs (including SMS replies of STOP) cancel queued messages immediately. Campaigns require a test message and a typed-name approval.
- **Limits:** daily and per-campaign airtime budgets, sending windows, rest periods, and automatic pause on failure spikes.
- **Records:** every action is in an append-only audit log.

## Documentation

- [Deployment (cloud, Windows/Docker, USB, phone setup)](docs/deployment.md)
- [Architecture and feasibility](docs/architecture.md) · [Capacity and performance](docs/capacity.md)
- [Database and ERD, backup/restore, retention](docs/database.md) · [API and phone protocol](docs/api.md) ([OpenAPI](docs/openapi.json))
- [Security and compliance checklist](docs/security.md) · [Troubleshooting](docs/troubleshooting.md)
- [Status report and test results](docs/status-report.md)

## Development

```powershell
# backend (needs PostgreSQL; see docs/deployment.md option C)
cd backend; npm ci; $env:DATABASE_URL="postgres://smsgw:…@localhost:5432/smsgw"; npm run dev
$env:TEST_DATABASE_URL="postgres://smsgw:…@localhost:5432/smsgw_test"; npm test
# dashboard (proxies /api to :8443)
cd dashboard; npm ci; npm run dev
# Android: open android/ in Android Studio, or push and let GitHub Actions build the APK
```
