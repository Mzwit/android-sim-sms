import {
  parsePhoneNumberFromString,
  getCountryCallingCode,
  isSupportedCountry,
  type CountryCode,
} from 'libphonenumber-js/max';

export type PhoneErrorCode =
  | 'EMPTY'
  | 'INVALID_CHARACTERS'
  | 'UNPARSEABLE'
  | 'INVALID_NUMBER'
  | 'NOT_MOBILE';

export type PhoneResult =
  | { ok: true; e164: string; country?: string; type: string; nationalFormat: string }
  | { ok: false; error: PhoneErrorCode; message: string };

const ALLOWED = /^[0-9+\-().\s/]+$/;

// Number types that can normally receive SMS. Some countries do not
// distinguish mobile from fixed lines, so FIXED_LINE_OR_MOBILE is accepted.
const SMS_TYPES = new Set(['MOBILE', 'FIXED_LINE_OR_MOBILE', 'PERSONAL_NUMBER']);

export function isValidCountry(code: string): code is CountryCode {
  return isSupportedCountry(code as CountryCode);
}

/**
 * Normalise a human-entered phone number to E.164.
 *
 * Rules:
 *  - Only digits, spaces, + - ( ) . / are accepted; anything else is rejected,
 *    never stripped, so typos like "7612O456" (letter O) are reported.
 *  - National numbers are interpreted with defaultCountry (Eswatini = SZ, +268).
 *  - "00" international prefix and a bare country code without "+" are accepted.
 *  - The number must be valid for its country and of an SMS-capable type
 *    unless allowNonMobile is set.
 */
export function normalizePhone(
  raw: string | null | undefined,
  defaultCountry: string = 'SZ',
  opts: { allowNonMobile?: boolean } = {},
): PhoneResult {
  const input = (raw ?? '').trim();
  if (!input) return { ok: false, error: 'EMPTY', message: 'Phone number is empty' };
  if (!ALLOWED.test(input)) {
    return { ok: false, error: 'INVALID_CHARACTERS', message: 'Phone number contains letters or symbols' };
  }
  if ((input.match(/\+/g) ?? []).length > 1 || (input.includes('+') && !/^\(?\+/.test(input))) {
    return { ok: false, error: 'INVALID_CHARACTERS', message: '"+" may only appear at the start' };
  }
  const hasPlus = input.includes('+');
  const country = isValidCountry(defaultCountry) ? defaultCountry : undefined;
  const digits = input.replace(/\D/g, '');

  const candidates: string[] = [hasPlus ? '+' + digits : input];
  if (!hasPlus) {
    if (digits.startsWith('00')) candidates.push('+' + digits.slice(2));
    // A number written with its country code but no "+", e.g. 26876123456.
    if (country) {
      const cc = getCountryCallingCode(country);
      if (digits.startsWith(cc)) candidates.push('+' + digits);
    }
  }

  let firstParsed: ReturnType<typeof parsePhoneNumberFromString> | undefined;
  for (const c of candidates) {
    const parsed = parsePhoneNumberFromString(c, country);
    if (!parsed) continue;
    firstParsed ??= parsed;
    if (!parsed.isValid()) continue;
    const type = parsed.getType() ?? 'UNKNOWN';
    if (!opts.allowNonMobile && type !== 'UNKNOWN' && !SMS_TYPES.has(type)) {
      return {
        ok: false,
        error: 'NOT_MOBILE',
        message: `Number is a ${type.toLowerCase().replace(/_/g, ' ')} number and cannot normally receive SMS`,
      };
    }
    return {
      ok: true,
      e164: parsed.number,
      country: parsed.country,
      type,
      nationalFormat: parsed.formatNational(),
    };
  }
  if (!firstParsed) return { ok: false, error: 'UNPARSEABLE', message: 'Could not interpret as a phone number' };
  return {
    ok: false,
    error: 'INVALID_NUMBER',
    message: `Not a valid number for ${firstParsed.country ?? 'the detected country'} (check digit count)`,
  };
}

/** Mask the middle of an E.164 number: +26876123456 -> +2687******56 */
export function maskPhone(e164: string | null | undefined): string | null {
  if (!e164) return null;
  if (e164.length <= 7) return e164.replace(/\d(?=\d{2})/g, '*');
  const keepStart = 5; // "+268" + first national digit
  const keepEnd = 2;
  return e164.slice(0, keepStart) + '*'.repeat(e164.length - keepStart - keepEnd) + e164.slice(-keepEnd);
}
