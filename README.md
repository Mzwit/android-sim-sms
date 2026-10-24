# Android SIM SMS Gateway

A consent-based bulk SMS system for an institution's own registered recipients. An Android phone with a physical SIM does the sending. A PC runs the database, the API and the web dashboard, and controls the phone over the local network.

> Use it only for people who have agreed to receive these messages. Get your carrier's position on message volume before production use. See [docs/architecture.md](docs/architecture.md).

## Build status

| Phase | Scope | Status |
|---|---|---|
| 1 | Architecture, carrier constraints, feasibility | ✅ [docs/architecture.md](docs/architecture.md) |
| 2 | Database schema, backend API, authentication, tests | ✅ [docs/phase-2-report.md](docs/phase-2-report.md) |
| 3 | Android app: SIM, permissions, foreground service, pairing | ⏳ next |
| 4 | Contact import, campaign approval, persistent queue, dashboard | |
| 5 | Submission tracking, delivery reports, retries, reconciliation | |
| 6 | Analytics, exports, security hardening, operational controls | |
| 7 | Integration and 6,000-recipient load tests, real-device tests, deployment guide | |

## Quick start (Windows PowerShell, Docker Desktop)

```powershell
cd "$env:USERPROFILE\Documents\PROJECTS\ANDROID SIM SMS"
Copy-Item .env.example .env
notepad .env                       # set POSTGRES_PASSWORD (letters and digits, 24+ characters)
docker compose up -d --build
docker compose exec backend node dist/src/cli/create-admin.js --email you@example.org --name "Your Name"
start http://localhost:8443/docs   # API explorer; sign in with POST /api/v1/auth/login
```

There are no default accounts or passwords. `create-admin` prints a one-time password that must be changed at first sign-in.

## Layout

```
backend/        Fastify + TypeScript API, SQL migrations, tests
docs/           architecture, database (ERD, backup/restore), API guide, phase reports, openapi.json
scripts/        backup.ps1, restore.ps1, run-tests.ps1
docker/         database init scripts
docker-compose.yml, .env.example
android/        (Phase 3) Android Studio project
dashboard/      (Phase 4) React web dashboard
```

## Documentation

- [Architecture and feasibility](docs/architecture.md)
- [Database design, ERD, backup and restore](docs/database.md)
- [API guide with examples](docs/api.md); full spec in [openapi.json](docs/openapi.json)
- [Phase 2 report: run commands, test results, limitations](docs/phase-2-report.md)
