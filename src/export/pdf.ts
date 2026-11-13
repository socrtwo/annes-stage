/**
 * PDF export with a small built-in writer (no dependency): slides (optionally one page per build
 * step), handouts (1, 2, 3, 4, 6 or 9 slides per page), notes pages and the outline. Slides are
 * embedded as JPEG pictures of the renderer's output; text written by the exporter (notes, outline,
 * page numbers) uses the standard Helvetica fonts. For a vector PDF with selectable slide text, use
 * Print ▸ Save as PDF, which prints the renderer's SVG.
 */
import type { Deck } from '../model/deck';
import type { Slide } from '../model/types';
import { buildSteps } from '../render/animate';
import { slideOutline } from './outline';

export type PdfKind = 'slides' | 'handouts' | 'notes' | 'outline';

export interface PdfOptions {
  kind?: PdfKind;
  /** Handouts per page: 1, 2, 3, 4, 6 or 9. */
  perPage?: number;
  paper?: 'letter' | 'a4';
  /** One page per build step (slides). */
  buildSteps?: boolean;
  /** Include hidden slides. */
  hidden?: boolean;
  /** Frame slides on handouts. */
  frame?: boolean;
  /** Slide ids to include (default: all). */
  slides?: string[];
  /** Picture width in pixels for each slide image. */
  imageWidth?: number;
  /** Renders a slide (after `step` build steps, or fully built) to JPEG bytes. Defaults to slidePng. */
  render?: (slide: Slide, step: number | undefined, widthPx: number) => Promise<Uint8Array>;
  onProgress?: (done: number, total: number) => void;
  /**
   * Called (once per distinct message) when text the standard PDF fonts cannot show had to be
   * drawn as a picture or, without a canvas, replaced by "?". Defaults to console.warn.
   */
  onWarning?: (message: string) => void;
  /**
   * Draws one line of text the WinAnsi fonts cannot encode, as JPEG bytes at `scale` pixels per
   * point. Defaults to a canvas renderer when a canvas is available; return null to fall back to "?".
   */
  rasterText?: (text: string, size: number, bold: boolean, scale: number) => Promise<{ jpeg: Uint8Array; w: number; h: number } | null>;
}

const PAPER = { letter: [612, 792], a4: [595.28, 841.89] } as const;

// Helvetica glyph widths (1/1000 em) for ASCII 32–126.
const HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];

/** Width of text in Helvetica at `size` points (bold is about 5% wider). */
export function textWidth(s: string, size: number, bold = false): number {
  let w = 0;
  for (const ch of s) { const c = ch.charCodeAt(0); w += c >= 32 && c <= 126 ? HELV[c - 32] : 556; }
  return (w / 1000) * size * (bold ? 1.05 : 1);
}

// WinAnsi (cp1252) code points for 0x80–0x9F.
const CP1252: Record<number, number> = { 0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f };

/** True when every character of `s` has a WinAnsi (cp1252) code, so the standard fonts can show it. */
export function winAnsiEncodable(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 32 && c !== 9 && c !== 10 && c !== 13) continue;
    if ((c > 255 || (c >= 0x80 && c < 0xa0)) && CP1252[c] == null) return false;
  }
  return true;
}

/** A PDF literal string in WinAnsi: characters outside the encoding become "?". */
export function pdfText(s: string): string {
  let out = '(';
  for (const ch of s) {
    let c = ch.codePointAt(0)!;
    if (c > 255 || (c >= 0x80 && c < 0xa0)) c = CP1252[c] ?? 63;
    if (c === 0x28 || c === 0x29 || c === 0x5c) out += '\\' + String.fromCharCode(c);
    else if (c < 32) out += ' ';
    else out += String.fromCharCode(c);
  }
  return out + ')';
}

/** Info-dictionary string: plain when ASCII, otherwise UTF-16BE hex. */
function infoString(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return '(' + s.replace(/[()\\]/g, '\\$&') + ')';
  let hex = 'FEFF';
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
  return `<${hex}>`;
}

function pdfDate(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `(D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z)`;
}

/** Width and height from a JPEG's start-of-frame marker. */
export function jpegSize(b: Uint8Array): { w: number; h: number } | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] };
    i += 2 + len;
  }
  return null;
}

/** Minimal PDF document builder. */
export class PdfWriter {
  private objs: (Uint8Array | string)[] = [];
  private pages: number[] = [];
  private pagesRef: number;
  private fontRef: number;
  private boldRef: number;

  constructor() {
    this.pagesRef = this.reserve();
    this.fontRef = this.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    this.boldRef = this.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  }

  private reserve(): number { this.objs.push(''); return this.objs.length; }
  add(body: string | Uint8Array): number { this.objs.push(body); return this.objs.length; }

