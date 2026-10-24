# Deployment guide

Three ways to run the server. Pick one; the Android app works with all of them.

| | A. Free cloud (recommended to start) | B. Your Windows PC with Docker | C. Your PC without Docker |
|---|---|---|---|
| Cost | Free (Render + Neon free tiers) | Free | Free |
| PC must stay on | No | Yes | Yes |
| Phone connects over | Internet (mobile data or any Wi-Fi) | Same Wi-Fi, or USB | Same Wi-Fi, or USB |
| HTTPS | Automatic | Self-signed certificate, pinned by the app | Same as B |
| Where data lives | Neon (EU, Frankfurt) | Your PC | Your PC |

> **Data protection.** Option A stores recipients' names and numbers on servers in the EU. Eswatini's Data Protection Act, 2022 regulates transfers of personal data outside Eswatini. Confirm with your institution before loading real recipients. Options B and C keep everything on your PC.

---

## A. Free cloud: Neon (database) + Render (server and dashboard)

You need the GitHub repository `Mzwit/android-sim-sms` (already created), and about 15 minutes.

### 1. Create the database on Neon

1. Go to https://neon.tech and sign up with your GitHub account (free plan, no card needed).
2. **Create project**: name it `sim-sms-gateway`, PostgreSQL version **16**, region **AWS Europe Central (Frankfurt)**.
3. On the project dashboard, click **Connect**. Copy the **connection string**. It looks like
   `postgresql://neondb_owner:…@ep-…eu-central-1.aws.neon.tech/neondb?sslmode=require`.
   Keep it private: it is the database password.

### 2. Create the web service on Render

1. Go to https://render.com and sign up with your GitHub account (free, no card needed).
2. Click **New → Blueprint**. Connect GitHub when asked, and allow access to `android-sim-sms`.
3. Select the repository. Render reads `render.yaml` and shows one service, `sim-sms-gateway`.
4. Fill in the two values it asks for:
   - `DATABASE_URL`: the Neon connection string from step 1.
   - `BOOTSTRAP_ADMIN_EMAIL`: your email address.
5. Click **Apply**. The first build takes about 5 minutes.
6. Open the service → **Logs**. Look for:
   ```
   FIRST ADMINISTRATOR CREATED
     email:              you@example.org
     temporary password: ••••••••••••••••••••
   ```
   This is printed once. Copy the password.
7. Open the service URL (for example `https://sim-sms-gateway.onrender.com`). Sign in, and choose your own password.

**Things to know about the free tiers:**

- **Render spins the service down after 15 minutes without traffic.** The next visit then takes about a minute to start. While the gateway phone is running, it checks in every 30–60 seconds, which keeps the service awake. That uses about 744 of Render's 750 free hours a month for one service.
- **Neon's free plan includes 0.5 GB of storage.**
  - That is roughly 50 campaigns of 6,000 recipients with the default retention.
  - Shorten retention under **Settings → Data retention** if you need more room.
  - Neon pauses the database when idle. It wakes in about a second.
- Every push to `main` on GitHub redeploys automatically.

### 3. Backups (cloud)

- Neon keeps a short restore history (see your plan under **Backup & restore**).
- For your own copies, run this from any PC with PostgreSQL 16 client tools:
  ```powershell
  pg_dump "postgresql://…your Neon string…" -Fc -f "smsgw-$(Get-Date -Format yyyyMMdd).dump"
  ```
- Store the dump file encrypted. It contains personal data.

---

## B. Your Windows PC with Docker

### 1. Install

1. Install **Docker Desktop**: https://www.docker.com/products/docker-desktop/
2. Get the code. Either download the zip from GitHub (**Code → Download ZIP**), or run:
   ```powershell
   git clone https://github.com/Mzwit/android-sim-sms.git "$env:USERPROFILE\Documents\PROJECTS\ANDROID SIM SMS"
   ```

### 2. Configure and start

```powershell
cd "$env:USERPROFILE\Documents\PROJECTS\ANDROID SIM SMS"
Copy-Item .env.example .env
# Generate a database password (letters and digits only) and paste it into .env:
-join ((48..57)+(65..90)+(97..122) | Get-Random -Count 32 | % {[char]$_})
notepad .env

docker compose up -d --build
docker compose logs -f backend           # wait for "SMS gateway backend on …", then Ctrl+C
docker compose exec backend node dist/src/cli/create-admin.js --email you@example.org --name "Your Name"
```

Open http://localhost:8443, sign in with the printed temporary password, and choose your own.

### 3. Let the phone reach the PC over Wi-Fi (HTTPS)

The app only talks to a server over HTTPS, except over a USB cable.

1. Find the PC's Wi-Fi IP address:
   ```powershell
   ipconfig | Select-String IPv4
   ```
   Use the one on your Wi-Fi adapter, for example `192.168.1.20`. Ask your network administrator to give the PC a fixed (reserved) address.
2. Install Node.js 22 from https://nodejs.org, then create the certificate:
   ```powershell
   cd backend; npm ci; npm run cert -- --ip 192.168.1.20; cd ..
   ```
3. In `.env`, set:
   ```
   BIND_ADDRESS=192.168.1.20
   TLS_CERT_PATH=/app/certs/server.crt
   TLS_KEY_PATH=/app/certs/server.key
   COOKIE_SECURE=true
   PUBLIC_URL=https://192.168.1.20:8443
   ```
4. Allow the port through Windows Firewall, on private networks only. Run in an **administrator** PowerShell:
   ```powershell
   New-NetFirewallRule -DisplayName "SMS Gateway 8443" -Direction Inbound -Protocol TCP -LocalPort 8443 -Action Allow -Profile Private
   ```
