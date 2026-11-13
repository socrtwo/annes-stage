/**
 * Deck: the presentation document with transactions and before-image undo/redo.
 *
 * Every change runs inside Deck.transact(). A transaction scoped to some slides records those slides'
 * previous state; any other transaction records the whole document (slides, layouts, masters, themes,
 * sections). Undo swaps the before-image back in and keeps the after-image for redo, so no command
 * needs inverse logic. Media are append-only during a session and are not part of the images.
 */
import type { DeckData, Element, Layout, Master, MediaItem, Paragraph, PlaceholderType, Slide, Theme, LevelStyle, TextBody, Section } from './types';
import { defaultTheme, safeHex } from './theme';

const urlCache = new WeakMap<object, string>();
const MIME_RE = /^[\w.+-]+\/[\w.+-]+$/;
const B64_RE = /^[A-Za-z0-9+/\s]*={0,2}\s*$/;

/** A media item is kept only when its type is a plain MIME type and its data is base64. */
export function validMedia(m: any): m is MediaItem {
  return !!m && typeof m === 'object' && typeof m.mime === 'string' && MIME_RE.test(m.mime) && typeof m.b64 === 'string' && B64_RE.test(m.b64);
}

/** Media from a file, without entries whose type or data could break out of a data: URL. */
export function sanitizeMedia(media: any): Record<string, MediaItem> {
  const out: Record<string, MediaItem> = {};
  if (!media || typeof media !== 'object') return out;
  for (const [k, v] of Object.entries(media)) if (validMedia(v)) out[k] = v;
  return out;
}

