import { describe, expect, it } from 'vitest';
import { maskPhone, normalizePhone } from '../src/lib/phone.js';
import { analyzeSms, estimateCost } from '../src/lib/segments.js';
import { renderTemplate, validateTemplate } from '../src/lib/template.js';
import { evaluateRecipients, summarize, type CandidateRow } from '../src/services/eligibility.js';
import { checkPasswordPolicy } from '../src/auth/password.js';
import { stableStringify } from '../src/lib/crypto.js';

describe('phone normalisation (Eswatini default +268)', () => {
  it.each([
    ['76123456', '+26876123456'],
    ['7612 3456', '+26876123456'],
    ['+268 7612 3456', '+26876123456'],
    ['(+268) 7612-3456', '+26876123456'],
    ['0026876123456', '+26876123456'],
    ['26876123456', '+26876123456'],
    ['78123456', '+26878123456'],
    ['79123456', '+26879123456'],
    ['+27 82 123 4567', '+27821234567'],
  ])('accepts %s -> %s', (input, e164) => {
    const r = normalizePhone(input, 'SZ');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.e164).toBe(e164);
  });

  it.each([
    ['', 'EMPTY'],
    ['   ', 'EMPTY'],
    ['7612O456', 'INVALID_CHARACTERS'], // letter O, not zero: reported, never "fixed"
    ['76123456 ext 2', 'INVALID_CHARACTERS'],
    ['76+123456', 'INVALID_CHARACTERS'],
    ['7612345', 'INVALID_NUMBER'], // 7 digits
    ['761234567', 'INVALID_NUMBER'], // 9 digits
    ['0821234567', 'INVALID_NUMBER'], // SA national format without +27 is not an SZ number
    ['22404000', 'NOT_MOBILE'], // Eswatini fixed line
  ])('rejects %j with %s', (input, code) => {
    const r = normalizePhone(input, 'SZ');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(code);
  });

  it('allows fixed lines only when explicitly requested (opt-out handling)', () => {
    expect(normalizePhone('22404000', 'SZ', { allowNonMobile: true }).ok).toBe(true);
  });

  it('respects a different default country', () => {
    const r = normalizePhone('0821234567', 'ZA');
    expect(r.ok && r.e164).toBe('+27821234567');
  });

  it('masks the middle of numbers', () => {
    expect(maskPhone('+26876123456')).toBe('+2687*****56');
    expect(maskPhone(null)).toBeNull();
  });
});

describe('SMS segment calculation', () => {
  it('GSM-7 single and multipart boundaries (160 / 153)', () => {
    expect(analyzeSms('a'.repeat(160))).toMatchObject({ encoding: 'GSM7', segments: 1, perSegment: 160 });
    expect(analyzeSms('a'.repeat(161))).toMatchObject({ encoding: 'GSM7', segments: 2, perSegment: 153 });
    expect(analyzeSms('a'.repeat(306)).segments).toBe(2);
    expect(analyzeSms('a'.repeat(307)).segments).toBe(3);
  });

  it('extension characters cost two septets and are not split across parts', () => {
    expect(analyzeSms('€'.repeat(80))).toMatchObject({ encoding: 'GSM7', units: 160, segments: 1 });
    expect(analyzeSms('€'.repeat(81)).segments).toBe(2);
    // 152 plain + one escape pair = 154 septets: the pair moves to part 2
    expect(analyzeSms('a'.repeat(152) + '[' + 'a'.repeat(10)).segments).toBe(2);
  });

  it('a single non-GSM character switches the whole message to UCS-2 (70 / 67)', () => {
    const r = analyzeSms('Sawubona ŝ');
    expect(r.encoding).toBe('UCS2');
    expect(r.nonGsmCharacters).toEqual(['ŝ']);
    expect(analyzeSms('ŝ'.repeat(70)).segments).toBe(1);
    expect(analyzeSms('ŝ'.repeat(71)).segments).toBe(2);
    expect(analyzeSms('ŝ'.repeat(134)).segments).toBe(2);
    expect(analyzeSms('ŝ'.repeat(135)).segments).toBe(3);
  });

  it('emoji take two UTF-16 units and surrogate pairs are never split', () => {
    const r = analyzeSms('😀'.repeat(35));
    expect(r).toMatchObject({ encoding: 'UCS2', units: 70, characters: 35, segments: 1 });
    // 66 units + one emoji (2 units) = 68 > 67 per part: the emoji starts part 2
    expect(analyzeSms('ŝ'.repeat(66) + '😀' + 'ŝ'.repeat(3)).segments).toBe(2);
  });

  it('siSwati and English text without special characters stays GSM-7', () => {
    expect(analyzeSms('Sawubona Sipho, umhlangano wakusasa ngu 10:00 eHholo. Siyabonga!').encoding).toBe('GSM7');
  });

  it('typographic quotes force UCS-2 and are reported', () => {
    expect(analyzeSms('It’s “today”').nonGsmCharacters).toEqual(['’', '“', '”']);
  });

  it('empty text is one segment', () => {
    expect(analyzeSms('').segments).toBe(1);
  });

  it('estimates cost', () => {
    expect(estimateCost(12000, 0.45)).toBe(5400);
  });
});