  stream(dict: string, data: Uint8Array | string): number {
    const bytes = typeof data === 'string' ? latin1(data) : data;
    const head = latin1(`<< ${dict} /Length ${bytes.length} >>\nstream\n`);
    const tail = latin1('\nendstream');
    const all = new Uint8Array(head.length + bytes.length + tail.length);
    all.set(head, 0); all.set(bytes, head.length); all.set(tail, head.length + bytes.length);
    return this.add(all);
  }

  image(jpeg: Uint8Array, fallback?: { w: number; h: number }): number {
    const sz = jpegSize(jpeg) || fallback || { w: 1, h: 1 };
    return this.stream(`/Type /XObject /Subtype /Image /Width ${sz.w} /Height ${sz.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`, jpeg);
  }

  page(w: number, h: number, content: string, images: Record<string, number> = {}): void {
    const c = this.stream('', content);
    const xo = Object.entries(images).map(([k, v]) => `/${k} ${v} 0 R`).join(' ');
    const ref = this.add(`<< /Type /Page /Parent ${this.pagesRef} 0 R /MediaBox [0 0 ${num(w)} ${num(h)}] /Resources << /Font << /F1 ${this.fontRef} 0 R /F2 ${this.boldRef} 0 R >>${xo ? ` /XObject << ${xo} >>` : ''} >> /Contents ${c} 0 R >>`);
    this.pages.push(ref);
  }

  get pageCount(): number { return this.pages.length; }

