/**
 * SMS encoding and segment calculation (3GPP TS 23.038).
 *
 * GSM-7: 160 septets single / 153 per part when concatenated (UDH takes 7).
 *        Characters from the extension table (e.g. € [ ] { } ~ ^ \ |) cost 2 septets
 *        and an escape+char pair is never split across parts.
 * UCS-2: 70 code units single / 67 per part. Characters outside the BMP (most
 *        emoji) take 2 UTF-16 code units, and a surrogate pair is never split.
 *
 * This matches how Android's SmsManager.divideMessage() splits text when the
 * national language shift tables are not used (the default on most carriers).
 */

const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\u001bÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXT = '\f^{}\\[~]|€';

const BASIC = new Set(Array.from(GSM7_BASIC).filter((c) => c !== '\u001b'));
const EXT = new Set(Array.from(GSM7_EXT));

export type Encoding = 'GSM7' | 'UCS2';

export interface SegmentInfo {
  encoding: Encoding;
  /** Septets (GSM7) or UTF-16 code units (UCS2) */
  units: number;
  characters: number;
  segments: number;
  perSegment: number;
  /** Units left in the last segment before another segment is needed */
  remainingInLast: number;
  /** Characters that forced UCS-2, de-duplicated, in order of appearance */
  nonGsmCharacters: string[];
}

export const MAX_SEGMENTS = 10;

export function analyzeSms(text: string): SegmentInfo {
  const chars = Array.from(text); // code points
  const nonGsm: string[] = [];
  let septets = 0;
  for (const c of chars) {
    if (BASIC.has(c)) septets += 1;
    else if (EXT.has(c)) septets += 2;
    else if (!nonGsm.includes(c)) nonGsm.push(c);
  }

  if (nonGsm.length === 0) {
    const segments = gsmSegments(chars);
    const perSegment = segments <= 1 ? 160 : 153;
    return {
      encoding: 'GSM7',
      units: septets,
      characters: chars.length,
      segments,
      perSegment,
      remainingInLast: remaining(septets, segments, 160, 153),
      nonGsmCharacters: [],
    };
  }

  const units = text.length; // UTF-16 code units
  const segments = ucs2Segments(chars);
  const perSegment = segments <= 1 ? 70 : 67;
  return {
    encoding: 'UCS2',
    units,
    characters: chars.length,
    segments,
    perSegment,
    remainingInLast: remaining(units, segments, 70, 67),
    nonGsmCharacters: nonGsm,
  };
}

function gsmSegments(chars: string[]): number {
  let total = 0;
  for (const c of chars) total += EXT.has(c) ? 2 : 1;
  if (total === 0) return 1;
  if (total <= 160) return 1;
  // Greedy fill of 153-septet parts, never splitting an escape pair.
  let parts = 1;
  let used = 0;
  for (const c of chars) {
    const w = EXT.has(c) ? 2 : 1;
    if (used + w > 153) {
      parts++;
      used = 0;
    }
    used += w;
  }
  return parts;
}

function ucs2Segments(chars: string[]): number {
  let total = 0;
  for (const c of chars) total += c.length;
  if (total <= 70) return 1;
  let parts = 1;
  let used = 0;
  for (const c of chars) {
    const w = c.length; // 1 or 2 (surrogate pair)
    if (used + w > 67) {
      parts++;
      used = 0;
    }
    used += w;
  }
  return parts;
}

function remaining(units: number, segments: number, single: number, multi: number): number {
  if (segments <= 1) return Math.max(0, single - units);
  const capacity = segments * multi;
  return Math.max(0, capacity - units);
}

/** Estimated cost for N recipients, rounded to cents. */
export function estimateCost(segmentsTotal: number, costPerSegment: number): number {
  return Math.round(segmentsTotal * costPerSegment * 100) / 100;
}
