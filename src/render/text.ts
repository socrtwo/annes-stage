/**
 * Text layout for slides. Anne's Stage breaks lines itself (rather than leaving it to the browser) so
 * the edit view, thumbnails, the slide show, PNG and PDF export all break lines in the same places.
 * Widths are measured with a canvas; where no canvas exists (tests, workers without OffscreenCanvas)
 * an average-width estimate is used.
 */
import type { Bullet, LevelStyle, Paragraph, RunProps, NumScheme } from '../model/types';

export interface MeasureFn { (text: string, font: string): number }

let ctx2d: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null | undefined;
const cache = new Map<string, number>();

function getCtx() {
  if (ctx2d !== undefined) return ctx2d;
  ctx2d = null;
  try {
    if (typeof OffscreenCanvas !== 'undefined') ctx2d = new OffscreenCanvas(8, 8).getContext('2d');
    else if (typeof document !== 'undefined' && !/jsdom/i.test(navigator.userAgent)) {
      const c = document.createElement('canvas').getContext('2d');
      // jsdom returns null (or throws) without the canvas package.
      if (c && typeof c.measureText === 'function') ctx2d = c;
    }
  } catch { ctx2d = null; }
  return ctx2d;
}

/** Clears measurements (after web fonts finish loading). */
export function clearMeasureCache(): void { cache.clear(); }

export const measure: MeasureFn = (text, font) => {
  const key = font + '\u0000' + text;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const c = getCtx();
  let w: number;
  if (c) { c.font = font; w = c.measureText(text).width; }
  else {
    const size = parseFloat(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] || '16');
    const bold = /\bbold\b|\b700\b/.test(font);
    w = 0;
    for (const ch of text) w += size * (ch === ' ' ? 0.27 : /[il.,:;'!|]/.test(ch) ? 0.25 : /[mwMW@]/.test(ch) ? 0.82 : /[A-Z]/.test(ch) ? 0.62 : 0.5) * (bold ? 1.05 : 1);
  }
  if (cache.size > 20000) cache.clear();
  cache.set(key, w);
  return w;
};

export interface Seg {
  text: string;
  x: number;
  w: number;
  style: RunProps;
  size: number;
  font: string;
  /** Css font shorthand used for measuring. */
  css: string;
  /** Index of the run in the paragraph. */
  run: number;
}

export interface LaidLine {
  segs: Seg[];
  /** Baseline y relative to the top of the text box. */
  y: number;
  width: number;
  height: number;
  ascent: number;
  para: number;
  first: boolean;
  /** Left of the line's text box (after margins). */
  left: number;
  avail: number;
  bullet?: { text: string; x: number; size: number; font: string; color?: RunProps['color'] };
  align: string;
}

export interface LayoutResult { lines: LaidLine[]; height: number; scale: number; overflow: boolean }

export interface LayoutOptions {
  width: number;
  height: number;
  /** Style per paragraph level (already inherited). */
  styleFor: (level: number) => LevelStyle;
  /** Resolves theme font references. */
  font: (f: string | undefined) => string;
  autofit?: 'none' | 'shrink' | 'resize';
  fontScale?: number;
  lineReduction?: number;
  wrap?: boolean;
  /** Field values: slide number, date. */
  fields?: { slidenum?: string; date?: string };
  measure?: MeasureFn;
}

const cssFont = (st: RunProps, size: number, family: string) => `${st.i ? 'italic ' : ''}${st.b ? 'bold ' : ''}${Math.max(0.5, size)}px "${family}"`;

export function bulletText(b: Bullet | undefined, index: number): string {
  if (!b || b.kind === 'none') return '';
  if (b.kind === 'char') return b.char || '•';
  if (b.kind === 'num') return formatNumber((b.startAt ?? 1) + index, b.scheme || 'arabicPeriod');
  return '■';
}

export function formatNumber(n: number, scheme: NumScheme): string {
  const alpha = (k: number) => { let s = ''; while (k > 0) { k--; s = String.fromCharCode(97 + (k % 26)) + s; k = Math.floor(k / 26); } return s; };
  const roman = (k: number) => { const t: [number, string][] = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]; let s = ''; for (const [v, r] of t) while (k >= v) { s += r; k -= v; } return s; };
  switch (scheme) {
    case 'arabicParenR': return `${n})`;
    case 'arabicPlain': return `${n}`;
    case 'alphaLcPeriod': return `${alpha(n)}.`;
    case 'alphaUcPeriod': return `${alpha(n).toUpperCase()}.`;
    case 'alphaLcParenR': return `${alpha(n)})`;
    case 'romanLcPeriod': return `${roman(n)}.`;
    case 'romanUcPeriod': return `${roman(n).toUpperCase()}.`;
    default: return `${n}.`;
  }
}