  finish(info: Record<string, string> = {}): Uint8Array {
    this.objs[this.pagesRef - 1] = `<< /Type /Pages /Kids [${this.pages.map((p) => `${p} 0 R`).join(' ')}] /Count ${this.pages.length} >>`;
    const catalog = this.add(`<< /Type /Catalog /Pages ${this.pagesRef} 0 R >>`);
    const infoRef = this.add(`<< ${Object.entries(info).map(([k, v]) => `/${k} ${v}`).join(' ')} >>`);
    const chunks: Uint8Array[] = [latin1('%PDF-1.4\n%âãÏÓ\n')];
    let offset = chunks[0].length;
    const offsets: number[] = [];
    this.objs.forEach((o, i) => {
      offsets.push(offset);
      const body = typeof o === 'string' ? latin1(o) : o;
      const parts = [latin1(`${i + 1} 0 obj\n`), body, latin1('\nendobj\n')];
      for (const p of parts) { chunks.push(p); offset += p.length; }
    });
    const xref = `xref\n0 ${this.objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${this.objs.length + 1} /Root ${catalog} 0 R /Info ${infoRef} 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
    chunks.push(latin1(xref));
    const total = chunks.reduce((a, c) => a + c.length, 0);
    const out = new Uint8Array(total);
    let p = 0;
    for (const c of chunks) { out.set(c, p); p += c.length; }
    return out;
  }
}

function latin1(s: string): Uint8Array {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  return b;
}

const num = (v: number) => (Number.isFinite(v) ? +v.toFixed(3) : 0);

/** Wraps text to lines no wider than `width` points. */
export function wrapText(s: string, size: number, width: number, bold = false): string[] {
  const out: string[] = [];
  for (const para of s.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    let line = '';
    for (const w of words) {
      const t = line ? `${line} ${w}` : w;
      if (textWidth(t, size, bold) <= width || !line) line = t;
      else { out.push(line); line = w; }
      // A single word wider than the line is cut by characters.
      while (textWidth(line, size, bold) > width && line.length > 1) {
        let k = line.length - 1;
        while (k > 1 && textWidth(line.slice(0, k), size, bold) > width) k--;
        out.push(line.slice(0, k));
        line = line.slice(k);
      }
    }
    out.push(line);
  }
  return out;
}

const textOp = (x: number, y: number, size: number, s: string, bold = false) => `BT /${bold ? 'F2' : 'F1'} ${num(size)} Tf ${num(x)} ${num(y)} Td ${pdfText(s)} Tj ET\n`;

/** Handout grid: [cols, rows, notes lines beside]. */
function handoutGrid(n: number): [number, number, boolean] {
  switch (n) { case 1: return [1, 1, false]; case 2: return [1, 2, false]; case 3: return [1, 3, true]; case 4: return [2, 2, false]; case 6: return [2, 3, false]; default: return [3, 3, false]; }
}

/** Canvas renderer for lines the standard fonts cannot encode (null without a canvas). */
async function canvasRasterText(text: string, size: number, bold: boolean, scale: number): Promise<{ jpeg: Uint8Array; w: number; h: number } | null> {
  if (typeof document === 'undefined') return null;
  let canvas: HTMLCanvasElement;
  let g: CanvasRenderingContext2D | null;
  try { canvas = document.createElement('canvas'); g = canvas.getContext('2d'); } catch { return null; }
  if (!g) return null;
  const font = `${bold ? 'bold ' : ''}${size * scale}px Carlito, Arimo, Helvetica, Arial, "Noto Sans", sans-serif`;
  g.font = font;
  const wPx = Math.max(1, Math.ceil(g.measureText(text).width) + 2);
  const hPx = Math.max(1, Math.ceil(size * scale * 1.3));
  canvas.width = Math.min(16384, wPx); canvas.height = hPx;
  g = canvas.getContext('2d')!;
  g.fillStyle = '#FFFFFF'; g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = '#000000'; g.font = font; g.textBaseline = 'alphabetic';
  g.fillText(text, 1, Math.round(size * scale * 1.02));
  const blob = await new Promise<Blob | null>((res) => { try { canvas.toBlob((b) => res(b), 'image/jpeg', 0.92); } catch { res(null); } });
  if (!blob) return null;
  return { jpeg: new Uint8Array(await blob.arrayBuffer()), w: canvas.width / scale, h: hPx / scale };
}

async function defaultRender(deck: Deck): Promise<NonNullable<PdfOptions['render']>> {
  const { slidePng } = await import('./images');
  return async (slide, step, width) => new Uint8Array(await (await slidePng(deck, slide, { width, type: 'image/jpeg', quality: 0.9, step })).arrayBuffer());
}

export async function deckToPdf(deck: Deck, opts: PdfOptions = {}): Promise<Uint8Array> {
  const kind = opts.kind || 'slides';
  const slides = deck.slides.filter((s) => (opts.hidden || !s.hidden) && (!opts.slides?.length || opts.slides.includes(s.id)));
  if (!slides.length) throw new Error('No slides to export: the presentation has no slides, or every chosen slide is hidden.');
  const render = opts.render || (kind === 'outline' ? null : await defaultRender(deck));
  const pdf = new PdfWriter();
  // Text the WinAnsi fonts cannot encode (CJK, Greek, Cyrillic, emoji…) is drawn as a picture.
  const warned = new Set<string>();
  const warn = (m: string) => { if (warned.has(m)) return; warned.add(m); (opts.onWarning || ((x: string) => console.warn(x)))(m); };
  const raster = opts.rasterText || canvasRasterText;
  let rasterN = 0;
  /** Text at (x, y) as PDF operators; non-encodable text becomes an image XObject in `images`. */
  const textAt = async (x: number, y: number, size: number, s: string, images: Record<string, number>, bold = false, maxW = Infinity): Promise<string> => {
    if (winAnsiEncodable(s)) return textOp(x, y, size, s, bold);
    let r: { jpeg: Uint8Array; w: number; h: number } | null = null;
    try { r = await raster(s, size, bold, 4); } catch { r = null; }
    if (!r) { warn('Some characters cannot be shown by the PDF\'s standard fonts and were replaced by "?". Use Print ▸ Save as PDF to keep them.'); return textOp(x, y, size, s, bold); }
    warn('Some text uses characters outside the PDF\'s standard fonts; those lines were drawn as pictures (not selectable).');
    const name = `T${++rasterN}`;
    images[name] = pdf.image(r.jpeg, { w: Math.round(r.w * 4), h: Math.round(r.h * 4) });
    const k = r.w > maxW ? maxW / r.w : 1;
    const w = r.w * k, h = r.h * k;
    return `q ${num(w)} 0 0 ${num(h)} ${num(x)} ${num(y - h * 0.22)} cm /${name} Do Q\n`;
  };
  const { w: SW, h: SH } = deck.size;
  const imgW = opts.imageWidth || (kind === 'slides' ? 1600 : 1000);
  const [PW, PH] = PAPER[opts.paper || 'letter'];
  const margin = 40;
  let done = 0;
  const total = slides.length;
  const numberOf = (s: Slide) => deck.slideIndex(s.id) + (deck.data.firstNumber ?? 1);
  const placeImage = (name: string, x: number, y: number, w: number, h: number, frame: boolean) =>
    `q ${num(w)} 0 0 ${num(h)} ${num(x)} ${num(y)} cm /${name} Do Q\n${frame ? `q 0.5 G 0.75 w ${num(x)} ${num(y)} ${num(w)} ${num(h)} re S Q\n` : ''}`;

  if (kind === 'slides') {
    for (const s of slides) {
      const steps = opts.buildSteps ? Math.max(1, buildSteps(s).length) : 1;
      for (let k = 1; k <= steps; k++) {
        const jpg = await render!(s, opts.buildSteps ? k : undefined, imgW);
        const ref = pdf.image(jpg, { w: imgW, h: Math.round((imgW * SH) / SW) });
        pdf.page(SW, SH, placeImage('S', 0, 0, SW, SH, false), { S: ref });
      }
      opts.onProgress?.(++done, total);
    }
  } else if (kind === 'handouts') {
    const per = [1, 2, 3, 4, 6, 9].includes(opts.perPage || 0) ? opts.perPage! : 6;
    const [cols, rows, lines] = handoutGrid(per);
    const areaW = (PW - 2 * margin) * (lines ? 0.5 : 1), areaH = PH - 2 * margin - 20;
    const cellW = areaW / cols, cellH = areaH / rows;
    const gap = 14;
    const scale = Math.min((cellW - gap) / SW, (cellH - gap) / SH);
    const w = SW * scale, h = SH * scale;
    for (let i = 0, pageNo = 1; i < slides.length; i += per, pageNo++) {
      let content = '';
      const images: Record<string, number> = {};
      for (let k = 0; k < per && i + k < slides.length; k++) {
        const s = slides[i + k];
        const c = k % cols, r = Math.floor(k / cols);
        const x = margin + c * cellW + (cellW - w) / 2;
        const yTop = PH - margin - r * cellH - (cellH - h) / 2;
        const ref = pdf.image(await render!(s, undefined, imgW), { w: imgW, h: Math.round((imgW * SH) / SW) });
        images[`S${k}`] = ref;
        content += placeImage(`S${k}`, x, yTop - h, w, h, opts.frame !== false);
        if (lines) {
          content += 'q 0.7 G 0.5 w\n';
          const lx = PW / 2 + 10, rx = PW - margin;
          for (let ly = yTop - 14; ly > yTop - h; ly -= 18) content += `${num(lx)} ${num(ly)} m ${num(rx)} ${num(ly)} l S\n`;
          content += 'Q\n';
        }
        opts.onProgress?.(++done, total);
      }
      content += textOp(PW / 2 - 6, margin / 2, 9, String(pageNo));
      pdf.page(PW, PH, content, images);
    }
  } else if (kind === 'notes') {
    for (const s of slides) {
      const scale = (PW - 2 * margin) / SW;
      const w = SW * scale * 0.85, h = SH * scale * 0.85;
      const x = (PW - w) / 2, y = PH - margin - h;
      const ref = pdf.image(await render!(s, undefined, imgW), { w: imgW, h: Math.round((imgW * SH) / SW) });
      const notes = slideOutline(s).notes.join('\n');
      const lines = wrapText(notes, 12, PW - 2 * margin);
      let content = placeImage('S', x, y, w, h, true);
      let ly = y - 30;
      let images: Record<string, number> = { S: ref };
      for (const ln of lines) {
        if (ly < margin + 20) {
          content += textOp(PW / 2 - 6, margin / 2, 9, String(numberOf(s)));
          pdf.page(PW, PH, content, images);
          content = ''; images = {}; ly = PH - margin;
        }
        content += await textAt(margin, ly, 12, ln, images, false, PW - 2 * margin);
        ly -= 16;
      }
      content += textOp(PW / 2 - 6, margin / 2, 9, String(numberOf(s)));
      pdf.page(PW, PH, content, images);
      opts.onProgress?.(++done, total);
    }
  } else {
    let content = '';
    let images: Record<string, number> = {};
    let y = PH - margin;
    const flush = () => { if (content) pdf.page(PW, PH, content, images); content = ''; images = {}; y = PH - margin; };
    const line = async (s: string, size: number, indent: number, bold = false) => {
      for (const ln of wrapText(s, size, PW - 2 * margin - indent, bold)) {
        if (y < margin + size) flush();
        content += await textAt(margin + indent, y - size, size, ln, images, bold, PW - 2 * margin - indent);
        y -= size * 1.35;
      }
    };
    if (deck.data.props.title) { await line(deck.data.props.title, 20, 0, true); y -= 8; }
    for (const s of slides) {
      const o = slideOutline(s);
      await line(`${numberOf(s)}. ${o.title || '(untitled slide)'}`, 14, 0, true);
      for (const b of o.body) await line(`• ${b.text}`, 11, 18 + b.level * 18);
      y -= 8;
    }
    flush();
    if (!pdf.pageCount) pdf.page(PW, PH, '');
  }
  if (!pdf.pageCount) throw new Error('No slides to export.');
  const p = deck.data.props;
  const info: Record<string, string> = { Producer: '(Anne\'s Stage)', Creator: '(Anne\'s Stage)', CreationDate: pdfDate(Date.now()) };
  if (p.title) info.Title = infoString(p.title);
  if (p.author) info.Author = infoString(p.author);
  if (p.subject) info.Subject = infoString(p.subject);
  if (p.keywords) info.Keywords = infoString(p.keywords);
  return pdf.finish(info);
}
