/** Themes and color resolution (scheme colors, color map, tints, shades, alpha). */
import type { Color, Master, SchemeColor, Theme } from './types';

export const SCHEME_KEYS: SchemeColor[] = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];

/** Original theme palettes (not copies of any vendor's themes). */
export const THEME_PRESETS: { name: string; colors: Record<SchemeColor, string>; fonts: { major: string; minor: string }; bg?: string }[] = [
  { name: 'Quill', colors: { dk1: '#000000', lt1: '#FFFFFF', dk2: '#3A2418', lt2: '#F3EDE8', accent1: '#C2502A', accent2: '#2F6F8F', accent3: '#7A9A3A', accent4: '#D9A21B', accent5: '#6B4E9B', accent6: '#3F8F7A', hlink: '#2F6F8F', folHlink: '#6B4E9B' }, fonts: { major: 'Carlito', minor: 'Carlito' } },
  { name: 'Paper', colors: { dk1: '#1F1F1F', lt1: '#FFFFFF', dk2: '#2D3A4A', lt2: '#EEF1F4', accent1: '#3B6EA8', accent2: '#E07B39', accent3: '#5B9A68', accent4: '#C9A227', accent5: '#8E5BA6', accent6: '#C24B4B', hlink: '#3B6EA8', folHlink: '#8E5BA6' }, fonts: { major: 'Libre Baskerville', minor: 'Open Sans' } },
  { name: 'Slate', colors: { dk1: '#000000', lt1: '#FFFFFF', dk2: '#20262E', lt2: '#DDE3EA', accent1: '#4FA3D9', accent2: '#F2B544', accent3: '#7CC47F', accent4: '#E86A5C', accent5: '#A78BD9', accent6: '#5CC8C0', hlink: '#7FC4F0', folHlink: '#C9B3F0' }, fonts: { major: 'Arimo', minor: 'Arimo' }, bg: 'dk2' },
  { name: 'Meadow', colors: { dk1: '#1B2A1B', lt1: '#FFFFFF', dk2: '#2E4A2E', lt2: '#EEF4E8', accent1: '#4E8A3E', accent2: '#B5832E', accent3: '#3E7A8A', accent4: '#9A4E6B', accent5: '#7A7A2E', accent6: '#2E6B5A', hlink: '#3E7A8A', folHlink: '#9A4E6B' }, fonts: { major: 'Merriweather', minor: 'Lato' } },
  { name: 'Studio', colors: { dk1: '#111111', lt1: '#FFFFFF', dk2: '#111111', lt2: '#F5F5F5', accent1: '#E63946', accent2: '#1D3557', accent3: '#457B9D', accent4: '#F4A261', accent5: '#2A9D8F', accent6: '#8D99AE', hlink: '#457B9D', folHlink: '#1D3557' }, fonts: { major: 'Open Sans', minor: 'Open Sans' } },
  { name: 'Archive', colors: { dk1: '#2B2118', lt1: '#FFFDF7', dk2: '#4A3B2A', lt2: '#F2E8D5', accent1: '#8C5A2B', accent2: '#5A6B3B', accent3: '#3B5A6B', accent4: '#A6763B', accent5: '#6B3B4A', accent6: '#7A6B5A', hlink: '#3B5A6B', folHlink: '#6B3B4A' }, fonts: { major: 'EB Garamond', minor: 'Gelasio' } },
];

export function defaultTheme(id = 'theme1', preset = 0): Theme {
  const p = THEME_PRESETS[preset] || THEME_PRESETS[0];
  return { id, name: p.name, colors: { ...p.colors }, fonts: { ...p.fonts } };
}

const ALIAS: Record<string, string> = { tx1: 'dk1', bg1: 'lt1', tx2: 'dk2', bg2: 'lt2' };

export function hexToRgb(hex: string): [number, number, number] {
  let s = hex.replace('#', '').trim();
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  const n = parseInt(s.slice(0, 6), 16);
  if (!Number.isFinite(n)) return [0, 0, 0];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`.toUpperCase();
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

/** Lightens (amount > 0, toward white) or darkens (amount < 0, toward black) by changing luminance. */
export function adjustLum(hex: string, amount: number): string {
  const [h, s, l] = rgbToHsl(...hexToRgb(hex));
  const nl = amount >= 0 ? l + (1 - l) * amount : l * (1 + amount);
  return rgbToHex(...hslToRgb(h, s, nl));
}

export interface ColorContext { theme: Theme; master?: Master; /** Placeholder color from a style reference. */ phClr?: string }

/** Resolves a model color to '#RRGGBB' plus alpha. */
export function resolveColor(c: Color | undefined, ctx: ColorContext, fallback = '#000000'): { hex: string; alpha: number } {
  if (c == null) return { hex: fallback, alpha: 1 };
  if (typeof c === 'string') return { hex: schemeHex(c, ctx) || fallback, alpha: 1 };
  let hex = schemeHex(c.s, ctx) || fallback;
  if (c.lum && Number.isFinite(+c.lum)) hex = adjustLum(hex, +c.lum);
  const a = Number(c.alpha ?? 1);
  return { hex, alpha: Number.isFinite(a) ? Math.max(0, Math.min(1, a)) : 1 };
}

/** Only '#RGB' to '#RRGGBBAA' hex colors are accepted from data (they are interpolated into markup). */
export const HEX_RE = /^#[0-9a-f]{3,8}$/i;
export function safeHex(v: unknown): string | null {
  return typeof v === 'string' && HEX_RE.test(v.trim()) ? v.trim().toUpperCase() : null;
}

function schemeHex(name: string, ctx: ColorContext): string | null {
  if (typeof name !== 'string') return null;
  if (name.startsWith('#')) return name.length === 7 || name.length === 4 ? safeHex(name) : null;
  if (name === 'phClr') return safeHex(ctx.phClr);
  let key = name;
  if (ALIAS[key]) key = (ctx.master?.clrMap as any)?.[key] || ALIAS[key];
  if (!Object.prototype.hasOwnProperty.call(ctx.theme.colors || {}, key)) return null;
  const v = (ctx.theme.colors as any)[key];
  const hex = safeHex(v);
  // Theme values without '#' (older files) are accepted when they are plain hex.
  return hex || (typeof v === 'string' && /^[0-9a-f]{6}$/i.test(v) ? `#${v.toUpperCase()}` : null);
}

/** CSS rgba() or hex for a resolved color. */
export function cssColor(c: Color | undefined, ctx: ColorContext, fallback = '#000000'): string {
  const { hex, alpha } = resolveColor(c, ctx, fallback);
  if (alpha >= 1) return hex;
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${+alpha.toFixed(3)})`;
}

/** Relative luminance (WCAG). */
export function luminance(hex: string): number {
  const ch = hexToRgb(hex).map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The tint/shade rows shown in color menus: [lum] per row. */
export const TINT_ROWS = [0, 0.8, 0.6, 0.4, -0.25, -0.5];

/** Resolves a theme font reference (+mj-lt / +mn-lt) to a family name. */
export function themeFont(font: string | undefined, theme: Theme): string | undefined {
  if (!font) return font;
  if (font === '+mj-lt' || font === '+mj-ea' || font === '+mj-cs') return theme.fonts.major;
  if (font === '+mn-lt' || font === '+mn-ea' || font === '+mn-cs') return theme.fonts.minor;
  return font;
}
