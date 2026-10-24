# Troubleshooting

## Dashboard and server

| Symptom | Likely cause | What to do |
|---|---|---|
| Render page takes about a minute to load | The free instance was asleep | Normal. It stays awake while a phone is running. |
| `[fatal] Missing required environment variable DATABASE_URL` | Environment not set | Render: set it in the service's Environment tab. Docker: check `.env`. |
| `Migration … was modified after it was applied` | A migration file was edited | Restore the original file from Git. Schema changes always go in a new numbered file. |
| Cannot sign in: "Too many failed attempts" | Account locked for 15 minutes after 5 failures | Wait, or ask another super administrator to click **Unlock**. |
| No administrator and no shell (Render free) | – | Set `BOOTSTRAP_ADMIN_EMAIL`, redeploy, and read the temporary password in the logs. It works only while no administrator exists. |
| "Kill switch on" banner | Someone stopped all sending | Settings → Kill switch → give a reason → **Turn off and allow sending**. |
| `docker compose up` fails pulling images | No internet, or Docker Desktop is not running | Start Docker Desktop and try again. |
| Browser warns about the certificate (self-hosted) | Self-signed certificate | Expected on a LAN. Check that the fingerprint matches `npm run cert` output. |

## Pairing the phone

| Symptom | What to do |
|---|---|
| "Pairing code is invalid, expired or already used" | Codes work once, for 10 minutes. Create a new one. |
| "The server must use https://" | Use the Render URL, or set up the LAN certificate (deployment guide B.3). Plain HTTP only works over USB (`http://127.0.0.1:8443` with `adb reverse`). |
| "Secure connection failed … fingerprint" | The server's certificate changed since the QR was made. Make a new pairing code. |
| "Cannot reach the server" on Wi-Fi | Phone and PC must be on the same network. Check the firewall rule, check `BIND_ADDRESS`, and try opening `https://<PC IP>:8443/healthz` in the phone's browser. Guest Wi-Fi networks often block device-to-device traffic. |
| USB mode stops working | Run `adb reverse tcp:8443 tcp:8443` again after reconnecting the cable or restarting the PC. |

## Sending

| Symptom on the dashboard / app | Meaning | What to do |
|---|---|---|
| Phone **Offline** | No check-in for 5+ minutes | Check power, signal and data, and that the app shows *Gateway running*. Apply the battery steps in the deployment guide. |
| Phone paused: `LIMIT_EXCEEDED: Android's outgoing SMS limit was reached` | Android's SmsUsageMonitor blocked the app | On the phone, accept the prompt if shown, or raise the limit with adb (deployment guide). Then **Resume** the phone. |
| Phone paused: `RADIO_OFF` | Airplane mode | Turn airplane mode off, then **Resume**. |
| Phone paused: 10 consecutive send failures | Usually no signal, no airtime, or the carrier is blocking the SIM | Check the balance (e.g. dial the carrier's balance code) and the signal. If the carrier blocked the SIM, stop and contact them. Do not swap SIMs to get around a block. |
| Campaign auto-paused: "X of the last N attempts failed" | Failure ratio crossed the campaign threshold | Open the campaign → Report → *Most common problems*. Fix the cause, then **Resume**. |
| Campaign paused: "segment budget reached" | Budget used up | Raise the budget in Edit (drafts) or with the API, then **Resume**, if the spend is intended. |
| Idle: `DAILY_BUDGET_REACHED` | Daily airtime budget used up | Continues tomorrow, or raise **Settings → Daily segment budget**. |
| Idle (nothing to send), but messages are queued | Outside the campaign's sending window, in a rest period, or waiting out a retry backoff | Check the campaign's schedule. Retries wait 1–30 minutes. |
| Many **Unknown** outcomes | The app stopped after handing SMS to Android (killed, rebooted, crashed) | Reconcile under **Needs attention**: check the phone's Sent folder for those numbers before resending. Fix battery optimisation to prevent it. |
| Submitted but never **Delivered** | The carrier does not return delivery reports | Normal for some networks. The report shows these honestly as "submitted, no report". |
| `TP_STATUS_0x41` etc. | The network reported permanent non-delivery (e.g. number not in service) | Check the number with the recipient. Do not retry blindly. |
| `NETWORK_REJECT` | The network refused the message | Check the number format. Repeated rejections across many numbers can mean the SIM is restricted. |
| `INVALID_SMSC_ADDRESS` | SIM's message-centre number missing | Reset SMS settings or reinsert the SIM. Ask the carrier for the SMSC number. |
| App shows "Server refused this phone" | It was unpaired on the dashboard | Pair it again. |

## Diagnostics checklist on the phone

Open the app → **Diagnostics**. Every line should show ✅:
- Permissions granted.
- SIM ready.
- Signal level at least 1.
- Internet available.
- Battery optimisation disabled.
- Server reachable.

Send a test SMS to an authorised number. The "Recent problems" list shows what went wrong, with Android's result codes.

## Logs

- **Render:** service → **Logs**.
- **Docker:** run `docker compose logs --tail 200 backend`.
- **Audit log** (dashboard): every action, phone event and automatic pause, with the reason.
