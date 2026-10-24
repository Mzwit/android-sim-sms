/**
 * Minimal, safe SMS personalisation.
 *
 *   "Hello {{first_name|Member}}, your ref is {{reference_no}}."
 *
 * Only whitelisted fields can be used. A field may have a fallback after "|".
 * Rendering never evaluates code. Unknown fields are rejected when the
 * campaign is saved, so they can never reach a recipient as raw braces.
 */
export const TEMPLATE_FIELDS = ['first_name', 'last_name', 'full_name', 'reference_no'] as const;
export type TemplateField = (typeof TEMPLATE_FIELDS)[number];

const TOKEN = /\{\{\s*([a-z_]+)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g;

export interface TemplateIssue {
  field: string;
  problem: 'UNKNOWN_FIELD' | 'UNBALANCED_BRACES';
}

export function validateTemplate(template: string): { fields: TemplateField[]; issues: TemplateIssue[] } {
  const fields = new Set<TemplateField>();
  const issues: TemplateIssue[] = [];
  for (const m of template.matchAll(TOKEN)) {
    const f = m[1]!;
    if ((TEMPLATE_FIELDS as readonly string[]).includes(f)) fields.add(f as TemplateField);
    else issues.push({ field: f, problem: 'UNKNOWN_FIELD' });
  }
  const leftover = template.replace(TOKEN, '');
  if (leftover.includes('{{') || leftover.includes('}}')) issues.push({ field: '', problem: 'UNBALANCED_BRACES' });
  return { fields: [...fields], issues };
}

export interface TemplateContact {
  first_name?: string | null;
  last_name?: string | null;
  reference_no?: string | null;
}

export interface RenderResult {
  text: string;
  /** Fields that were empty and had no fallback (rendered as empty string). */
  missing: TemplateField[];
}

export function renderTemplate(template: string, c: TemplateContact): RenderResult {
  const missing = new Set<TemplateField>();
  const values: Record<TemplateField, string> = {
    first_name: (c.first_name ?? '').trim(),
    last_name: (c.last_name ?? '').trim(),
    full_name: [c.first_name, c.last_name].map((s) => (s ?? '').trim()).filter(Boolean).join(' '),
    reference_no: (c.reference_no ?? '').trim(),
  };
  const text = template.replace(TOKEN, (_all, f: string, fallback?: string) => {
    const v = values[f as TemplateField];
    if (v === undefined) return _all; // unknown fields are blocked by validateTemplate
    if (v) return v;
    if (fallback !== undefined && fallback !== '') return fallback;
    missing.add(f as TemplateField);
    return '';
  });
  // Collapse doubled spaces left by empty fields, but keep line breaks.
  return { text: text.replace(/[ \t]{2,}/g, ' ').replace(/ +([,.!?])/g, '$1').trim(), missing: [...missing] };
}
