# Campaign report

The dashboard produces this report automatically: open the campaign and click **Printable report** (print or save as PDF), or **Download CSV** for the per-recipient results. This template lists the fields and how to read them, so the report can be filed or reviewed consistently.

| Field | Value |
|---|---|
| Campaign | |
| Purpose / consent basis | |
| Created by / on | |
| Approved by / on | |
| Started / finished | |
| Message text (as approved) | |

## Results

| Measure | Count | Meaning |
|---|---|---|
| Intended recipients | | Everyone in the selected groups |
| Excluded: invalid number | | Not sent |
| Excluded: opted out | | Not sent |
| Excluded: no consent | | Not sent |
| Excluded: same number twice | | Sent once only |
| Submitted to the network | | Android reported every part handed to the network |
| Confirmed delivered | | The network returned a delivery report for every part |
| Submitted, no delivery report | | Delivery not confirmed (many networks send no reports) |
| Reconciled as sent | | Outcome was unknown; an administrator recorded it as sent (inferred) |
| Failed | | Rejected, undeliverable, or temporary failures after all retries |
| Unknown | | May or may not have been sent; listed, not hidden |
| Cancelled | | Opted out / consent withdrawn / campaign cancelled before sending |
| SMS segments submitted | | Billable units |
| Estimated cost | | Segments × configured cost; the carrier bill is authoritative |
| Automatic / manual retries | | |

## Review

- Problems observed (top error codes):
- Unknown outcomes reconciled? (yes / no, by whom):
- Opt-outs received during the campaign:
- Reviewed by / date:
