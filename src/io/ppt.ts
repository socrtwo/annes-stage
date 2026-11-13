/**
 * PowerPoint 97–2003 (.ppt, .pps, .pot) import, written from the published [MS-PPT] and
 * [MS-ODRAW] specifications. Import only: slides are rebuilt with their text (titles, bodies and
 * other text boxes at their positions), pictures and speaker notes. Formatting beyond text levels
 * is not carried. A lenient record scan recovers text from damaged files.
 */
import { Deck, newId } from '../model/deck';
import type { Element, Paragraph, PictureElement, ShapeElement, Slide } from '../model/types';
import { openCfb, le, type Cfb } from './cfb';
import { b64 } from './xml';

const RT = {
  Document: 0x03e8, DocumentAtom: 0x03e9, Slide: 0x03ee, SlideAtom: 0x03ef, Notes: 0x03f0, SlidePersistAtom: 0x03f3, MainMaster: 0x03f8,
  PPDrawing: 0x040c, SlideListWithText: 0x0ff0, OutlineTextRefAtom: 0x0f9e, TitleMaster: 0x03f7, Handout: 0x0fc9, TextHeaderAtom: 0x0f9f, TextCharsAtom: 0x0fa0, TextBytesAtom: 0x0fa8, StyleTextPropAtom: 0x0fa1,
  PersistDirectoryAtom: 0x1772, UserEditAtom: 0x0ff5, OEPlaceholderAtom: 0x0bc3, CurrentUserAtom: 0x0ff6,
  DggContainer: 0xf000, BStoreContainer: 0xf001, DgContainer: 0xf002, SpgrContainer: 0xf003, SpContainer: 0xf004, FBSE: 0xf007, FSP: 0xf00a, FOPT: 0xf00b,
  ClientTextbox: 0xf00d, ClientAnchor: 0xf010, ClientData: 0xf011, ChildAnchor: 0xf00f,
};

interface Rec { type: number; ver: number; inst: number; off: number; len: number; data: number }

function rec(b: Uint8Array, off: number): Rec | null {
  if (off < 0 || off + 8 > b.length) return null;
  const vi = le.u16(b, off);
  const len = le.u32(b, off + 4);
  return { type: le.u16(b, off + 2), ver: vi & 0xf, inst: vi >> 4, off, len, data: off + 8 };
}

/** Children of a container record (bounded and cycle-safe). */
function children(b: Uint8Array, r: Rec): Rec[] {
  const out: Rec[] = [];
  let o = r.data;
  const end = Math.min(b.length, r.data + r.len);
  while (o + 8 <= end && out.length < 100000) {
    const c = rec(b, o);
    if (!c || c.len > end - c.data) break;
    out.push(c);
    o = c.data + c.len;
  }
  return out;
}

function walk(b: Uint8Array, r: Rec, fn: (r: Rec, depth: number) => boolean | void, depth = 0): void {
  if (depth > 32) return;
  for (const c of children(b, r)) {
    if (fn(c, depth) === false) continue;
    if (c.ver === 0xf) walk(b, c, fn, depth + 1);
  }
}

const textOf = (b: Uint8Array, r: Rec): string => {
  const end = Math.min(b.length, r.data + r.len);
  if (r.type === RT.TextCharsAtom) {
    let s = '';
    for (let i = r.data; i + 1 < end; i += 2) s += String.fromCharCode(le.u16(b, i));
    return s;
  }
  let s = '';
  for (let i = r.data; i < end; i++) s += String.fromCharCode(b[i]);
  return s;
};

interface PptShape { kind: 'text' | 'picture'; textType?: number; text?: string; rect?: [number, number, number, number]; ph?: number; pib?: number; pf?: PfRun[]; /** Blip of a picture fill (fillBlip, 0x0186). */ fillPib?: number; /** Index of the SlideListWithText text this shape showed (OutlineTextRefAtom). */ listRef?: number }

/** One text of a SlideListWithText entry: TextHeaderAtom type, its characters and paragraph runs. */
export interface ListText { type: number; text: string; pf?: PfRun[] }

