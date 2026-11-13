/**
 * HTML and URL sanitizing for document-controlled content.
 *
 * Documents come from anywhere (DOCX/HTML/EPUB/.qgw imports, the clipboard), and on Android
 * the WebView origin can reach the native bridge, so any string from a document that ends up
 * in innerHTML or navigation must pass through here.
 */

/** Schemes Anne's Stage will hand to the system browser or mail/phone apps. */
const SAFE_SCHEMES = /^(https?|mailto|tel|ftp|sms|geo):/i;

export function isSafeExternalUrl(url: string): boolean {
  const u = url.trim();
  return SAFE_SCHEMES.test(u);
}

/** Characters that are not allowed in XML 1.0 (SVG parsed as XML fails on them). */
const XML_ILLEGAL = /[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g;

/** Escape text for XML/SVG content and quoted attribute values, dropping XML-illegal characters. */
export function escXml(s: unknown): string {
  return String(s ?? '').replace(XML_ILLEGAL, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Escape text for HTML element content and quoted attribute values. */
export function escHtml(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** A CSS color from document data, or the fallback when it is not a plain color value. */
export function safeColor(c: unknown, fallback = '#000000'): string {
  const s = String(c ?? '');
  return /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%deg]+\)|[a-z]{3,20})$/i.test(s) ? s : fallback;
}

/** A finite number from document data, clamped. */
export function safeNum(v: unknown, fallback: number, min = -1e6, max = 1e6): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/**
 * One CSS property value from document data ("1px solid #444", "35%", "var(--ql-accent1)"), or
 * null. No ; : quotes, slashes or braces, so it cannot add declarations or rules, and only
 * var/calc/color functions, so it cannot load anything.
 */
export function safeCssValue(v: unknown, max = 120): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).trim();
  if (!s || s.length > max || !/^[#\w\s.,%()+-]+$/.test(s)) return null;
  for (const m of s.matchAll(/([\w-]*)\s*\(/g)) if (!/^(var|calc|rgba?|hsla?)$/i.test(m[1])) return null;
  return s;
}