5. Restart and open the dashboard:
   ```powershell
   docker compose up -d
   ```
   Then go to `https://192.168.1.20:8443`. Your browser warns about the self-signed certificate; that is expected on a private network. The phone is protected differently: it pins the exact certificate when it scans the pairing QR.

**Never** port-forward 8443 on your router. If the phone must reach the server from outside your network, use Option A instead.

### 4. USB mode (no Wi-Fi needed)

1. On the phone, enable **Developer options → USB debugging**.
2. Install **Android Platform Tools** (`adb`) on the PC: https://developer.android.com/tools/releases/platform-tools
3. Connect the phone and accept the debugging prompt on it.
4. Forward the port:
   ```powershell
   adb reverse tcp:8443 tcp:8443
   ```
5. In the app, pair manually using the server URL `http://127.0.0.1:8443`. Plain HTTP is allowed only to the phone itself.
6. Run `adb reverse tcp:8443 tcp:8443` again every time the cable is reconnected or the PC restarts.

USB mode is good for a demonstration. Use Wi-Fi or Option A for daily operation.

### 5. Backups and updates

```powershell
.\scripts\backup.ps1                       # verified dump in .\backups
.\scripts\restore.ps1 -File backups\smsgw-YYYYMMDD-HHMMSS.dump
git pull; docker compose up -d --build     # update; database migrations run automatically
```

Back up before every update. To schedule a daily backup, see [database.md](database.md).

---

## C. Your PC without Docker (Node.js + PostgreSQL)

1. Install Node.js 22 (https://nodejs.org) and PostgreSQL 16 (https://www.postgresql.org/download/windows/).
2. In **SQL Shell (psql)** as `postgres`, run:
   ```sql
   CREATE USER smsgw WITH PASSWORD 'choose-a-long-password';
   CREATE DATABASE smsgw OWNER smsgw;
   CREATE DATABASE smsgw_test OWNER smsgw;
   ```
3. Build and start:
   ```powershell
   cd dashboard; npm ci; npm run build; cd ..\backend; npm ci
   $env:DATABASE_URL = "postgres://smsgw:choose-a-long-password@localhost:5432/smsgw"
   npm run build
   npm run admin:create:prod -- --email you@example.org --name "Your Name"
   npm start                     # http://127.0.0.1:8443
   ```
4. For Wi-Fi pairing, create a certificate (`npm run cert -- --ip <LAN IP>`). Then set `HOST`, `TLS_CERT_PATH`, `TLS_KEY_PATH` and `PUBLIC_URL` as environment variables, as in B.3.

---

## The Android phone

### Install the app

1. Open the latest release: https://github.com/Mzwit/android-sim-sms/releases/tag/latest-apk (sign in to GitHub first; the repository is private). Download `sim-sms-gateway-1.0.N.apk`.
2. Copy it to the phone, or download it on the phone directly. Open it and allow **Install unknown apps** for your browser or file manager when Android asks.
3. Any later build installs over the old one, because every build is signed with the same key.

**Recommended phone:**
- Android 8 or newer, kept on a charger, with a stable signal.
- A SIM with an SMS bundle.
- Not someone's personal phone: the app reads incoming SMS only to catch STOP replies, and it never uploads other messages.

### Set it up

1. **Grant permissions** in the app: SMS, Phone and Notifications.
2. **Choose SIM**: pick the SIM that will send.
3. **Pair**:
   1. On the dashboard, open **Phones → Pair a phone**, give the phone a name, and click **Show pairing code**.
   2. In the app, tap **Pair with server → Scan QR code**.
   3. The code works once and expires in 10 minutes.
4. **Diagnostics → Turn off battery optimisation.** Also apply the manufacturer step for your phone:
   - **Samsung:** Settings → Battery → Background usage limits → Never sleeping apps → add *SIM SMS Gateway*.
   - **Xiaomi / Redmi:** Settings → Apps → *SIM SMS Gateway* → Battery saver → **No restrictions**, and enable **Autostart**.
   - **Tecno / Infinix (HiOS / XOS):** Phone Master → App launch / Auto-start management → allow; Battery → App power saving → off.
   - **Huawei:** Settings → Battery → App launch → turn off "Manage automatically" → allow all three.
5. **Send a test SMS:**
   1. On the dashboard, add your own number under **Settings → Authorised test numbers**.
   2. In the app, open **Diagnostics → Send test SMS**.
6. Press **Start gateway**. The notification shows what the gateway is doing.

### Android's own SMS limit

Android asks the person holding the phone to confirm after an app sends about 30 SMS in 30 minutes. A phone sitting unattended will stall there.

On your own phone, with USB debugging, you can raise the limit:

```powershell
adb shell settings put global sms_outgoing_check_max_count 1000
adb shell settings put global sms_outgoing_check_interval_ms 60000
```

Some manufacturers ignore this. If the limit is hit anyway, the server pauses that phone and raises a critical alert. It never retries blindly.

---

## Your first real campaign

1. Pilot first: 20–50 messages to people who agreed to help test. Watch the **Phones** page and the delivery results.
2. **Contacts → Import CSV or Excel.** Start from the template. Review the problem rows, then import.
3. **Campaigns → New campaign**: choose the group, write the message, and set the window and limits.
4. On the draft:
   1. Check the recipient numbers and the sample messages.
   2. Click **Send test**.
   3. Click **Submit for approval**.
5. An approver opens it, types the campaign name, and clicks **Approve and queue**. Then click **Start sending now**.
6. Watch progress. Afterwards:
   - Reconcile anything under **Needs attention → Unknown outcome**.
   - Retry dead letters if appropriate.
   - Download or print the report.

Ask your carrier (MTN Eswatini or Eswatini Mobile) about volume terms before large campaigns. See [capacity.md](capacity.md).