interface PfRun { count: number; level: number; bullet?: string | null }

/** Paragraph runs of a StyleTextPropAtom: character count, indent level and bullet per run. */
function paraRuns(b: Uint8Array, r: Rec, textLen: number): PfRun[] {
  const out: PfRun[] = [];
  let o = r.data, left = textLen + 1;
  const end = Math.min(b.length, r.data + r.len);
  while (left > 0 && o + 10 <= end && out.length < 10000) {
    const count = le.u32(b, o), level = le.u16(b, o + 4), mask = le.u32(b, o + 6);
    o += 10;
    let bullet: string | null | undefined;
    let flags = 0;
    if (mask & 0xf) { flags = le.u16(b, o); o += 2; }
    if (mask & 0x80) { const ch = le.u16(b, o); o += 2; if (flags & 1) bullet = ch ? String.fromCharCode(ch) : null; }
    if (mask & 0x10) o += 2;
    if (mask & 0x40) o += 2;
    if (mask & 0x20) o += 4;
    if (mask & 0x800) o += 2;
    if (mask & 0x1000) o += 2;
    if (mask & 0x2000) o += 2;
    if (mask & 0x4000) o += 2;
    if (mask & 0x100) o += 2;
    if (mask & 0x400) o += 2;
    if (mask & 0x8000) o += 2;
    if (mask & 0x100000) { const n = le.u16(b, o); o += 2 + 4 * n; }
    if (mask & 0x10000) o += 2;
    if (mask & 0xe0000) o += 2;
    if (mask & 0x200000) o += 2;
    if (bullet === undefined && (mask & 1)) bullet = flags & 1 ? '•' : null;
    out.push({ count, level: Math.min(8, level), ...(bullet !== undefined ? { bullet } : {}) });
    left -= count;
  }
  return out;
}

/**
 * Shapes of a slide, notes or master container: text boxes and pictures with their anchors.
 * PowerPoint keeps placeholder text in the SlideListWithText, not in the drawing: a ClientTextbox
 * then holds an OutlineTextRefAtom whose index picks the slide's list text (with its styles).
 */
export function shapesOf(b: Uint8Array, container: Rec, listText: ListText[] = []): PptShape[] {
  const out: PptShape[] = [];
  const visit = (r: Rec, depth: number) => {
    if (r.type !== RT.SpContainer) return;
    const kids = children(b, r);
    const sh: PptShape = { kind: 'text' };
    for (const k of kids) {
      if (k.type === RT.ClientAnchor) {
        if (k.len >= 16) sh.rect = [le.i32(b, k.data + 4), le.i32(b, k.data), le.i32(b, k.data + 8), le.i32(b, k.data + 12)];
        else if (k.len >= 8) sh.rect = [le.i16(b, k.data + 2), le.i16(b, k.data), le.i16(b, k.data + 4), le.i16(b, k.data + 6)];
      } else if (k.type === RT.ChildAnchor && !sh.rect && k.len >= 16) {
        sh.rect = [le.i32(b, k.data), le.i32(b, k.data + 4), le.i32(b, k.data + 8), le.i32(b, k.data + 12)];
      } else if (k.type === RT.FOPT) {
        // Property table: 6-byte entries; pib (0x4104) points at a picture in the blip store.
        const n = k.inst;
        for (let i = 0; i < n && k.data + i * 6 + 6 <= k.data + k.len; i++) {
          const id = le.u16(b, k.data + i * 6) & 0x3fff;
          if (id === 0x0104) { sh.pib = le.u32(b, k.data + i * 6 + 2); sh.kind = 'picture'; }
          else if (id === 0x0186) sh.fillPib = le.u32(b, k.data + i * 6 + 2);
        }
      } else if (k.type === RT.ClientData) {
        walk(b, k, (c) => { if (c.type === RT.OEPlaceholderAtom && c.len >= 8) sh.ph = b[c.data + 4]; });
      } else if (k.type === RT.ClientTextbox) {
        const parts: string[] = [];
        walk(b, k, (c) => {
          if (c.type === RT.TextHeaderAtom && c.len >= 4) sh.textType = le.u32(b, c.data);
          else if (c.type === RT.TextCharsAtom || c.type === RT.TextBytesAtom) parts.push(textOf(b, c));
          else if (c.type === RT.StyleTextPropAtom && parts.length === 1 && !sh.pf) sh.pf = paraRuns(b, c, parts[0].length);
          else if (c.type === RT.OutlineTextRefAtom && c.len >= 4 && sh.listRef == null) sh.listRef = le.i32(b, c.data);
        });
        if (parts.length) { sh.text = parts.join('\r'); sh.kind = 'text'; }
        else if (sh.listRef != null && listText[sh.listRef]) {
          const lt = listText[sh.listRef];
          sh.text = lt.text; sh.kind = 'text';
          if (sh.textType == null) sh.textType = lt.type;
          if (lt.pf) sh.pf = lt.pf;
        }
      }
    }
    if (sh.text != null || sh.kind === 'picture' || sh.fillPib) out.push(sh);
    void depth;
  };
  walk(b, container, (r, d) => { visit(r, d); });
  return out;
}

