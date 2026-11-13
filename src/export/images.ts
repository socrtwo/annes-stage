/**
 * Slide pictures: PNG and JPEG by rasterizing the renderer's SVG on a canvas, and SVG files. The
 * bundled web fonts the slide uses are embedded in the SVG as data: URLs first, because an SVG drawn
 * from a blob cannot reach the page's fonts.
 */
import type { Deck } from '../model/deck';
import type { Slide } from '../model/types';
import { slideSvg } from '../render/slide';
import { stateAt, buildSteps } from '../render/animate';
import { FACES } from '../fonts';

export interface PngOptions {
  /** Output width in pixels (height follows the slide's aspect ratio). */
  width: number;
  type?: 'image/png' | 'image/jpeg';
  /** JPEG quality 0–1. */
  quality?: number;
  /** Build state: steps played (default: the fully built slide). */
  step?: number;
  /** JPEG background (no transparency). */
  background?: string;
}

const fontCache = new Map<string, string>();

/** Largest canvas side and area browsers reliably allocate (Chrome/Firefox: 32767 px side, ~268 M px area; Safari is smaller). */
export const MAX_CANVAS_SIDE = 16384;
export const MAX_CANVAS_AREA = 268_435_456;

/** Clamps a requested picture size to what a canvas can hold, keeping the aspect ratio. */
export function clampCanvas(width: number, height: number): { width: number; height: number } {
  let w = Math.max(1, Math.round(Number.isFinite(width) ? width : 1)), h = Math.max(1, Math.round(Number.isFinite(height) ? height : 1));
  let k = Math.min(1, MAX_CANVAS_SIDE / w, MAX_CANVAS_SIDE / h);
  if (w * h * k * k > MAX_CANVAS_AREA) k = Math.min(k, Math.sqrt(MAX_CANVAS_AREA / (w * h)));
  if (k < 1) { w = Math.max(1, Math.floor(w * k)); h = Math.max(1, Math.floor(h * k)); }
  return { width: w, height: h };
}

async function dataUrl(url: string): Promise<string> {
  const hit = fontCache.get(url);
  if (hit) return hit;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Font ${url} could not be loaded (${res.status}).`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const s = `data:font/woff2;base64,${toBase64(buf)}`;
  fontCache.set(url, s);
  return s;
}

export function toBase64(buf: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** @font-face rules (with embedded data) for the bundled fonts an SVG names. */
export async function embeddedFontCss(svg: string): Promise<string> {
  const css: string[] = [];
  for (const [fam, aliases, weight, style, url] of FACES) {
    const names = [fam, ...aliases].filter((n) => svg.includes(`"${n}"`) || svg.includes(`&quot;${n}&quot;`));
    if (!names.length) continue;
    try {
      const src = await dataUrl(url);
      for (const n of names) css.push(`@font-face{font-family:"${n}";src:url(${src}) format("woff2");font-weight:${weight};font-style:${style}}`);
    } catch { /* offline and not cached: the fallback font is used */ }
  }
  return css.join('');
}

/** Slide SVG markup with fonts embedded, ready to save or rasterize. */
export async function standaloneSvg(deck: Deck, slide: Slide, step?: number): Promise<string> {
  const st = stateAt(slide, step ?? buildSteps(slide).length);
  const svg = slideSvg(deck, slide, { mode: 'print', hide: st.hide, paraVisible: st.paraVisible, number: deck.slideIndex(slide.id) + (deck.data.firstNumber ?? 1) });
  const fonts = await embeddedFontCss(svg);
  return fonts ? svg.replace('<defs>', `<defs><style>${fonts}</style>`) : svg;
}

export async function slidePng(deck: Deck, slide: Slide, opts: PngOptions): Promise<Blob> {
  const { w, h } = deck.size;
  const { width, height } = clampCanvas(Math.max(16, Math.round(opts.width) || 16), (Math.max(16, Math.round(opts.width) || 16) * h) / w);
  const markup = (await standaloneSvg(deck, slide, opts.step)).replace(/width="[^"]*" height="[^"]*"/, `width="${width}" height="${height}"`);
  const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('The slide could not be drawn as a picture.')); img.src = url; });
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser cannot draw pictures (no canvas).');
    if (opts.type === 'image/jpeg' || opts.background) { ctx.fillStyle = opts.background || '#FFFFFF'; ctx.fillRect(0, 0, width, height); }
    ctx.drawImage(img, 0, 0, width, height);
    return await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Could not encode the picture.'))), opts.type || 'image/png', opts.quality ?? 0.92));
  } finally {
    URL.revokeObjectURL(url);
  }
}

export interface ExportImagesOptions { format: 'png' | 'jpeg' | 'svg'; width: number; slides?: string[] }

const safeName = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 60);

/** One file per slide: Slide1.png, Slide2.png, … */
export async function exportImages(deck: Deck, opts: ExportImagesOptions): Promise<{ name: string; data: Uint8Array }[]> {
  const out: { name: string; data: Uint8Array }[] = [];
  const slides = opts.slides?.length ? deck.slides.filter((s) => opts.slides!.includes(s.id)) : deck.slides;
  for (const s of slides) {
    const n = deck.slideIndex(s.id) + 1;
    const base = safeName(`Slide${n}`);
    if (opts.format === 'svg') {
      out.push({ name: `${base}.svg`, data: new TextEncoder().encode(await standaloneSvg(deck, s)) });
      continue;
    }
    const blob = await slidePng(deck, s, { width: opts.width, type: opts.format === 'jpeg' ? 'image/jpeg' : 'image/png' });
    out.push({ name: `${base}.${opts.format === 'jpeg' ? 'jpg' : 'png'}`, data: new Uint8Array(await blob.arrayBuffer()) });
  }
  return out;
}
