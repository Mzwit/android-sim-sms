# Performance and capacity assessment

## Summary

Throughput is set by **one phone, one SIM, Android's SMS limit and the carrier's tolerance**. The software is not the constraint. The server and database handled a 6,000-recipient campaign in about half a minute in testing; the phone needs hours.

## Measured: the server (simulated phones, no airtime)

Automated test `backend/test/load-resilience.test.ts`, run locally and on every push in GitHub Actions:

| Step | Result |
|---|---|
| Recipient checks and preview for 6,000 contacts | ~0.2 s |
| Approve: freeze 6,000 recipients and queue 6,000 messages | ~0.6 s |
| Send loop: 3 simulated phones, faults injected | ~34 s, about 10,000 messages per minute server-side |
| Import a 6,000-row CSV (stage + commit) | < 2 s |

Faults injected during the send loop:
- random radio failures (3% transient, 0.5% permanent) and 0.2% unknown outcomes;
- missing and failed delivery reports, and duplicated event batches;
- a backend restart halfway through;
- a phone going offline holding 40 leased messages;
- a phone crashing right after confirming 25 messages;
- an SMS STOP reply and a consent withdrawal during the run.

The test verifies that:
- all 6,000 recipients are accounted for;
- nothing is left in flight;
- **no message was submitted twice**;
- every crash-affected message is reported as UNKNOWN, not guessed;
- no message went to the opted-out or withdrawn recipient after the event.

Free-tier hosting (Render 0.1 CPU / 512 MB, Neon free) is slower than this test machine, but a single phone needs only about one request per second.

## Expected: one phone and one SIM

Each message costs one confirmation request, one SMS hand-off to Android, and one result upload.

| Phone pace (`send_interval_ms`) | Per hour | 6,000 single-segment messages |
|---|---|---|
| 1 every 3 s | 1,200 | ~5 h |
| 1 every 6 s (default) | 600 | ~10 h |
| 1 every 10 s | 360 | ~17 h |
| ~100 per hour (very conservative) | 100 | 60 h (spread over days with sending windows) |

What slows this in practice:

1. **Android's SMS limit.**
   - About 30 messages per 30 minutes per app by default, after which the phone asks for confirmation.
   - Until it is raised with adb, real throughput is about **60 per hour**, with a stall until someone taps the prompt.
   - The system detects this (`LIMIT_EXCEEDED`), pauses the phone and alerts you.
2. **Message length.**
   - 161–306 GSM characters is 2 segments, so twice the airtime and twice the carrier volume.
   - One emoji or curly quote switches to Unicode: 70 characters per SMS.
   - The composer shows this live.
3. **Sending windows, rest periods and budgets** you configure.
4. **Carrier fair-use rules.**
   - Bursts from a consumer SIM can be throttled or blocked.
   - Start slow (6–10 s), watch the failure rate, and talk to the carrier before speeding up.
5. **Delivery reports.** Some carriers don't send them, or send them late. That doesn't slow sending, but it limits what can be *confirmed*.

## Several phones

Every phone takes work from the same queue, and no message is ever leased to two phones (tested). Two phones with two SIMs roughly double throughput. The daily segment budget covers all phones together.

## Estimated completion time

The dashboard estimates the remaining time from submissions **measured over the last 15 minutes**, and labels it as an estimate. Pauses, closed windows, rest periods and budgets are not included in the estimate.

## Storage (Neon free tier, 0.5 GB)

Each recipient message, with its attempt, part results and delivery report, uses roughly 1–2 KB including indexes. That is about 6–12 MB per 6,000-recipient campaign, so on the order of 40–80 campaigns. Lower **Settings → Data retention → Finished messages** to keep within the limit.

## Recommended pilot

1. Send 20–50 messages to consenting colleagues at the default pace.
2. Record:
   - actual messages per hour (shown on the campaign page);
   - failure codes;
   - the share of delivery reports received;
   - whether Android asked for confirmation.
3. Set `send_interval_ms`, the daily budget and the windows from what you observed.
