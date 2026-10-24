/**
 * CSV output that is safe to open in Excel.
 * Cells starting with = + - @ TAB CR are prefixed with ' to prevent formula
 * injection (OWASP). Validated E.164 numbers (+ followed by digits only) are
 * exempt, as they cannot carry a formula.
 */
const E164 = /^\+[0-9]{7,15}$/;

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString() : Array.isArray(v) ? v.join(';') : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !E164.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function csvRow(values: unknown[]): string {
  return values.map(csvCell).join(',') + '\r\n';
}

/** UTF-8 BOM so Excel detects UTF-8 (siSwati names, Unicode messages). */
export const CSV_BOM = '﻿';
