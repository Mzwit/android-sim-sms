import type { Queryable } from '../db.js';
import { analyzeSms, type Encoding } from '../lib/segments.js';
import { renderTemplate } from '../lib/template.js';

export type ExclusionReason = 'INVALID_NUMBER' | 'SUPPRESSED' | 'NO_CONSENT' | 'DUPLICATE_NUMBER' | 'OVER_LIMIT';

export interface CandidateRow {
  contact_id: string;
  phone_e164: string | null;
  first_name: string | null;
  last_name: string | null;
  reference_no: string | null;
  is_valid: boolean;
  suppressed: boolean;
  consent: 'GRANTED' | 'WITHDRAWN' | null;
}

export interface EvaluatedRecipient {
  contactId: string;
  phoneE164: string | null;
  decision: 'INCLUDED' | 'EXCLUDED';
  exclusionReason?: ExclusionReason;
  renderedBody?: string;
  encoding?: Encoding;
  segments?: number;
  missingFields?: string[];
}

/**
 * Candidate contacts from the selected groups, with the facts needed to decide
 * eligibility. Consent: the latest record for the campaign's purpose wins; if
 * there is none, the latest 'general' record applies. No record at all = no consent.
 */
export const CANDIDATES_SQL = `
WITH members AS (
  SELECT DISTINCT gm.contact_id FROM group_memberships gm WHERE gm.group_id = ANY($1::uuid[])
)
SELECT c.id AS contact_id, c.phone_e164, c.first_name, c.last_name, c.reference_no, c.is_valid,
       EXISTS (SELECT 1 FROM suppressions s WHERE s.phone_e164 = c.phone_e164 AND s.lifted_at IS NULL) AS suppressed,
       coalesce(
         (SELECT cr.status FROM consent_records cr WHERE cr.contact_id = c.id AND cr.purpose = $2
           ORDER BY cr.effective_at DESC, cr.recorded_at DESC LIMIT 1),
         (SELECT cr.status FROM consent_records cr WHERE cr.contact_id = c.id AND cr.purpose = 'general'
           ORDER BY cr.effective_at DESC, cr.recorded_at DESC LIMIT 1)
       ) AS consent
  FROM members m JOIN contacts c ON c.id = m.contact_id
 WHERE c.deleted_at IS NULL
 ORDER BY c.created_at, c.id`;

export async function loadCandidates(q: Queryable, groupIds: string[], purpose: string): Promise<CandidateRow[]> {
  const { rows } = await q.query<CandidateRow>(CANDIDATES_SQL, [groupIds, purpose]);
  return rows;
}

/** Pure decision function, unit-testable without a database. Order of checks is significant. */
export function evaluateRecipients(rows: CandidateRow[], template: string, maxRecipients: number): EvaluatedRecipient[] {
  const seenPhones = new Set<string>();
  let included = 0;
  return rows.map((r) => {
    const base = { contactId: r.contact_id, phoneE164: r.phone_e164 };
    if (!r.is_valid || !r.phone_e164) return { ...base, decision: 'EXCLUDED', exclusionReason: 'INVALID_NUMBER' };
    if (r.suppressed) return { ...base, decision: 'EXCLUDED', exclusionReason: 'SUPPRESSED' };
    if (r.consent !== 'GRANTED') return { ...base, decision: 'EXCLUDED', exclusionReason: 'NO_CONSENT' };
    if (seenPhones.has(r.phone_e164)) return { ...base, decision: 'EXCLUDED', exclusionReason: 'DUPLICATE_NUMBER' };
    if (included >= maxRecipients) return { ...base, decision: 'EXCLUDED', exclusionReason: 'OVER_LIMIT' };
    seenPhones.add(r.phone_e164);
    included++;
    const rendered = renderTemplate(template, r);
    const seg = analyzeSms(rendered.text);
    return {
      ...base,
      decision: 'INCLUDED',
      renderedBody: rendered.text,
      encoding: seg.encoding,
      segments: seg.segments,
      missingFields: rendered.missing,
    };
  });
}

export interface EligibilitySummary {
  candidates: number;
  included: number;
  excluded: Record<ExclusionReason, number>;
  segmentsTotal: number;
  maxSegmentsPerMessage: number;
  encodings: Record<Encoding, number>;
  recipientsWithMissingFields: number;
}

export function summarize(evaluated: EvaluatedRecipient[]): EligibilitySummary {
  const s: EligibilitySummary = {
    candidates: evaluated.length,
    included: 0,
    excluded: { INVALID_NUMBER: 0, SUPPRESSED: 0, NO_CONSENT: 0, DUPLICATE_NUMBER: 0, OVER_LIMIT: 0 },
    segmentsTotal: 0,
    maxSegmentsPerMessage: 0,
    encodings: { GSM7: 0, UCS2: 0 },
    recipientsWithMissingFields: 0,
  };
  for (const e of evaluated) {
    if (e.decision === 'EXCLUDED') {
      s.excluded[e.exclusionReason!]++;
      continue;
    }
    s.included++;
    s.segmentsTotal += e.segments!;
    s.maxSegmentsPerMessage = Math.max(s.maxSegmentsPerMessage, e.segments!);
    s.encodings[e.encoding!]++;
    if (e.missingFields?.length) s.recipientsWithMissingFields++;
  }
  return s;
}
