import { n } from '../util';

export interface PipelineCounts {
  pending: number; // queued + with phone + sending
  awaiting: number; // submitted, waiting for (or without) delivery report
  delivered: number;
  failed: number;
  unknown: number;
  cancelled: number;
}

const SEGMENTS: { key: keyof PipelineCounts; label: string; cls: string; help: string }[] = [
  { key: 'delivered', label: 'Delivered', cls: 'seg-delivered', help: 'The network confirmed delivery to the handset.' },
  { key: 'awaiting', label: 'Submitted, not confirmed', cls: 'seg-awaiting', help: 'Handed to the network. No delivery report yet, or none will come.' },
  { key: 'pending', label: 'Still to send', cls: 'seg-pending', help: 'Queued, or with the phone and about to be sent.' },
  { key: 'unknown', label: 'Unknown', cls: 'seg-unknown', help: 'May or may not have been sent. Needs reconciliation before any resend.' },
  { key: 'failed', label: 'Failed', cls: 'seg-failed', help: 'Rejected, or the network reported it undeliverable.' },
  { key: 'cancelled', label: 'Cancelled', cls: 'seg-cancelled', help: 'Not sent: opted out, consent withdrawn, or campaign cancelled.' },
];

/**
 * The message pipeline: one bar per campaign. Hatched segments are uncertain
 * outcomes, so "submitted" never looks the same as "delivered".
 */
export function Pipeline({ counts, total, compact }: { counts: PipelineCounts; total: number; compact?: boolean }) {
  const t = Math.max(1, total);
  return (
    <div className={`pipeline ${compact ? 'pipeline-compact' : ''}`}>
      <div className="pipeline-bar" role="img" aria-label={SEGMENTS.map((s) => `${s.label} ${counts[s.key]}`).join(', ')}>
        {SEGMENTS.map((s) =>
          counts[s.key] > 0 ? <span key={s.key} className={`seg ${s.cls}`} style={{ width: `${(counts[s.key] / t) * 100}%` }} title={`${s.label}: ${n(counts[s.key])}`} /> : null,
        )}
      </div>
      {!compact && (
        <dl className="pipeline-legend">
          {SEGMENTS.map((s) => (
            <div key={s.key} className={counts[s.key] === 0 ? 'is-zero' : ''} title={s.help}>
              <dt>
                <i className={`swatch ${s.cls}`} aria-hidden="true" />
                {s.label}
              </dt>
              <dd>{n(counts[s.key])}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

/** Map a progress/report object from the API to pipeline counts. */
export function toCounts(p: {
  pending?: number;
  submitted?: number;
  confirmed_delivered?: number;
  failed?: number;
  unknown?: number;
  cancelled?: number;
}): PipelineCounts {
  const delivered = p.confirmed_delivered ?? 0;
  return {
    pending: p.pending ?? 0,
    awaiting: Math.max(0, (p.submitted ?? 0) - delivered),
    delivered,
    failed: p.failed ?? 0,
    unknown: p.unknown ?? 0,
    cancelled: p.cancelled ?? 0,
  };
}