/** Lays out paragraphs in a box, shrinking text when autofit is 'shrink' and it overflows. */
export function layoutText(paras: Paragraph[], o: LayoutOptions): LayoutResult {
  const run = (scale: number) => layoutOnce(paras, o, scale);
  let scale = o.fontScale && o.fontScale > 0 ? o.fontScale : 1;
  let r = run(scale);
  if (o.autofit === 'shrink' && !o.fontScale && r.height > o.height + 0.5) {
    let lo = 0.25, hi = 1;
    for (let i = 0; i < 7; i++) {
      const mid = (lo + hi) / 2;
      if (run(mid).height <= o.height) lo = mid; else hi = mid;
    }
    scale = lo;
    r = run(scale);
  }
  return { ...r, scale, overflow: r.height > o.height + 0.5 };
}

function layoutOnce(paras: Paragraph[], o: LayoutOptions, scale: number): Omit<LayoutResult, 'scale' | 'overflow'> {
  const m = o.measure || measure;
  const lines: LaidLine[] = [];
  let y = 0;
  const counters: number[] = [];
  const lnRed = (o.lineReduction || 0) / 100;
  paras.forEach((p, pi) => {
    const st = o.styleFor(p.level);
    const merged = { ...st, ...stripUndef(p) } as LevelStyle & Paragraph;
    const bullet = p.bullet ?? st.bullet;
    // Numbering restarts when a paragraph at a lower level or without numbering intervenes.
    // Empty paragraphs show no bullet and neither take a number nor restart the numbering.
    const hasText = p.runs.some((r) => r.text || r.br || r.field);
    counters.length = Math.max(counters.length, p.level + 1);
    if (hasText) {
      for (let k = p.level + 1; k < counters.length; k++) counters[k] = 0;
      const isNum = bullet?.kind === 'num';
      if (isNum) counters[p.level] = (counters[p.level] || 0) + 1; else counters[p.level] = 0;
    }
    const marL = (merged.marL ?? 0);
    const indent = (merged.indent ?? 0);
    const spBefore = (merged.spaceBefore ?? 0) * scale;
    const spAfter = (merged.spaceAfter ?? 0) * scale;
    const align = merged.align || 'l';
    const baseRun = st.run || {};
    const endSize = ((p.end?.size ?? baseRun.size ?? 18)) * scale;
    // Build tokens: words and spaces with their run style.
    type Tok = { text: string; style: RunProps; size: number; font: string; css: string; run: number; br?: boolean; space: boolean };
    const toks: Tok[] = [];
    p.runs.forEach((r, ri) => {
      const s: RunProps = { ...baseRun, ...stripUndef(r) };
      const size = (s.size ?? 18) * scale * (s.baseline ? 0.67 : 1);
      const fam = o.font(s.font) || 'Carlito';
      const css = cssFont(s, size, fam);
      if (r.br) { toks.push({ text: '', style: s, size, font: fam, css, run: ri, br: true, space: false }); return; }
      let text = r.field === 'slidenum' && o.fields?.slidenum ? o.fields.slidenum : (r.field === 'datetime' || r.field === 'date') && o.fields?.date ? o.fields.date : r.text;
      text = typeof text === 'string' ? text : String(text ?? '');
      if (s.caps === 'all') text = text.toUpperCase();
      // A vertical tab (soft return in PowerPoint text) is a line break.
      text.split('\u000B').forEach((piece, k) => {
        if (k > 0) toks.push({ text: '', style: s, size, font: fam, css, run: ri, br: true, space: false });
        for (const part of piece.split(/(\s+)/)) if (part) toks.push({ text: part, style: s, size, font: fam, css, run: ri, space: /^\s+$/.test(part) });
      });
    });
    const bText = hasText && bullet ? bulletText(bullet, Math.max(0, (counters[p.level] || 1) - 1)) : '';
    const firstSize = toks.find((t) => !t.br)?.size ?? endSize;
    const bSize = (bullet?.size ? bullet.size / 100 : 1) * firstSize;
    const bFont = o.font(bullet?.font) || o.font(baseRun.font) || 'Carlito';
    const bW = bText ? m(bText + ' ', cssFont({}, bSize, bFont)) : 0;
    const bX = Math.max(0, marL + indent);
    // Hanging indent: the bullet sits at marL+indent and the text at marL (pushed right if the bullet is wider).
    const firstLeft = bText ? (indent < 0 ? Math.max(marL, bX + bW) : bX + bW) : bX;
    let lineToks: Tok[] = [];
    let first = true;
    let lineW = 0;
    /** The current line starts after a wrap (not at the paragraph start or a line break). */
    let wrapped = false;
    const left = (fst: boolean) => (fst ? firstLeft : Math.max(0, marL));
    const avail = (fst: boolean) => Math.max(1, o.width - left(fst));
    const flush = () => {
      // Drop trailing spaces from the measured width.
      while (lineToks.length && lineToks[lineToks.length - 1].space) lineToks.pop();
      const sizes = lineToks.filter((t) => !t.br).map((t) => t.size);
      const maxSize = sizes.length ? Math.max(...sizes) : endSize;
      const ascent = maxSize * 0.92;
      const natural = maxSize * 1.2;
      const ls = merged.lineSpacingPt ? (merged.lineSpacing ?? 0) * scale : natural * ((merged.lineSpacing ?? 100) / 100) * (1 - lnRed);
      const height = Math.max(1, ls);
      if (first) y += pi === 0 ? 0 : spBefore;
      const baseline = y + height * 0.8 + (ascent - maxSize * 0.92);
      let x = 0;
      const segs: Seg[] = [];
      for (const t of lineToks) {
        if (t.br) continue;
        const w = m(t.text, t.css) + (t.style.spc ? t.style.spc * t.text.length : 0);
        const last = segs[segs.length - 1];
        if (last && last.run === t.run && last.css === t.css) { last.text += t.text; last.w += w; }
        else segs.push({ text: t.text, x, w, style: t.style, size: t.size, font: t.font, css: t.css, run: t.run });
        x += w;
      }
      const width = x;
      const ll: LaidLine = { segs, y: baseline, width, height, ascent, para: pi, first, left: left(first), avail: avail(first), align };
      if (first && bText) ll.bullet = { text: bText, x: bX, size: bSize, font: bFont, color: bullet?.color || toks.find((t) => !t.br)?.style.color || baseRun.color };
      lines.push(ll);
      y += height;
      lineToks = [];
      lineW = 0;
      first = false;
      wrapped = false;
    };
    for (const t of toks) {
      if (t.br) { lineToks.push(t); flush(); continue; }
      const w = m(t.text, t.css);
      if (o.wrap !== false && !t.space && lineW + w > avail(first) && lineToks.some((x) => !x.space)) {
        flush();
        wrapped = true;
      }
      // Spaces at a wrap are dropped; spaces typed at the start of a paragraph or line are kept.
      if (!t.space || lineToks.length || !wrapped) {
        // A word longer than the line is broken by characters.
        if (!t.space && w > avail(first) && o.wrap !== false) {
          let chunk = '';
          for (const ch of t.text) {
            const cw = m(chunk + ch, t.css);
            if (cw > avail(first) - lineW && chunk) { lineToks.push({ ...t, text: chunk }); flush(); wrapped = true; chunk = ch; }
            else chunk += ch;
          }
          if (chunk) { lineToks.push({ ...t, text: chunk }); lineW += m(chunk, t.css); }
          continue;
        }
        lineToks.push(t);
        lineW += w;
      }
    }
    flush();
    y += spAfter;
  });
  return { lines, height: y };
}

function stripUndef<T extends object>(o: T): Partial<T> {
  const r: any = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && k !== 'runs' && k !== 'level' && k !== 'end') r[k] = v;
  return r;
}