/** Slide entries of a SlideListWithText: persist id and the texts (header type, characters, styles). */
export function slideListTexts(b: Uint8Array, list: Rec): { persist: number; listText: ListText[] }[] {
  const out: { persist: number; listText: ListText[] }[] = [];
  let cur: { persist: number; listText: ListText[] } | null = null;
  let group: ListText | null = null;
  for (const k of children(b, list)) {
    if (k.type === RT.SlidePersistAtom) { cur = { persist: le.u32(b, k.data), listText: [] }; out.push(cur); group = null; }
    else if (!cur) continue;
    else if (k.type === RT.TextHeaderAtom) { group = { type: le.u32(b, k.data), text: '' }; cur.listText.push(group); }
    else if (k.type === RT.TextCharsAtom || k.type === RT.TextBytesAtom) {
      const prev = group as ListText | null;
      const g: ListText = prev && !prev.text ? prev : { type: prev ? prev.type : 4, text: '' };
      if (g !== prev) { cur.listText.push(g); group = g; }
      g.text = textOf(b, k);
    } else if (k.type === RT.StyleTextPropAtom && group && !group.pf) group.pf = paraRuns(b, k, group.text.length);
  }
  return out;
}

/** Record header at an offset (exported for tests). */
export const pptRecord = rec;

export interface PptImportResult { deck: Deck; warnings: string[]; damaged: boolean; textOnly?: boolean }