let seq = 0;
export function newId(prefix = 'e'): string {
  return `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export const clone = <T>(v: T): T => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

type Image =
  | { kind: 'slides'; ids: string[]; slides: (Slide | null)[] }
  | { kind: 'all'; data: Omit<DeckData, 'never'> };

interface UndoEntry { label: string; before: Image; after?: Image; selection?: any }

export const SLIDE_SIZES: { id: string; label: string; w: number; h: number }[] = [
  { id: 'wide', label: 'Widescreen (16:9)', w: 960, h: 540 },
  { id: 'standard', label: 'Standard (4:3)', w: 720, h: 540 },
  { id: '16x10', label: 'On-screen (16:10)', w: 720, h: 450 },
  { id: 'a4', label: 'A4 Paper', w: 780, h: 540 },
  { id: 'letter', label: 'Letter Paper', w: 720, h: 540 },
  { id: 'square', label: 'Square (1:1)', w: 540, h: 540 },
  { id: 'portrait', label: 'Portrait (9:16)', w: 540, h: 960 },
  { id: 'banner', label: 'Banner', w: 576, h: 72 },
];

export function emptyText(level = 0): TextBody { return { paras: [{ level, runs: [] }] }; }

export function textOf(paras: Paragraph[] | undefined): string {
  return (paras || []).map((p) => p.runs.map((r) => (r.br ? '\n' : r.text)).join('')).join('\n');
}

export function parasFromText(text: string, level = 0): Paragraph[] {
  const lines = text.split(/\r?\n/);
  return lines.map((l) => {
    const m = /^(\t*)/.exec(l)!;
    return { level: level + m[1].length, runs: l.slice(m[1].length) ? [{ text: l.slice(m[1].length) }] : [] };
  });
}

// ------------------------------------------------------------------------------------------
// Default master and layouts

const lvl = (n: number, size: number): LevelStyle => ({ marL: 18 + 36 * n, indent: -18, spaceBefore: n === 0 ? 10 : 5, lineSpacing: 90, bullet: { kind: 'char', char: n % 2 ? '–' : '•' }, run: { size, color: 'tx1', font: '+mn-lt' } });

export function defaultStyles(): Master['styles'] {
  return {
    title: [{ align: 'l', lineSpacing: 90, bullet: { kind: 'none' }, run: { size: 44, color: 'tx1', font: '+mj-lt' } }],
    body: [lvl(0, 28), lvl(1, 24), lvl(2, 20), lvl(3, 18), lvl(4, 18), lvl(5, 18), lvl(6, 18), lvl(7, 18), lvl(8, 18)],
    other: [{ run: { size: 18, color: 'tx1', font: '+mn-lt' } }],
  };
}

function ph(type: PlaceholderType, x: number, y: number, w: number, h: number, extra: Partial<Element> & { idx?: number; anchor?: 't' | 'ctr' | 'b'; align?: 'l' | 'ctr' | 'r'; size?: number; prompt?: string } = {}): Element {
  const { idx, anchor, align, size, prompt, ...rest } = extra as any;
  const levels: LevelStyle[] | undefined = align || size ? [{ ...(align ? { align } : {}), ...(size ? { run: { size } } : {}), ...(type === 'subTitle' || type === 'ctrTitle' ? { bullet: { kind: 'none' as const }, marL: 0, indent: 0 } : {}) }] : undefined;
  return {
    id: newId('ph'), kind: 'shape', geom: 'rect', name: `${type} ${idx ?? ''}`.trim(), ph: { type, ...(idx != null ? { idx } : {}) }, x, y, w, h,
    text: { paras: prompt ? [{ level: 0, runs: [{ text: prompt }] }] : [{ level: 0, runs: [] }], ...(anchor ? { anchor } : {}), ...(levels ? { levels } : {}), autofit: type === 'body' || type === 'obj' || type === 'subTitle' ? 'shrink' : 'none' },
    ...rest,
  } as Element;
}

/** Standard layouts for a slide of the given size (positions scale with the size). */
export function defaultLayouts(masterId: string, w = 960, h = 540): Layout[] {
  const sx = w / 960, sy = h / 540;
  const P = (type: PlaceholderType, x: number, y: number, ww: number, hh: number, extra: any = {}) => ph(type, x * sx, y * sy, ww * sx, hh * sy, extra);
  const title = () => P('title', 66, 28.8, 828, 104.5, { anchor: 'ctr', prompt: 'Click to add title' });
  const foot = () => [P('dt', 66, 500.5, 216, 28.75, { idx: 10, size: 12 }), P('ftr', 318, 500.5, 324, 28.75, { idx: 11, align: 'ctr', size: 12 }), P('sldNum', 678, 500.5, 216, 28.75, { idx: 12, align: 'r', size: 12 })];
  const L = (name: string, type: string, elements: Element[]): Layout => ({ id: newId('lay'), name, master: masterId, type, elements: [...elements, ...foot()] });
  return [
    L('Title Slide', 'title', [P('ctrTitle', 120, 88.4, 720, 188, { anchor: 'b', align: 'ctr', size: 60, prompt: 'Click to add title' }), P('subTitle', 120, 283.6, 720, 130.4, { idx: 1, align: 'ctr', size: 24, prompt: 'Click to add subtitle' })]),
    L('Title and Content', 'obj', [title(), P('obj', 66, 144, 828, 342.9, { idx: 1, prompt: 'Click to add text' })]),
    L('Section Header', 'secHead', [P('title', 65.5, 134.6, 828, 224.6, { anchor: 'b', size: 60, prompt: 'Click to add section title' }), P('body', 65.5, 361.4, 828, 118.1, { idx: 1, size: 24, prompt: 'Click to add text' })]),
    L('Two Content', 'twoObj', [title(), P('obj', 66, 144, 408, 342.9, { idx: 1, prompt: 'Click to add text' }), P('obj', 486, 144, 408, 342.9, { idx: 2, prompt: 'Click to add text' })]),
    L('Comparison', 'twoTxTwoObj', [title(), P('body', 66, 132.6, 406, 63.7, { idx: 1, anchor: 'b', size: 24, prompt: 'Click to add heading' }), P('obj', 66, 196.3, 406, 290.6, { idx: 2, prompt: 'Click to add text' }), P('body', 486, 132.6, 408, 63.7, { idx: 3, anchor: 'b', size: 24, prompt: 'Click to add heading' }), P('obj', 486, 196.3, 408, 290.6, { idx: 4, prompt: 'Click to add text' })]),
    L('Title Only', 'titleOnly', [title()]),
    L('Blank', 'blank', []),
    L('Content with Caption', 'objTx', [P('title', 66, 36, 309.6, 126, { anchor: 'b', size: 32, prompt: 'Click to add title' }), P('obj', 408, 77.8, 486, 383.6, { idx: 1, prompt: 'Click to add text' }), P('body', 66, 162, 309.6, 300, { idx: 2, size: 16, prompt: 'Click to add text' })]),
    L('Picture with Caption', 'picTx', [P('title', 66, 36, 309.6, 126, { anchor: 'b', size: 32, prompt: 'Click to add title' }), P('pic', 408, 77.8, 486, 383.6, { idx: 1, prompt: 'Click to add picture' }), P('body', 66, 162, 309.6, 300, { idx: 2, size: 16, prompt: 'Click to add text' })]),
    L('Title and Vertical Text', 'vertTx', [title(), P('body', 66, 144, 828, 342.9, { idx: 1, prompt: 'Click to add text' })]),
    L('Big Statement', 'titleOnly', [P('title', 66, 100, 828, 340, { anchor: 'ctr', align: 'ctr', size: 54, prompt: 'Click to add a statement' })]),
  ];
}

export function defaultMaster(theme: Theme, w = 960, h = 540): Master {
  const id = newId('mst');
  const sx = w / 960, sy = h / 540;
  const P = (type: PlaceholderType, x: number, y: number, ww: number, hh: number, extra: any = {}) => ph(type, x * sx, y * sy, ww * sx, hh * sy, extra);
  return {
    id, name: theme.name, theme: theme.id, styles: defaultStyles(), bg: { type: 'solid', color: 'bg1' },
    clrMap: { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' },
    elements: [
      P('title', 66, 28.8, 828, 104.5, { anchor: 'ctr', prompt: 'Click to edit master title style' }),
      P('body', 66, 144, 828, 342.9, { idx: 1, prompt: 'Click to edit master text styles' }),
      P('dt', 66, 500.5, 216, 28.75, { idx: 2, size: 12 }), P('ftr', 318, 500.5, 324, 28.75, { idx: 3, align: 'ctr', size: 12 }), P('sldNum', 678, 500.5, 216, 28.75, { idx: 4, align: 'r', size: 12 }),
    ],
  };
}

// ------------------------------------------------------------------------------------------

export class Deck {
  data: DeckData;
  media: Record<string, MediaItem> = {};
  version = 0;
  onChange: (() => void) | null = null;
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private depth = 0;
  /** Label of the open transaction. */
  private pending: UndoEntry | null = null;
  maxUndo = 200;

  constructor(data?: DeckData) {
    this.data = data || Deck.blankData();
  }

  static blankData(size = { w: 960, h: 540 }, themePreset = 0): DeckData {
    const theme = defaultTheme('theme1', themePreset);
    const master = defaultMaster(theme, size.w, size.h);
    const layouts = defaultLayouts(master.id, size.w, size.h);
    return { size: { ...size }, slides: [], layouts, masters: [master], themes: [theme], sections: [], customShows: [], props: {}, show: {} };
  }

  /** A new presentation with one title slide. */
  static blank(themePreset = 0): Deck {
    const d = new Deck(Deck.blankData(undefined, themePreset));
    d.data.slides.push(d.makeSlide(d.data.layouts[0].id));
    return d;
  }

  // ------------------------------------------------------------------------------------------
  // Lookup

  get slides(): Slide[] { return this.data.slides; }
  get size(): { w: number; h: number } { return this.data.size; }
  slide(id: string): Slide | undefined { return this.data.slides.find((s) => s.id === id); }
  slideIndex(id: string): number { return this.data.slides.findIndex((s) => s.id === id); }
  layout(id: string): Layout { return this.data.layouts.find((l) => l.id === id) || this.data.layouts[0]; }
  master(id: string): Master { return this.data.masters.find((m) => m.id === id) || this.data.masters[0]; }
  masterOf(slide: Slide | Layout): Master { return 'master' in slide ? this.master(slide.master) : this.master(this.layout(slide.layout).master); }
  theme(id?: string): Theme { return this.data.themes.find((t) => t.id === id) || this.data.themes[0]; }
  themeOf(s: Slide | Layout | Master): Theme {
    const m = 'styles' in s ? s : this.masterOf(s as Slide | Layout);
    return this.theme(m.theme);
  }
  layoutsOf(masterId: string): Layout[] { return this.data.layouts.filter((l) => l.master === masterId); }
  layoutByType(type: string, masterId?: string): Layout | undefined {
    return this.data.layouts.find((l) => l.type === type && (!masterId || l.master === masterId));
  }
  sectionOf(slideId: string): Section | undefined { return this.data.sections.find((s) => s.slides.includes(slideId)); }

  /** Finds an element anywhere on a slide (including inside groups). */
  findElement(slide: { elements: Element[] }, id: string): Element | undefined {
    const walk = (els: Element[]): Element | undefined => {
      for (const e of els) {
        if (e.id === id) return e;
        if (e.kind === 'group') { const f = walk(e.children); if (f) return f; }
      }
      return undefined;
    };
    return walk(slide.elements);
  }

  /** A slide built from a layout: one empty placeholder per layout placeholder (except footers). */
  makeSlide(layoutId: string): Slide {
    const lay = this.layout(layoutId);
    const elements: Element[] = [];
    for (const e of lay.elements) {
      if (!e.ph || ['dt', 'ftr', 'sldNum', 'hdr'].includes(e.ph.type)) continue;
      elements.push({ id: newId('sp'), kind: 'shape', geom: 'rect', name: e.name, ph: { ...e.ph }, text: { paras: [{ level: 0, runs: [] }] } });
    }
    return { id: newId('sld'), layout: lay.id, elements, notes: [], anims: [] };
  }

  addMedia(item: MediaItem): string {
    // Reuse identical media.
    for (const [k, v] of Object.entries(this.media)) if (v.b64 === item.b64) return k;
    const id = newId('m');
    this.media[id] = item;
    return id;
  }

  mediaUrl(id: string): string {
    const m = Object.prototype.hasOwnProperty.call(this.media, id) ? this.media[id] : undefined;
    if (!m || typeof m !== 'object') return '';
    let url = urlCache.get(m);
    if (url === undefined) {
      url = validMedia(m) ? `data:${m.mime};base64,${/\s/.test(m.b64) ? m.b64.replace(/\s+/g, '') : m.b64}` : '';
      urlCache.set(m, url);
    }
    return url;
  }

  // ------------------------------------------------------------------------------------------
  // Transactions

  /**
   * Runs fn as one undoable step. Pass the ids of the slides fn changes when it changes nothing else
   * (no slide added, removed or reordered, no layout or master edited); otherwise the whole document
   * is recorded.
   */
  transact<T>(label: string, fn: () => T, slides?: string[]): T {
    const outer = this.depth === 0;
    // Nested transactions join the outer one, whose scope must cover them.
    if (outer) this.pending = { label, before: this.image(slides) };
    this.depth++;
    let ok = false;
    try {
      const r = fn();
      ok = true;
      return r;
    } finally {
      this.depth--;
      if (outer) {
        const entry = this.pending!;
        this.pending = null;
        if (ok) {
          this.undoStack.push(entry);
          if (this.undoStack.length > this.maxUndo) this.undoStack.shift();
          this.redoStack = [];
          this.changed();
        } else {
          this.restore(entry.before);
          this.changed();
        }
      }
    }
  }

  private image(slides?: string[]): Image {
    if (slides) return { kind: 'slides', ids: [...slides], slides: slides.map((id) => { const s = this.slide(id); return s ? clone(s) : null; }) };
    return { kind: 'all', data: clone(this.data) };
  }

  private restore(img: Image): void {
    if (img.kind === 'all') { this.data = clone(img.data); return; }
    img.ids.forEach((id, i) => {
      const at = this.slideIndex(id);
      const s = img.slides[i];
      if (at >= 0 && s) this.data.slides[at] = clone(s);
    });
  }

  private sameScope(img: Image): Image {
    return img.kind === 'all' ? this.image() : this.image(img.ids);
  }

  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  get undoLabel(): string { return this.undoStack[this.undoStack.length - 1]?.label || ''; }
  get redoLabel(): string { return this.redoStack[this.redoStack.length - 1]?.label || ''; }
  undoLabels(): string[] { return this.undoStack.map((e) => e.label).reverse(); }

  undo(): boolean {
    const e = this.undoStack.pop();
    if (!e) return false;
    e.after = this.sameScope(e.before);
    this.restore(e.before);
    this.redoStack.push(e);
    this.changed();
    return true;
  }

  redo(): boolean {
    const e = this.redoStack.pop();
    if (!e || !e.after) return false;
    e.before = this.sameScope(e.after);
    this.restore(e.after);
    this.undoStack.push(e);
    this.changed();
    return true;
  }

  clearHistory(): void { this.undoStack = []; this.redoStack = []; }

  changed(): void {
    this.version++;
    this.data.props.modified = Date.now();
    this.onChange?.();
  }

  // ------------------------------------------------------------------------------------------
  // Serialization (native .qsp JSON)

  toJSON(): { format: 'quillstage'; version: 1; data: DeckData; media: Record<string, MediaItem> } {
    return { format: 'quillstage', version: 1, data: this.data, media: this.media };
  }

  static fromJSON(j: any): Deck {
    if (!j || typeof j !== 'object' || !j.data || !Array.isArray(j.data.slides)) throw new Error('Not an Anne\'s Stage presentation');
    const d = new Deck(normalizeData(j.data));
    d.media = sanitizeMedia(j.media);
    return d;
  }
}

/** Fills in fields older or foreign data may lack, so the rest of the app can rely on them. */
export function normalizeData(d: any): DeckData {
  const base = Deck.blankData(d.size && d.size.w > 0 && d.size.h > 0 ? d.size : undefined);
  const out: DeckData = {
    ...base, ...d,
    size: d.size && d.size.w > 0 && d.size.h > 0 ? d.size : base.size,
    themes: Array.isArray(d.themes) && d.themes.length ? d.themes : base.themes,
    masters: Array.isArray(d.masters) && d.masters.length ? d.masters : base.masters,
    layouts: Array.isArray(d.layouts) && d.layouts.length ? d.layouts : base.layouts,
    sections: Array.isArray(d.sections) ? d.sections : [],
    customShows: Array.isArray(d.customShows) ? d.customShows : [],
    props: d.props || {},
    show: d.show || {},
  };
  for (const t of out.themes) {
    if (!t || typeof t !== 'object') continue;
    const colors: any = t.colors && typeof t.colors === 'object' ? t.colors : {};
    const def: any = base.themes[0].colors;
    const clean: any = {};
    for (const [k, v] of Object.entries(colors)) {
      const hex = safeHex(v) || (typeof v === 'string' && /^[0-9a-f]{6}$/i.test(v) ? `#${v.toUpperCase()}` : null);
      clean[k] = hex || def[k] || '#000000';
    }
    t.colors = clean;
    if (!t.fonts || typeof t.fonts !== 'object') t.fonts = { ...base.themes[0].fonts };
  }
  for (const m of out.masters) { if (!m.styles) m.styles = defaultStyles(); if (!m.elements) m.elements = []; }
  if (!Array.isArray(d.layouts) || !d.layouts.length) for (const l of out.layouts) l.master = out.masters[0].id;
  for (const s of out.slides) {
    if (!Array.isArray(s.elements)) s.elements = [];
    if (!Array.isArray(s.notes)) s.notes = [];
    if (!Array.isArray(s.anims)) s.anims = [];
    if (!out.layouts.some((l) => l.id === s.layout)) s.layout = out.layouts[0].id;
  }
  return out;
}