describe('templates', () => {
  it('validates fields', () => {
    expect(validateTemplate('Hi {{first_name|Member}} ref {{reference_no}}').issues).toEqual([]);
    expect(validateTemplate('Hi {{password}}').issues[0]).toMatchObject({ field: 'password', problem: 'UNKNOWN_FIELD' });
    expect(validateTemplate('Hi {{first_name').issues[0]?.problem).toBe('UNBALANCED_BRACES');
  });

  it('renders with fallbacks and reports missing values', () => {
    expect(renderTemplate('Hi {{first_name|Member}}!', { first_name: '' }).text).toBe('Hi Member!');
    const r = renderTemplate('Hi {{first_name}}, ref {{reference_no}}.', { first_name: null, reference_no: 'A1' });
    expect(r.text).toBe('Hi, ref A1.');
    expect(r.missing).toEqual(['first_name']);
    expect(renderTemplate('{{full_name}}', { first_name: 'Sipho', last_name: 'Dlamini' }).text).toBe('Sipho Dlamini');
  });

  it('does not interpret contact data as template syntax', () => {
    expect(renderTemplate('Hi {{first_name}}', { first_name: '{{reference_no}}', reference_no: 'X' }).text).toBe('Hi {{reference_no}}');
  });
});

describe('recipient eligibility', () => {
  const row = (o: Partial<CandidateRow>): CandidateRow => ({
    contact_id: Math.random().toString(36),
    phone_e164: '+26876000001',
    first_name: 'A',
    last_name: 'B',
    reference_no: null,
    is_valid: true,
    suppressed: false,
    consent: 'GRANTED',
    ...o,
  });

  it('excludes invalid, suppressed, unconsented, duplicate and over-limit recipients in that order', () => {
    const rows = [
      row({ phone_e164: '+26876000001' }),
      row({ phone_e164: null, is_valid: false }),
      row({ phone_e164: '+26876000002', suppressed: true, consent: 'GRANTED' }),
      row({ phone_e164: '+26876000003', consent: null }),
      row({ phone_e164: '+26876000004', consent: 'WITHDRAWN' }),
      row({ phone_e164: '+26876000001' }), // same number as first
      row({ phone_e164: '+26876000005' }),
      row({ phone_e164: '+26876000006' }), // over limit of 2
    ];
    const ev = evaluateRecipients(rows, 'Hello {{first_name}}', 2);
    expect(ev.map((e) => e.exclusionReason ?? 'IN')).toEqual([
      'IN', 'INVALID_NUMBER', 'SUPPRESSED', 'NO_CONSENT', 'NO_CONSENT', 'DUPLICATE_NUMBER', 'IN', 'OVER_LIMIT',
    ]);
    const s = summarize(ev);
    expect(s).toMatchObject({ candidates: 8, included: 2, segmentsTotal: 2 });
    expect(s.excluded).toEqual({ INVALID_NUMBER: 1, SUPPRESSED: 1, NO_CONSENT: 2, DUPLICATE_NUMBER: 1, OVER_LIMIT: 1 });
  });

  it('suppression wins over consent', () => {
    const [e] = evaluateRecipients([row({ suppressed: true, consent: 'GRANTED' })], 'x', 10);
    expect(e!.exclusionReason).toBe('SUPPRESSED');
  });
});

describe('misc', () => {
  it('password policy', () => {
    expect(checkPasswordPolicy('short').ok).toBe(false);
    expect(checkPasswordPolicy('aaaaaaaaaaaaaaaa').ok).toBe(false);
    expect(checkPasswordPolicy('mypassword123456').ok).toBe(false);
    expect(checkPasswordPolicy('sipho.dlamini.2026', 'sipho.dlamini@x.org').ok).toBe(false);
    expect(checkPasswordPolicy('Lilangeni-Sunrise-42').ok).toBe(true);
  });

  it('stable JSON ignores key order', () => {
    expect(stableStringify({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(stableStringify({ a: [2, { c: 2, d: 1 }], b: 1 }));
  });
});