/** Pictures in blip-store order (pib 1 = first). */
async function pictures(cfb: Cfb, doc: Uint8Array, docRec: Rec | null): Promise<({ mime: string; data: Uint8Array } | null)[]> {
  const pics = cfb.read('Pictures');
  const out: ({ mime: string; data: Uint8Array } | null)[] = [];
  const fbse: { foDelay: number; size: number; embedded?: Rec; buf: Uint8Array }[] = [];
  if (docRec) {
    walk(doc, docRec, (r) => {
      if (r.type === RT.FBSE) {
        const embedded = r.len > 36 + doc[r.data + 33] + 8 ? rec(doc, r.data + 36 + doc[r.data + 33]) : null;
        fbse.push({ foDelay: le.u32(doc, r.data + 28), size: le.u32(doc, r.data + 20), embedded: embedded && embedded.type >= 0xf018 && embedded.type <= 0xf117 ? embedded : undefined, buf: doc });
      }
    });
  }
  if (fbse.length) {
    for (const f of fbse) {
      if (f.embedded) { out.push(await blip(f.buf, f.embedded)); continue; }
      const r = pics ? rec(pics, f.foDelay) : null;
      out.push(r && pics ? await blip(pics, r) : null);
    }
    return out;
  }
  // No blip store found: read the Pictures stream in order.
  if (pics) {
    let o = 0;
    while (o + 8 <= pics.length) {
      const r = rec(pics, o);
      if (!r || r.len > pics.length) break;
      out.push(await blip(pics, r));
      o = r.data + r.len;
    }
  }
  return out;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array | null> {
  for (const fmt of ['deflate', 'deflate-raw'] as const) {
    try {
      const ds = new (globalThis as any).DecompressionStream(fmt);
      const stream = new Blob([data.slice()]).stream().pipeThrough(ds);
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch { /* try the other framing */ }
  }
  return null;
}

/** Decodes one OfficeArt blip record into image bytes. */
export async function blip(b: Uint8Array, r: Rec): Promise<{ mime: string; data: Uint8Array } | null> {
  const end = Math.min(b.length, r.data + r.len);
  const two = (r.inst & 1) === 1;
  switch (r.type) {
    case 0xf01d: case 0xf02a: case 0xf01e: case 0xf01f: case 0xf029: {
      const start = r.data + (two ? 32 : 16) + 1;
      const mime = r.type === 0xf01e ? 'image/png' : r.type === 0xf01f ? 'image/bmp' : r.type === 0xf029 ? 'image/tiff' : 'image/jpeg';
      let data = b.slice(start, end);
      if (r.type === 0xf01f) {
        // DIB without a file header: add the 14-byte BITMAPFILEHEADER.
        const hdr = new Uint8Array(14);
        const total = data.length + 14;
        hdr.set([0x42, 0x4d, total & 255, (total >> 8) & 255, (total >> 16) & 255, (total >> 24) & 255, 0, 0, 0, 0]);
        const bits = 14 + le.u32(data, 0) + (le.u16(data, 14) <= 8 ? 4 * (le.u32(data, 32) || 1 << le.u16(data, 14)) : 0);
        hdr.set([bits & 255, (bits >> 8) & 255, (bits >> 16) & 255, (bits >> 24) & 255], 10);
        const out = new Uint8Array(total); out.set(hdr); out.set(data, 14); data = out;
      }
      return { mime, data };
    }
    case 0xf01a: case 0xf01b: case 0xf01c: {
      const start = r.data + (two ? 32 : 16);
      const compressed = b[start + 32] === 0;
      const raw = b.slice(start + 34, end);
      const data = compressed ? (await inflateRaw(raw)) || raw : raw;
      return { mime: r.type === 0xf01a ? 'image/x-emf' : r.type === 0xf01b ? 'image/x-wmf' : 'image/x-pict', data };
    }
  }
  return null;
}

const TITLE_TYPES = new Set([0, 6]);
const PH_TITLE = new Set([0x01, 0x0d, 0x0f, 0x11]);
const PH_CTR = new Set([0x0f]);
const PH_SUB = new Set([0x10]);

function paragraphsFrom(text: string, pf?: PfRun[]): Paragraph[] {
  // Map each paragraph to the style run that covers its first character.
  const starts: number[] = [];
  let pos = 0;
  const lines = text.replace(/\u000b/g, '\n').split('\r');
  for (const l of lines) { starts.push(pos); pos += l.length + 1; }
  const runAt = (at: number): PfRun | undefined => { let acc = 0; for (const r of pf || []) { if (at < acc + r.count) return r; acc += r.count; } return undefined; };
  return lines.map((line, i) => {
    const m = /^(\t*)/.exec(line)!;
    const r = runAt(starts[i]);
    const p: Paragraph = { level: Math.min(8, r ? r.level : m[1].length), runs: line.slice(m[1].length) ? [{ text: line.slice(m[1].length).replace(/\n/g, ' ') }] : [] };
    if (r?.bullet) { p.bullet = { kind: 'char', char: /[\uf000-\uf0ff]/.test(r.bullet) ? '•' : r.bullet }; p.marL = 18 + 36 * p.level; p.indent = -18; }
    else if (r && r.bullet === null) p.bullet = { kind: 'none' };
    return p;
  });
}

export async function importPpt(data: Uint8Array): Promise<PptImportResult> {
  const cfb = openCfb(data);
  if (!cfb) throw new Error('This is not a PowerPoint 97-2003 file (no compound file header).');
  if (cfb.find('EncryptedSummary') || cfb.find('EncryptionInfo')) throw new Error('This presentation is encrypted with a password; Anne\'s Stage cannot decrypt it.');
  const doc = cfb.read('PowerPoint Document');
  if (!doc || !doc.length) throw new Error('This compound file has no PowerPoint Document stream.');
  const warnings: string[] = [];
  let damaged = cfb.damaged.length > 0;

  // Persist directory: persist id → stream offset (later edits override earlier ones).
  const persist = new Map<number, number>();
  const tops: Rec[] = [];
  for (let o = 0; o + 8 <= doc.length;) {
    const r = rec(doc, o);
    if (!r || r.len > doc.length - r.data) { damaged = true; break; }
    tops.push(r);
    if (r.type === RT.PersistDirectoryAtom) {
      let p = r.data;
      const end = r.data + r.len;
      while (p + 4 <= end) {
        const v = le.u32(doc, p);
        const id = v & 0xfffff, n = v >>> 20;
        for (let k = 0; k < n && p + 4 + k * 4 + 4 <= end; k++) persist.set(id + k, le.u32(doc, p + 4 + k * 4));
        p += 4 + n * 4;
      }
    }
    o = r.data + r.len;
  }
  const docRecs = tops.filter((t) => t.type === RT.Document);
  const docRec = docRecs[docRecs.length - 1] || null;
  let w = 720, h = 540;
  if (docRec) {
    walk(doc, docRec, (r) => {
      if (r.type === RT.DocumentAtom && r.len >= 8) { const x = le.i32(doc, r.data), y = le.i32(doc, r.data + 4); if (x > 0 && y > 0) { w = x / 8; h = y / 8; } }
      return r.type === RT.Document ? undefined : false;
    });
  }
  const deck = new Deck(Deck.blankData({ w, h }));
  const lay = (t: string) => deck.layoutByType(t)?.id || deck.data.layouts[0].id;
  const pics = await pictures(cfb, doc, docRec);
  const mediaIds = pics.map((p) => (p ? deck.addMedia({ mime: p.mime, b64: b64(p.data) }) : ''));
  const used = new Set<number>();

  // Slide order from the slide list; its texts are what OutlineTextRefAtoms point at, and they
  // also serve when the drawing has no text at all.
  type SlideRef = { persist: number; listText: ListText[] };
  const slideRefs: SlideRef[] = [];
  /** Notes id (from SlideAtom.notesIdRef) → persist id. */
  const notesPersist = new Map<number, number>();
  if (docRec) {
    for (const c of children(doc, docRec)) {
      if (c.type === RT.SlideListWithText && c.inst === 2) {
        for (const k of children(doc, c)) if (k.type === RT.SlidePersistAtom && k.len >= 16) notesPersist.set(le.u32(doc, k.data + 12), le.u32(doc, k.data));
      }
      if (c.type !== RT.SlideListWithText || c.inst !== 0) continue;
      for (const ref of slideListTexts(doc, c)) slideRefs.push(ref);
    }
  }
  const toPt = (v: number) => v / 8;
  const build = (container: Rec | null, listText: ListText[]): { slide: Slide; notesRef: number } => {
    const shapes = container ? shapesOf(doc, container, listText) : [];
    const els: Element[] = [];
    let hasTitle = false, hasCtr = false;
    const texts = shapes.filter((s) => s.kind === 'text');
    const source: PptShape[] = texts.length ? texts : listText.map((t) => ({ kind: 'text' as const, textType: t.type, text: t.text, pf: t.pf }));
    const hasSub = source.some((s) => (s.ph != null && PH_SUB.has(s.ph)) || s.textType === 5);
    for (const s of source) {
      const isTitle = (s.ph != null && PH_TITLE.has(s.ph)) || (s.ph == null && TITLE_TYPES.has(s.textType ?? -1));
      const ctr = (s.ph != null && PH_CTR.has(s.ph)) || s.textType === 6 || hasSub;
      const sub = (s.ph != null && PH_SUB.has(s.ph)) || s.textType === 5;
      const paras = paragraphsFrom(s.text || '', s.pf);
      const el: ShapeElement = { id: newId('sp'), kind: 'shape', geom: 'rect', text: { paras } };
      if (isTitle && !hasTitle) { el.ph = { type: ctr ? 'ctrTitle' : 'title' }; hasTitle = true; hasCtr = hasCtr || ctr; }
      else if (sub) el.ph = { type: 'subTitle', idx: 1 };
      else if (s.textType === 1 || s.textType === 7 || s.textType === 8 || s.ph === 0x0e) el.ph = { type: 'body', idx: 1 };
      else el.textbox = true;
      if (s.rect && s.rect[2] > s.rect[0] && s.rect[3] > s.rect[1]) { el.x = toPt(s.rect[0]); el.y = toPt(s.rect[1]); el.w = toPt(s.rect[2] - s.rect[0]); el.h = toPt(s.rect[3] - s.rect[1]); }
      else if (el.textbox) { el.x = 60; el.y = 60 + els.length * 40; el.w = w - 120; el.h = 36; }
      els.push(el);
    }
    for (const s of shapes) {
      if (s.fillPib) used.add(s.fillPib - 1);
      if (s.kind !== 'picture' || !s.pib || !mediaIds[s.pib - 1]) continue;
      used.add(s.pib - 1);
      const pic: PictureElement = { id: newId('pic'), kind: 'picture', media: mediaIds[s.pib - 1] };
      if (s.rect) { pic.x = toPt(s.rect[0]); pic.y = toPt(s.rect[1]); pic.w = toPt(s.rect[2] - s.rect[0]); pic.h = toPt(s.rect[3] - s.rect[1]); }
      els.push(pic);
    }
    const layoutType = hasCtr ? 'title' : hasTitle ? (els.some((e) => e.ph?.type === 'body') ? 'obj' : 'titleOnly') : 'blank';
    // Placeholders with no matching layout placeholder keep their own geometry; drop ph types the layout lacks.
    const slide: Slide = { id: newId('sld'), layout: lay(layoutType), elements: els, notes: [], anims: [] };
    let notesRef = 0;
    if (container) {
      for (const c of children(doc, container)) if (c.type === RT.SlideAtom && c.len >= 20) notesRef = le.u32(doc, c.data + 16);
    }
    return { slide, notesRef };
  };
  for (const ref of slideRefs) {
    const off = persist.get(ref.persist);
    const r = off != null ? rec(doc, off) : null;
    const container = r && r.type === RT.Slide ? r : null;
    if (!container && !ref.listText.length) { damaged = true; continue; }
    const { slide, notesRef } = build(container, ref.listText);
    if (notesRef) {
      const no = persist.get(notesPersist.get(notesRef) ?? notesRef);
      const nr = no != null ? rec(doc, no) : null;
      if (nr && nr.type === RT.Notes) {
        const body = shapesOf(doc, nr).filter((s) => s.kind === 'text' && s.text?.trim() && (s.textType === 2 || s.ph === 0x0c || s.textType === 1));
        if (body.length) slide.notes = paragraphsFrom(body.map((b) => b.text).join('\r')).map((p) => ({ level: 0, runs: p.runs }));
      }
    }
    deck.data.slides.push(slide);
  }
  if (!deck.data.slides.length) {
    // No usable slide list: take every slide container in stream order.
    damaged = true;
    for (const t of tops) if (t.type === RT.Slide) deck.data.slides.push(build(t, []).slide);
  }
  // Pictures shown by masters, title masters, notes and handouts, or used as picture fills, are
  // accounted for; any other unplaced picture is surfaced only when the file is damaged.
  for (const t of tops) {
    if (t.type !== RT.MainMaster && t.type !== RT.TitleMaster && t.type !== RT.Notes && t.type !== RT.Handout && t.type !== RT.Slide) continue;
    for (const sh of shapesOf(doc, t)) { if (sh.pib) used.add(sh.pib - 1); if (sh.fillPib) used.add(sh.fillPib - 1); }
  }
  const orphans = mediaIds.map((id, i) => ({ id, i })).filter((x) => x.id && !used.has(x.i));
  if (orphans.length && damaged) {
    const s = deck.makeSlide(lay('titleOnly'));
    (s.elements.find((e) => e.ph) as ShapeElement).text = { paras: [{ level: 0, runs: [{ text: 'Recovered pictures' }] }] };
    const cols = Math.ceil(Math.sqrt(orphans.length));
    const cw = (w - 80) / cols, ch = (h - 160) / Math.ceil(orphans.length / cols);
    orphans.forEach((o, k) => s.elements.push({ id: newId('pic'), kind: 'picture', media: o.id, x: 40 + (k % cols) * cw + 4, y: 130 + Math.floor(k / cols) * ch + 4, w: cw - 8, h: ch - 8, alt: 'Picture not placed on a slide' }));
    deck.data.slides.push(s);
    warnings.push(`${orphans.length} picture(s) could not be matched to a slide and were placed on a "Recovered pictures" slide.`);
  }
  if (!deck.data.slides.length) throw new Error('No slides could be read from this PowerPoint 97-2003 file.');
  if (damaged) warnings.push('The file is damaged; some slides or text may be missing.');
  if (deck.data.slides.some((s) => s.elements.some((e) => e.kind === 'picture' && /emf|wmf|pict/.test(deck.media[(e as PictureElement).media]?.mime || '')))) warnings.push('Some pictures are Windows metafiles (EMF/WMF), which browsers cannot display; they are kept and saved back.');
  warnings.push('Imported from PowerPoint 97-2003: text, pictures and notes are kept; fonts, colors and animations are not.');
  deck.clearHistory();
  return { deck, warnings, damaged };
}

/**
 * Lenient record salvage: scans raw bytes (the PowerPoint Document stream, or the whole file when
 * the compound file is damaged) for text atoms and groups them into slides at SlideContainer and
 * SlidePersistAtom boundaries. Returns slides as [title, body lines].
 */
export function salvagePptText(b: Uint8Array): { title: string; body: string[] }[] {
  const slides: { title: string; body: string[] }[] = [];
  let cur: { title: string; body: string[] } | null = null;
  let ttype = 4;
  const next = () => { cur = { title: '', body: [] }; slides.push(cur); };
  for (let o = 0; o + 8 <= b.length; o++) {
    const type = le.u16(b, o + 2);
    if (type !== RT.TextCharsAtom && type !== RT.TextBytesAtom && type !== RT.TextHeaderAtom && type !== RT.SlidePersistAtom && type !== RT.Slide) continue;
    const vi = le.u16(b, o);
    const len = le.u32(b, o + 4);
    if (len > b.length - o - 8) continue;
    if (type === RT.Slide && (vi & 0xf) === 0xf) { next(); continue; }
    if (type === RT.SlidePersistAtom && (vi & 0xf) === 0 && len >= 20) { next(); o += 7 + len; continue; }
    if (type === RT.TextHeaderAtom && len === 4 && (vi & 0xf) === 0) { ttype = le.u32(b, o + 8); o += 11; continue; }
    if ((vi & 0xf) !== 0 || len === 0 || len > 65536) continue;
    const r: Rec = { type, ver: 0, inst: 0, off: o, len, data: o + 8 };
    const text = textOf(b, r);
    // Plausible text only: mostly printable.
    const printable = text.replace(/[\r\n\t\u000b]/g, '').split('').filter((c) => c >= ' ' && c !== '�').length;
    if (!text.trim() || printable < text.replace(/[\r\n\t\u000b]/g, '').length * 0.9) continue;
    if (!cur) next();
    if (TITLE_TYPES.has(ttype) && !cur!.title) cur!.title = text.replace(/[\r\u000b]/g, ' ').trim();
    else cur!.body.push(...text.split(/[\r\u000b]/).filter((l) => l.trim()));
    o += 7 + len;
  }
  return slides.filter((s) => s.title || s.body.length);
}
