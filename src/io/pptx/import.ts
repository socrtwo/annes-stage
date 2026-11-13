/**
 * PresentationML (.pptx, .pptm, .ppsx, .potx) import, written from ECMA-376. Elements are matched
 * by local name, so Strict and Transitional files and prefix variations read the same way. The
 * importer is lenient: a part that cannot be read is skipped with a warning, never fatal.
 */
import { readZipCapped } from '../zip';
import { Deck, newId, defaultStyles } from '../../model/deck';
import type {
  Animation, AnimClass, AnimEffect, Bullet, ChartElement, ChartType, Color, DeckData, Effects, Element as SEl, Fill, GroupElement, Layout, LevelStyle, Line,
  Master, MediaElement, NumScheme, Paragraph, ParaProps, PictureElement, PlaceholderType, Run, RunProps, SchemeColor, ShapeElement, Slide, TableCell,
  TableElement, TextBody, Theme, Transition, TransitionType,
} from '../../model/types';
import { defaultTheme } from '../../model/theme';
import { attr, attrQ, b64, bool, decodeXml, desc, firstDesc, kid, kids, kidsNamed, num, parseXml, path, sniffMediaMime } from '../xml';
import { ENTR_PRESETS, EMPH_PRESETS, SUBTYPE_DIR, relsPartOf, resolveTarget } from './common';

export type Pkg = Map<string, Uint8Array>;

interface Rel { id: string; type: string; target: string; external: boolean }

export interface PptxImportResult { deck: Deck; warnings: string[]; /** Parts that failed to parse. */ badParts: string[] }

/**
 * Reads a package's parts with size caps: XML parts first, then only the binaries (media, fonts,
 * macros) that some relationship names, so unreferenced or oversized entries are never inflated.
 */
export async function readZip(data: Uint8Array, warnings: string[] = []): Promise<Pkg> {
  const r = await readZipCapped(data, {
    rename: (n) => n.replace(/^\/+/, ''),
    phase2: (files) => {
      let rels = '';
      for (const [k, v] of files) if (/\.rels$/i.test(k)) rels += decodeXml(v);
      return (name) => { const base = name.split('/').pop() || name; return rels.includes(base) || rels.includes(encodeURI(base)); };
    },
  });
  warnings.push(...r.warnings);
  return r.files;
}

export async function importPptx(data: Uint8Array): Promise<PptxImportResult> {
  const zipWarnings: string[] = [];
  const r = importPptxPkg(await readZip(data, zipWarnings));
  r.warnings.push(...zipWarnings);
  return r;
}

const PRESET_COLORS: Record<string, string> = { black: '#000000', white: '#FFFFFF', red: '#FF0000', green: '#008000', blue: '#0000FF', yellow: '#FFFF00', gray: '#808080', orange: '#FFA500', purple: '#800080', darkBlue: '#00008B', darkRed: '#8B0000', lightGray: '#D3D3D3', darkGray: '#A9A9A9', cyan: '#00FFFF', magenta: '#FF00FF' };
const SCHEME_KEYS: SchemeColor[] = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];
const COLOR_TAGS = ['srgbClr', 'schemeClr', 'sysClr', 'prstClr', 'scrgbClr', 'hslClr'];

/** The color element inside a container (solidFill, buClr, …). */
export function parseColor(container: Element | null | undefined): Color | undefined {
  if (!container) return undefined;
  const c = COLOR_TAGS.includes(container.localName) ? container : kids(container).find((k) => COLOR_TAGS.includes(k.localName));
  if (!c) return undefined;
  let base: string;
  switch (c.localName) {
    case 'srgbClr': base = '#' + (attr(c, 'val') || '000000').toUpperCase(); break;
    case 'schemeClr': base = attr(c, 'val') || 'tx1'; break;
    case 'sysClr': base = '#' + (attr(c, 'lastClr') || (attr(c, 'val') === 'window' ? 'FFFFFF' : '000000')).toUpperCase(); break;
    case 'prstClr': base = PRESET_COLORS[attr(c, 'val') || ''] || '#000000'; break;
    case 'scrgbClr': {
      const ch = (k: string) => Math.round(Math.max(0, Math.min(1, (num(c, k) || 0) / 100000)) * 255).toString(16).padStart(2, '0');
      base = `#${ch('r')}${ch('g')}${ch('b')}`.toUpperCase(); break;
    }
    default: base = '#808080';
  }
  let lum = 0, alpha: number | undefined;
  const lumMod = num(kid(c, 'lumMod'), 'val'), lumOff = num(kid(c, 'lumOff'), 'val');
  const tint = num(kid(c, 'tint'), 'val'), shade = num(kid(c, 'shade'), 'val');
  if (lumOff != null && lumOff > 0) lum = lumOff / 100000;
  else if (lumMod != null && lumMod < 100000) lum = lumMod / 100000 - 1;
  if (tint != null && tint < 100000) lum = 1 - tint / 100000;
  if (shade != null && shade < 100000) lum = shade / 100000 - 1;
  const a = num(kid(c, 'alpha'), 'val');
  if (a != null && a < 100000) alpha = a / 100000;
  if (!lum && alpha == null) return base;
  return { s: base, ...(lum ? { lum: +lum.toFixed(3) } : {}), ...(alpha != null ? { alpha } : {}) };
}

/** Most data points read from one chart cache. */
const CHART_MAX_POINTS = 10000;

const ALGN: Record<string, ParaProps['align']> = { l: 'l', ctr: 'ctr', r: 'r', just: 'just', justLow: 'just', dist: 'dist', thaiDist: 'dist' };
const AUTONUM: Record<string, NumScheme> = { arabicPeriod: 'arabicPeriod', arabicParenR: 'arabicParenR', arabicPlain: 'arabicPlain', alphaLcPeriod: 'alphaLcPeriod', alphaUcPeriod: 'alphaUcPeriod', alphaLcParenR: 'alphaLcParenR', alphaUcParenR: 'alphaUcPeriod', romanLcPeriod: 'romanLcPeriod', romanUcPeriod: 'romanUcPeriod', arabicParenBoth: 'arabicParenR' };

class Importer {
  warnings: string[] = [];
  badParts: string[] = [];
  deck = new Deck();
  private docs = new Map<string, Document | null>();
  private relCache = new Map<string, Rel[]>();
  private mediaByPart = new Map<string, string>();
  /** Element ids already given out, per id prefix (one per part). */
  private usedIds = new Map<string, Set<string>>();
  /** Theme fill styles of the current master's theme (for fillRef). */
  constructor(public pkg: Pkg) {}

  xml(part: string): Document | null {
    if (this.docs.has(part)) return this.docs.get(part)!;
    const bytes = this.pkg.get(part);
    let d: Document | null = null;
    if (bytes) {
      d = parseXml(decodeXml(bytes));
      if (!d) { this.badParts.push(part); this.warnings.push(`Could not read ${part}; it was skipped.`); }
    }
    this.docs.set(part, d);
    return d;
  }

  rels(part: string): Rel[] {
    let r = this.relCache.get(part);
    if (r) return r;
    r = [];
    const d = this.xml(relsPartOf(part));
    for (const e of desc(d, 'Relationship')) {
      const external = attr(e, 'TargetMode') === 'External';
      const t = attr(e, 'Target') || '';
      r.push({ id: attr(e, 'Id') || '', type: attr(e, 'Type') || '', target: external ? t : resolveTarget(part, t), external });
    }
    this.relCache.set(part, r);
    return r;
  }

  rel(part: string, id: string | null): Rel | undefined { return id ? this.rels(part).find((r) => r.id === id) : undefined; }
  relOfType(part: string, suffix: string): Rel[] { return this.rels(part).filter((r) => r.type.endsWith('/' + suffix)); }

  media(part: string): string | undefined {
    if (this.mediaByPart.has(part)) return this.mediaByPart.get(part);
    const bytes = this.pkg.get(part);
    if (!bytes) { this.warnings.push(`Missing media ${part}.`); return undefined; }
    const id = this.deck.addMedia({ mime: sniffMediaMime(bytes, part), b64: b64(bytes), name: part.split('/').pop() });
    this.mediaByPart.set(part, id);
    return id;
  }

  // ------------------------------------------------------------------------------------------

  run(): PptxImportResult {
    const root = this.relOfType('', 'officeDocument')[0] || this.rels('').find((r) => /presentation\.xml$/.test(r.target));
    const presPart = root?.target || [...this.pkg.keys()].find((k) => /(^|\/)presentation\.xml$/.test(k)) || 'ppt/presentation.xml';
    const pres = this.xml(presPart);
    if (!pres) throw new Error('This file has no readable presentation part (ppt/presentation.xml).');
    const P = pres.documentElement;
    const data: DeckData = this.deck.data;
    data.slides = []; data.layouts = []; data.masters = []; data.themes = [];
    const sz = kid(P, 'sldSz');
    if (sz) data.size = { w: (num(sz, 'cx') || 12192000) / 12700, h: (num(sz, 'cy') || 6858000) / 12700 };
    const fsn = num(P, 'firstSlideNum');
    if (fsn != null && fsn !== 1) data.firstNumber = fsn;

    // Masters (each with its theme and layouts)
    const layoutIds = new Map<string, string>();
    for (const mid of kidsNamed(kid(P, 'sldMasterIdLst'), 'sldMasterId')) {
      const rel = this.rel(presPart, attrQ(mid, 'r:id'));
      if (rel) this.readMaster(rel.target, layoutIds);
    }
    if (!data.masters.length) {
      // No master list: read any master parts present.
      for (const k of [...this.pkg.keys()].filter((k) => /slideMasters\/slideMaster\d+\.xml$/.test(k)).sort()) this.readMaster(k, layoutIds);
    }
    if (!data.masters.length) {
      const fresh = Deck.blankData(data.size);
      data.masters = fresh.masters; data.layouts = fresh.layouts; data.themes = fresh.themes;
      this.warnings.push('The slide master was missing; a default master was used.');
    }

    // Slides
    const sldIdMap = new Map<string, string>();
    const slidePartMap = new Map<string, string>();
    const sldIds = kidsNamed(kid(P, 'sldIdLst'), 'sldId');
    let parts: { part: string; pid: string }[] = sldIds.map((s) => ({ part: this.rel(presPart, attrQ(s, 'r:id'))?.target || '', pid: attr(s, 'id') || '' })).filter((x) => x.part);
    if (!parts.length) {
      parts = [...this.pkg.keys()].filter((k) => /slides\/slide\d+\.xml$/.test(k)).sort((a, b) => +(/(\d+)\.xml$/.exec(a)![1]) - +(/(\d+)\.xml$/.exec(b)![1])).map((part) => ({ part, pid: '' }));
    }
    parts.forEach(({ part, pid }, i) => {
      try {
        const s = this.readSlide(part, i, layoutIds);
        if (!s) return;
        data.slides.push(s);
        if (pid) sldIdMap.set(pid, s.id);
        slidePartMap.set(part, s.id);
      } catch (e: any) {
        this.badParts.push(part);
        this.warnings.push(`Slide ${i + 1} could not be read (${e?.message || e}); it was skipped.`);
      }
    });

    // Sections (p14:sectionLst)
    for (const sec of desc(P, 'section')) {
      const ids = desc(sec, 'sldId').map((s) => sldIdMap.get(attr(s, 'id') || '')).filter(Boolean) as string[];
      data.sections.push({ id: newId('sec'), name: attr(sec, 'name') || 'Section', slides: ids });
    }
    // Custom shows
    for (const cs of desc(kid(P, 'custShowLst'), 'custShow')) {
      const ids = desc(cs, 'sld').map((s) => slidePartMap.get(this.rel(presPart, attrQ(s, 'r:id'))?.target || '')).filter(Boolean) as string[];
      data.customShows.push({ id: newId('cs'), name: attr(cs, 'name') || 'Custom Show', slides: ids });
    }
    // Show settings
    const pp = this.relOfType(presPart, 'presProps')[0];
    const ppx = pp ? this.xml(pp.target) : null;
    const showPr = firstDesc(ppx, 'showPr');
    if (showPr) {
      if (bool(showPr, 'loop')) data.show.loop = true;
      if (kid(showPr, 'kiosk')) data.show.kiosk = true;
      if (bool(showPr, 'useTimings') === false) data.show.useTimings = false;
    }
    this.readProps();
    const vba = [...this.pkg.keys()].find((k) => /vbaProject\.bin$/i.test(k));
    if (vba) data.vba = b64(this.pkg.get(vba)!);
    this.deck.clearHistory();
    return { deck: this.deck, warnings: this.warnings, badParts: this.badParts };
  }

  private readProps(): void {
    const props = this.deck.data.props;
    const core = this.xml('docProps/core.xml');
    if (core) {
      const t = (n: string) => firstDesc(core, n)?.textContent?.trim() || undefined;
      props.title = t('title'); props.subject = t('subject'); props.author = t('creator'); props.keywords = t('keywords');
      props.description = t('description'); props.lastModifiedBy = t('lastModifiedBy'); props.category = t('category');
      const c = t('created'), m = t('modified');
      if (c && !isNaN(Date.parse(c))) props.created = Date.parse(c);
      if (m && !isNaN(Date.parse(m))) props.modified = Date.parse(m);
    }
    const app = this.xml('docProps/app.xml');
    const co = firstDesc(app, 'Company')?.textContent?.trim();
    if (co) props.company = co;
    for (const k of Object.keys(props) as (keyof typeof props)[]) if (props[k] === undefined) delete props[k];
  }

  private readTheme(part: string): Theme {
    const existing = this.deck.data.themes.find((t) => t.keep?.part === part);
    if (existing) return existing;
    const th = defaultTheme(newId('th'));
    th.keep = { part };
    const d = this.xml(part);
    if (d) {
      th.name = attr(d.documentElement, 'name') || th.name;
      const cs = firstDesc(d, 'clrScheme');
      for (const k of SCHEME_KEYS) {
        const c = parseColor(kid(cs, k));
        if (typeof c === 'string' && c.startsWith('#')) th.colors[k] = c;
      }
      const fs = firstDesc(d, 'fontScheme');
      const maj = attr(path(fs, 'majorFont', 'latin'), 'typeface'), min = attr(path(fs, 'minorFont', 'latin'), 'typeface');
      if (maj) th.fonts.major = maj;
      if (min) th.fonts.minor = min;
      const fmt = firstDesc(d, 'fmtScheme');
      // Keep the format scheme verbatim unless it points at package parts (blip fills): the
      // theme's relationships and media are not carried, so such a scheme falls back to the default.
      if (fmt) {
        const x = new XMLSerializer().serializeToString(fmt);
        if (/\br:(embed|link|id)=|:(embed|link)="rId/.test(x)) this.warnings.push('The theme\'s picture fill styles were replaced by the default format scheme.');
        else th.keep.fmtScheme = x;
      }
    }
    this.deck.data.themes.push(th);
    return th;
  }

  private readMaster(part: string, layoutIds: Map<string, string>): void {
    const d = this.xml(part);
    if (!d) return;
    const R = d.documentElement;
    const themeRel = this.relOfType(part, 'theme')[0];
    const theme = themeRel ? this.readTheme(themeRel.target) : (this.deck.data.themes[0] || (() => { const t = defaultTheme(newId('th')); this.deck.data.themes.push(t); return t; })());
    const id = newId('mst');
    const styles = defaultStyles();
    const tx = kid(R, 'txStyles');
    if (tx) {
      const lv = (el: Element | null) => {
        const out: LevelStyle[] = [];
        for (let i = 1; i <= 9; i++) { const p = kid(el, `lvl${i}pPr`); if (p) out[i - 1] = this.levelStyle(p); else if (out.length) out[i - 1] = { ...out[i - 2] }; }
        return out;
      };
      const t = lv(kid(tx, 'titleStyle')), b = lv(kid(tx, 'bodyStyle')), o = lv(kid(tx, 'otherStyle'));
      if (t.length) styles.title = t;
      if (b.length) styles.body = b;
      if (o.length) styles.other = o;
    }
    const cm = kid(R, 'clrMap');
    const clrMap: Master['clrMap'] = {};
    if (cm) for (const k of ['bg1', 'tx1', 'bg2', 'tx2'] as const) { const v = attr(cm, k); if (v && SCHEME_KEYS.includes(v as SchemeColor)) clrMap[k] = v as SchemeColor; }
    const master: Master = { id, name: attr(kid(R, 'cSld'), 'name') || theme.name, elements: [], styles, theme: theme.id, clrMap, keep: { part } };
    const ctx = { part, prefix: 'm' + this.deck.data.masters.length + '_' };
    master.bg = this.background(kid(R, 'cSld'), part);
    master.elements = this.tree(path(R, 'cSld', 'spTree'), ctx);
    this.deck.data.masters.push(master);
    for (const lr of this.relOfType(part, 'slideLayout')) {
      if (layoutIds.has(lr.target)) continue;
      const lay = this.readLayout(lr.target, master.id);
      if (lay) { this.deck.data.layouts.push(lay); layoutIds.set(lr.target, lay.id); }
    }
  }

  private readLayout(part: string, masterId: string): Layout | null {
    const d = this.xml(part);
    if (!d) return null;
    const R = d.documentElement;
    const lay: Layout = { id: newId('lay'), name: attr(kid(R, 'cSld'), 'name') || 'Layout', master: masterId, type: attr(R, 'type') || 'cust', elements: [], keep: { part } };
    if (attr(R, 'showMasterSp') === '0') lay.hideMasterShapes = true;
    lay.bg = this.background(kid(R, 'cSld'), part);
    lay.elements = this.tree(path(R, 'cSld', 'spTree'), { part, prefix: 'l' + this.deck.data.layouts.length + '_' });
    return lay;
  }

  private readSlide(part: string, index: number, layoutIds: Map<string, string>): Slide | null {
    const d = this.xml(part);
    if (!d) return null;
    const R = d.documentElement;
    const lr = this.relOfType(part, 'slideLayout')[0];
    let layout = lr ? layoutIds.get(lr.target) : undefined;
    if (!layout && lr) {
      // A layout not listed by any master.
      const lay = this.readLayout(lr.target, this.deck.data.masters[0].id);
      if (lay) { this.deck.data.layouts.push(lay); layoutIds.set(lr.target, lay.id); layout = lay.id; }
    }
    const slide: Slide = { id: newId('sld'), layout: layout || this.deck.data.layouts[0].id, elements: [], notes: [], anims: [] };
    const ctx = { part, prefix: `s${index}_` };
    const cSld = kid(R, 'cSld');
    const nm = attr(cSld, 'name');
    if (nm) slide.name = nm;
    slide.bg = this.background(cSld, part);
    slide.elements = this.tree(kid(cSld, 'spTree'), ctx);
    if (attr(R, 'show') === '0') slide.hidden = true;
    if (attr(R, 'showMasterSp') === '0') slide.hideMasterShapes = true;
    const tr = this.transition(R);
    if (tr) slide.transition = tr;
    try { slide.anims = this.timing(kid(R, 'timing'), ctx.prefix); } catch { this.warnings.push(`Animations on slide ${index + 1} could not be read.`); }
    const nr = this.relOfType(part, 'notesSlide')[0];
    if (nr) {
      const nd = this.xml(nr.target);
      const sps = desc(nd, 'sp');
      // The body placeholder holds the notes; some producers write a plain text box instead.
      const body = sps.find((sp) => attr(firstDesc(sp, 'ph'), 'type') === 'body')
        || sps.find((sp) => !firstDesc(sp, 'ph') && firstDesc(sp, 't'));
      const tb = body ? this.textBody(kid(body, 'txBody'), nr.target) : undefined;
      if (tb && tb.paras.some((p) => p.runs.some((r) => r.text))) slide.notes = tb.paras;
    }
    return slide;
  }

  // ------------------------------------------------------------------------------------------
  // Shapes

  private background(cSld: Element | null, part: string): Fill | undefined {
    const bg = kid(cSld, 'bg');
    if (!bg) return undefined;
    const pr = kid(bg, 'bgPr');
    if (pr) return this.fill(pr, part);
    const ref = kid(bg, 'bgRef');
    if (ref) { const c = parseColor(ref); return c ? { type: 'solid', color: c } : undefined; }
    return undefined;
  }

  tree(spTree: Element | null, ctx: { part: string; prefix: string }, xf?: (x: number, y: number, w: number, h: number) => [number, number, number, number]): SEl[] {
    const out: SEl[] = [];
    for (let node of kids(spTree)) {
      if (node.localName === 'AlternateContent') {
        const choice = kid(node, 'Choice');
        const pick = kids(choice).find((k) => ['sp', 'pic', 'grpSp', 'graphicFrame', 'cxnSp'].includes(k.localName)) || kids(kid(node, 'Fallback'))[0];
        if (!pick) continue;
        node = pick;
      }
      try {
        const e = this.element(node, ctx, xf);
        if (e) out.push(e);
      } catch (err: any) {
        this.warnings.push(`A shape in ${ctx.part} could not be read (${err?.message || err}).`);
      }
    }
    return out;
  }

  private nv(node: Element): { id: string; name?: string; alt?: string; title?: string; hidden?: boolean; ph?: { type: PlaceholderType; idx?: number }; nvPr: Element | null; cNvPr: Element | null; link?: Element | null } {
    const nvx = kids(node).find((k) => k.localName.startsWith('nv'));
    const cNvPr = kid(nvx, 'cNvPr');
    const nvPr = kid(nvx, 'nvPr');
    const ph = kid(nvPr, 'ph');
    const r: any = { id: attr(cNvPr, 'id') || newId(''), name: attr(cNvPr, 'name') || undefined, nvPr, cNvPr };
    const d = attr(cNvPr, 'descr'); if (d) r.alt = d;
    const t = attr(cNvPr, 'title'); if (t) r.title = t;
    if (attr(cNvPr, 'hidden') === '1') r.hidden = true;
    r.link = kid(cNvPr, 'hlinkClick');
    if (ph) {
      const idx = num(ph, 'idx');
      r.ph = { type: (attr(ph, 'type') || 'obj') as PlaceholderType, ...(idx != null ? { idx } : {}) };
    }
    return r;
  }

  private xfrm(x: Element | null, el: any, xf?: (x: number, y: number, w: number, h: number) => [number, number, number, number]): void {
    if (!x) return;
    const off = kid(x, 'off'), ext = kid(x, 'ext');
    if (off && ext) {
      let X = (num(off, 'x') || 0) / 12700, Y = (num(off, 'y') || 0) / 12700, W = (num(ext, 'cx') || 0) / 12700, H = (num(ext, 'cy') || 0) / 12700;
      if (xf) [X, Y, W, H] = xf(X, Y, W, H);
      el.x = X; el.y = Y; el.w = W; el.h = H;
    }
    const rot = num(x, 'rot');
    if (rot) el.rot = rot / 60000;
    if (attr(x, 'flipH') === '1') el.flipH = true;
    if (attr(x, 'flipV') === '1') el.flipV = true;
  }

  private element(node: Element, ctx: { part: string; prefix: string }, xf?: (x: number, y: number, w: number, h: number) => [number, number, number, number]): SEl | null {
    const kind = node.localName;
    if (!['sp', 'cxnSp', 'pic', 'grpSp', 'graphicFrame'].includes(kind)) return null;
    const nv = this.nv(node);
    // Shape ids must be unique within a part; a repeated cNvPr id gets a suffix. Animation and
    // connector references (spid, stCxn) keep resolving to the first shape with that id.
    let uid = `${ctx.prefix}${nv.id}`;
    let used = this.usedIds.get(ctx.prefix);
    if (!used) { used = new Set(); this.usedIds.set(ctx.prefix, used); }
    if (used.has(uid)) { let k = 2; while (used.has(`${uid}_${k}`)) k++; uid = `${uid}_${k}`; }
    used.add(uid);
    const base: any = { id: uid };
    if (nv.name) base.name = nv.name;
    if (nv.alt) base.alt = nv.alt;
    if (nv.title) base.title = nv.title;
    if (nv.hidden) base.hidden = true;
    if (nv.ph) base.ph = nv.ph;
    if (nv.link) {
      const action = attr(nv.link, 'action') || '';
      const r = this.rel(ctx.part, attrQ(nv.link, 'r:id'));
      if (/hlinkshowjump\?jump=nextslide/.test(action)) base.link = { action: 'next' };
      else if (/jump=previousslide/.test(action)) base.link = { action: 'prev' };
      else if (/jump=firstslide/.test(action)) base.link = { action: 'first' };
      else if (/jump=lastslide/.test(action)) base.link = { action: 'last' };
      else if (/jump=endshow/.test(action)) base.link = { action: 'end' };
      else if (r?.external) base.link = { url: r.target };
    }
    if (kind === 'grpSp') {
      const gp = kid(node, 'grpSpPr');
      const x = kid(gp, 'xfrm');
      const g: GroupElement = { ...base, kind: 'group', children: [] };
      this.xfrm(x, g, xf);
      const off = kid(x, 'off'), ext = kid(x, 'ext'), chOff = kid(x, 'chOff'), chExt = kid(x, 'chExt');
      const ox = (num(off, 'x') || 0) / 12700, oy = (num(off, 'y') || 0) / 12700, ew = (num(ext, 'cx') || 0) / 12700, eh = (num(ext, 'cy') || 0) / 12700;
      const cx = (num(chOff, 'x') ?? num(off, 'x') ?? 0) / 12700, cy = (num(chOff, 'y') ?? num(off, 'y') ?? 0) / 12700;
      const cw = (num(chExt, 'cx') ?? num(ext, 'cx') ?? 0) / 12700, ch = (num(chExt, 'cy') ?? num(ext, 'cy') ?? 0) / 12700;
      const sx = cw ? ew / cw : 1, sy = ch ? eh / ch : 1;
      const inner = (X: number, Y: number, W: number, H: number): [number, number, number, number] => {
        let r: [number, number, number, number] = [ox + (X - cx) * sx, oy + (Y - cy) * sy, W * sx, H * sy];
        if (xf) r = xf(...r);
        return r;
      };
      g.children = this.tree(node, ctx, inner);
      return g;
    }
    if (kind === 'graphicFrame') return this.graphicFrame(node, base, ctx, xf);
    const spPr = kid(node, 'spPr');
    if (kind === 'pic') {
      const blip = firstDesc(kid(node, 'blipFill'), 'blip');
      const rel = this.rel(ctx.part, attrQ(blip, 'r:embed'));
      const media = rel && !rel.external ? this.media(rel.target) : undefined;
      // Video and audio
      const vf = kid(nv.nvPr, 'videoFile') || kid(nv.nvPr, 'audioFile');
      const p14 = firstDesc(nv.nvPr, 'media');
      if (vf || p14) {
        const mrel = this.rel(ctx.part, attrQ(p14, 'r:embed')) || this.rel(ctx.part, attrQ(vf, 'r:link')) || this.rel(ctx.part, attrQ(vf, 'r:embed'));
        if (mrel && !mrel.external && this.pkg.has(mrel.target)) {
          const m: MediaElement = { ...base, kind: 'media', media: this.media(mrel.target)!, mediaKind: vf?.localName === 'audioFile' ? 'audio' : /audio/.test(sniffMediaMime(this.pkg.get(mrel.target)!, mrel.target)) ? 'audio' : 'video' };
          if (media) m.poster = media;
          this.xfrm(kid(spPr, 'xfrm'), m, xf);
          return m;
        }
      }
      const pic: PictureElement = { ...base, kind: 'picture', media: media || '' };
      if (!media) this.warnings.push(`A picture's image is missing (${nv.name || nv.id}).`);
      this.xfrm(kid(spPr, 'xfrm'), pic, xf);
      const src = firstDesc(kid(node, 'blipFill'), 'srcRect');
      if (src) {
        const f = (k: string) => (num(src, k) || 0) / 100000;
        const crop: [number, number, number, number] = [f('l'), f('t'), f('r'), f('b')];
        if (crop.some((v) => v)) pic.crop = crop;
      }
      const g = attr(kid(spPr, 'prstGeom'), 'prst');
      if (g && g !== 'rect') pic.geom = g;
      const ln = this.line(kid(spPr, 'ln'));
      if (ln) pic.line = ln;
      const fx = this.effects(kid(spPr, 'effectLst'));
      if (fx) pic.effects = fx;
      return pic;
    }
    // sp / cxnSp
    const sp: ShapeElement = { ...base, kind: 'shape', geom: 'rect' };
    this.xfrm(kid(spPr, 'xfrm'), sp, xf);
    const prst = kid(spPr, 'prstGeom');
    if (prst) {
      sp.geom = attr(prst, 'prst') || 'rect';
      const adj: Record<string, number> = {};
      for (const gd of desc(kid(prst, 'avLst'), 'gd')) { const m = /^val\s+(-?\d+)/.exec(attr(gd, 'fmla') || ''); if (m) adj[attr(gd, 'name') || 'adj'] = +m[1]; }
      if (Object.keys(adj).length) sp.adj = adj;
    } else if (kid(spPr, 'custGeom')) {
      sp.geom = 'custom';
      sp.path = this.custGeom(kid(spPr, 'custGeom')!);
    } else if (kind === 'cxnSp') sp.geom = 'line';
    if (kind === 'cxnSp') {
      const cnv = kid(kid(node, 'nvCxnSpPr'), 'cNvCxnSpPr');
      const st = kid(cnv, 'stCxn'), en = kid(cnv, 'endCxn');
      if (st || en) sp.conn = { ...(st ? { start: { id: ctx.prefix + attr(st, 'id'), idx: num(st, 'idx') || 0 } } : {}), ...(en ? { end: { id: ctx.prefix + attr(en, 'id'), idx: num(en, 'idx') || 0 } } : {}) };
    }
    if (attr(kid(kid(node, 'nvSpPr'), 'cNvSpPr'), 'txBox') === '1') sp.textbox = true;
    const fill = this.fill(spPr, ctx.part);
    const style = kid(node, 'style');
    if (fill) sp.fill = fill;
    else if (style && !nv.ph) {
      const fr = kid(style, 'fillRef');
      if (fr && (num(fr, 'idx') || 0) > 0) { const c = parseColor(fr); if (c) sp.fill = { type: 'solid', color: c }; }
      else if (fr) sp.fill = { type: 'none' };
    }
    const ln = this.line(kid(spPr, 'ln'));
    const lnRef = kid(style, 'lnRef');
    if (ln) {
      if (!ln.fill && lnRef && (num(lnRef, 'idx') || 0) > 0) { const c = parseColor(lnRef); if (c) ln.fill = { type: 'solid', color: c }; }
      sp.line = ln;
    } else if (style && !nv.ph) {
      if (lnRef && (num(lnRef, 'idx') || 0) > 0) { const c = parseColor(lnRef); sp.line = c ? { fill: { type: 'solid', color: c }, width: 0.75 * (num(lnRef, 'idx') || 1) } : {}; }
      else sp.line = { fill: { type: 'none' } };
    } else if (!nv.ph && !style) {
      if (!fill) sp.fill = { type: 'none' };
      sp.line = { fill: { type: 'none' } };
    }
    const fx = this.effects(kid(spPr, 'effectLst'));
    if (fx) sp.effects = fx;
    const tb = this.textBody(kid(node, 'txBody'), ctx.part);
    if (tb) sp.text = tb;
    // Text color from the shape style (fontRef) for ordinary shapes.
    const fontRef = kid(style, 'fontRef');
    const fc = parseColor(fontRef);
    if (fc && !nv.ph) {
      sp.text = sp.text || { paras: [{ level: 0, runs: [] }] };
      const lv = sp.text.levels || [];
      for (let i = 0; i < 9; i++) lv[i] = { ...(lv[i] || {}), run: { color: fc, ...(lv[i]?.run || {}) } };
      sp.text.levels = lv;
      if (sp.text.anchor == null && !sp.textbox) sp.text.anchor = 'ctr';
    }
    if (sp.text && !nv.ph && !sp.textbox && sp.text.levels?.[0] && sp.text.levels[0].align == null && style) sp.text.levels[0] = { ...sp.text.levels[0] };
    return sp;
  }

  private custGeom(cg: Element): { d: string; w: number; h: number }[] {
    const out: { d: string; w: number; h: number }[] = [];
    for (const p of desc(kid(cg, 'pathLst'), 'path')) {
      const w = num(p, 'w') || 1, h = num(p, 'h') || 1;
      const parts: string[] = [];
      let cx = 0, cy = 0;
      const pt = (e: Element | null) => [num(e, 'x') || 0, num(e, 'y') || 0];
      for (const c of kids(p)) {
        const pts = kidsNamed(c, 'pt').map(pt);
        switch (c.localName) {
          case 'moveTo': [cx, cy] = pts[0] || [0, 0]; parts.push(`M${cx} ${cy}`); break;
          case 'lnTo': [cx, cy] = pts[0] || [cx, cy]; parts.push(`L${cx} ${cy}`); break;
          case 'cubicBezTo': if (pts.length === 3) { parts.push(`C${pts.map((q) => q.join(' ')).join(' ')}`); [cx, cy] = pts[2]; } break;
          case 'quadBezTo': if (pts.length === 2) { parts.push(`Q${pts.map((q) => q.join(' ')).join(' ')}`); [cx, cy] = pts[1]; } break;
          case 'arcTo': {
            const wR = num(c, 'wR') || 0, hR = num(c, 'hR') || 0;
            const st = ((num(c, 'stAng') || 0) / 60000) * Math.PI / 180, sw = ((num(c, 'swAng') || 0) / 60000) * Math.PI / 180;
            const ox = cx - wR * Math.cos(st), oy = cy - hR * Math.sin(st);
            const ex = ox + wR * Math.cos(st + sw), ey = oy + hR * Math.sin(st + sw);
            parts.push(`A${wR} ${hR} 0 ${Math.abs(sw) > Math.PI ? 1 : 0} ${sw > 0 ? 1 : 0} ${+ex.toFixed(2)} ${+ey.toFixed(2)}`);
            cx = ex; cy = ey; break;
          }
          case 'close': parts.push('Z'); break;
        }
      }
      if (parts.length) out.push({ d: parts.join(' '), w, h });
    }
    return out;
  }

  fill(container: Element | null, part: string): Fill | undefined {
    if (!container) return undefined;
    for (const c of kids(container)) {
      switch (c.localName) {
        case 'noFill': return { type: 'none' };
        case 'solidFill': { const col = parseColor(c); return col ? { type: 'solid', color: col } : undefined; }
        case 'gradFill': {
          const stops = desc(kid(c, 'gsLst'), 'gs').map((gs) => ({ pos: (num(gs, 'pos') || 0) / 100000, color: parseColor(gs) || '#FFFFFF' }));
          if (!stops.length) return undefined;
          const lin = kid(c, 'lin');
          return { type: 'gradient', stops, ...(lin ? { angle: (num(lin, 'ang') || 0) / 60000 } : {}), ...(kid(c, 'path') ? { path: 'radial' as const } : {}) };
        }
        case 'blipFill': {
          const blip = kid(c, 'blip');
          const rel = this.rel(part, attrQ(blip, 'r:embed'));
          const media = rel && !rel.external ? this.media(rel.target) : undefined;
          return media ? { type: 'image', media, mode: kid(c, 'tile') ? 'tile' : 'stretch' } : undefined;
        }
        case 'pattFill': return { type: 'pattern', fg: parseColor(kid(c, 'fgClr')) || '#000000', bg: parseColor(kid(c, 'bgClr')) || '#FFFFFF', preset: attr(c, 'prst') || undefined };
      }
    }
    return undefined;
  }

  line(ln: Element | null): Line | undefined {
    if (!ln) return undefined;
    const out: Line = {};
    const w = num(ln, 'w');
    if (w != null) out.width = w / 12700;
    const f = this.fill(ln, '');
    if (f) out.fill = f;
    const dash = attr(kid(ln, 'prstDash'), 'val');
    if (dash && dash !== 'solid') out.dash = ({ dash: 'dash', dot: 'dot', dashDot: 'dashDot', lgDash: 'longDash', lgDashDot: 'longDashDot', lgDashDotDot: 'longDashDot', sysDash: 'sysDash', sysDot: 'sysDot', sysDashDot: 'dashDot', sysDashDotDot: 'dashDot' } as any)[dash] || 'dash';
    const end = (e: Element | null) => { const t = attr(e, 'type'); return t && t !== 'none' ? (({ triangle: 'triangle', arrow: 'arrow', stealth: 'stealth', diamond: 'diamond', oval: 'oval' } as any)[t] || 'triangle') : undefined; };
    const h = end(kid(ln, 'headEnd')), t = end(kid(ln, 'tailEnd'));
    if (h) out.head = h;
    if (t) out.tail = t;
    const cap = attr(ln, 'cap');
    if (cap) out.cap = cap === 'rnd' ? 'round' : cap === 'sq' ? 'square' : 'flat';
    if (kid(ln, 'round')) out.join = 'round'; else if (kid(ln, 'bevel')) out.join = 'bevel';
    return out;
  }

  private effects(el: Element | null): Effects | undefined {
    if (!el) return undefined;
    const fx: Effects = {};
    const sh = kid(el, 'outerShdw');
    if (sh) fx.shadow = { color: parseColor(sh) || '#000000', blur: (num(sh, 'blurRad') || 0) / 12700, dist: (num(sh, 'dist') || 0) / 12700, dir: (num(sh, 'dir') || 0) / 60000, alpha: (() => { const c = parseColor(sh); return typeof c === 'object' && c.alpha != null ? c.alpha : 0.4; })() };
    const gl = kid(el, 'glow');
    if (gl) fx.glow = { color: parseColor(gl) || '#FFFF00', rad: (num(gl, 'rad') || 0) / 12700 };
    const se = kid(el, 'softEdge');
    if (se) fx.softEdge = (num(se, 'rad') || 0) / 12700;
    if (kid(el, 'reflection')) fx.reflection = true;
    return Object.keys(fx).length ? fx : undefined;
  }

  // ------------------------------------------------------------------------------------------
  // Text

  runProps(rPr: Element | null, part: string): RunProps {
    const r: RunProps = {};
    if (!rPr) return r;
    const b = attr(rPr, 'b'); if (b != null) r.b = b === '1' || b === 'true';
    const i = attr(rPr, 'i'); if (i != null) r.i = i === '1' || i === 'true';
    const u = attr(rPr, 'u'); if (u != null) r.u = u === 'none' ? false : u === 'dbl' ? 'dbl' : /wav/.test(u) ? 'wavy' : true;
    const s = attr(rPr, 'strike'); if (s != null) r.strike = s === 'noStrike' ? false : s === 'dblStrike' ? 'dbl' : true;
    const sz = num(rPr, 'sz'); if (sz != null) r.size = sz / 100;
    const bl = num(rPr, 'baseline'); if (bl) r.baseline = bl / 1000;
    const cap = attr(rPr, 'cap'); if (cap) r.caps = cap as RunProps['caps'];
    const spc = num(rPr, 'spc'); if (spc) r.spc = spc / 100;
    const lang = attr(rPr, 'lang'); if (lang) r.lang = lang;
    const sf = kid(rPr, 'solidFill'); if (sf) { const c = parseColor(sf); if (c) r.color = c; }
    const gf = kid(rPr, 'gradFill'); if (gf && !r.color) { const c = parseColor(firstDesc(gf, 'gs')); if (c) r.color = c; }
    const hl = kid(rPr, 'highlight'); if (hl) { const c = parseColor(hl); if (c) r.highlight = c; }
    const latin = attr(kid(rPr, 'latin'), 'typeface'); if (latin) r.font = latin;
    const link = kid(rPr, 'hlinkClick');
    if (link) { const rel = this.rel(part, attrQ(link, 'r:id')); if (rel?.external) r.link = rel.target; }
    return r;
  }

  paraProps(pPr: Element | null): ParaProps {
    const p: ParaProps = {};
    if (!pPr) return p;
    const al = attr(pPr, 'algn'); if (al && ALGN[al]) p.align = ALGN[al];
    const marL = num(pPr, 'marL'); if (marL != null) p.marL = marL / 12700;
    const ind = num(pPr, 'indent'); if (ind != null) p.indent = ind / 12700;
    if (attr(pPr, 'rtl') === '1') p.rtl = true;
    const ls = kid(pPr, 'lnSpc');
    if (ls) {
      const pct = num(kid(ls, 'spcPct'), 'val'), pts = num(kid(ls, 'spcPts'), 'val');
      if (pct != null) p.lineSpacing = pct / 1000;
      else if (pts != null) { p.lineSpacing = pts / 100; p.lineSpacingPt = true; }
    }
    const sp = (e: Element | null) => { const pts = num(kid(e, 'spcPts'), 'val'); const pct = num(kid(e, 'spcPct'), 'val'); return pts != null ? pts / 100 : pct != null ? (pct / 100000) * 18 : undefined; };
    const sb = sp(kid(pPr, 'spcBef')); if (sb != null) p.spaceBefore = sb;
    const sa = sp(kid(pPr, 'spcAft')); if (sa != null) p.spaceAfter = sa;
    let bullet: Bullet | undefined;
    if (kid(pPr, 'buNone')) bullet = { kind: 'none' };
    const ch = kid(pPr, 'buChar');
    if (ch) bullet = { kind: 'char', char: attr(ch, 'char') || '•' };
    const an = kid(pPr, 'buAutoNum');
    if (an) { bullet = { kind: 'num', scheme: AUTONUM[attr(an, 'type') || ''] || 'arabicPeriod' }; const st = num(an, 'startAt'); if (st != null) bullet.startAt = st; }
    if (kid(pPr, 'buBlip')) bullet = { kind: 'char', char: '■' };
    const bf = attr(kid(pPr, 'buFont'), 'typeface');
    const bc = parseColor(kid(pPr, 'buClr'));
    const bs = num(kid(pPr, 'buSzPct'), 'val');
    if (bf || bc || bs) {
      // Bullet font, color or size without a kind: keep them on a char bullet only if one is defined here.
      if (bullet && bullet.kind !== 'none') { if (bf) bullet.font = bf; if (bc) bullet.color = bc; if (bs) bullet.size = bs / 1000; }
    }
    if (bullet) p.bullet = bullet;
    return p;
  }

  levelStyle(pPr: Element): LevelStyle {
    const st: LevelStyle = this.paraProps(pPr);
    const d = kid(pPr, 'defRPr');
    if (d) { const r = this.runProps(d, ''); if (Object.keys(r).length) st.run = r; }
    return st;
  }

  textBody(tx: Element | null, part: string): TextBody | undefined {
    if (!tx) return undefined;
    const body: TextBody = { paras: [] };
    const bp = kid(tx, 'bodyPr');
    if (bp) {
      const an = attr(bp, 'anchor'); if (an === 't' || an === 'ctr' || an === 'b') body.anchor = an;
      const ins = ['lIns', 'tIns', 'rIns', 'bIns'].map((k) => num(bp, k));
      if (ins.some((v) => v != null)) body.insets = [ins[0] ?? 91440, ins[1] ?? 45720, ins[2] ?? 91440, ins[3] ?? 45720].map((v) => v / 12700) as [number, number, number, number];
      if (attr(bp, 'wrap') === 'none') body.wrap = false;
      const v = attr(bp, 'vert'); if (v === 'vert' || v === 'vert270' || v === 'eaVert' || v === 'wordArtVert') body.vert = v === 'vert270' ? 'vert270' : v === 'wordArtVert' ? 'stacked' : 'vert';
      const nc = num(bp, 'numCol'); if (nc && nc > 1) body.columns = nc;
      const na = kid(bp, 'normAutofit');
      if (na) { body.autofit = 'shrink'; const fs = num(na, 'fontScale'); if (fs) body.fontScale = fs / 100000; const lr = num(na, 'lnSpcReduction'); if (lr) body.lineReduction = lr / 1000; }
      else if (kid(bp, 'spAutoFit')) body.autofit = 'resize';
      else if (kid(bp, 'noAutofit')) body.autofit = 'none';
    }
    const ls = kid(tx, 'lstStyle');
    if (ls && kids(ls).length) {
      const lv: LevelStyle[] = [];
      for (let i = 1; i <= 9; i++) { const p = kid(ls, `lvl${i}pPr`); if (p) lv[i - 1] = this.levelStyle(p); }
      if (lv.length) body.levels = lv;
    }
    for (const p of kidsNamed(tx, 'p')) {
      const pPr = kid(p, 'pPr');
      const para: Paragraph = { level: Math.min(8, Math.max(0, num(pPr, 'lvl') || 0)), runs: [], ...this.paraProps(pPr) };
      for (const r of kids(p)) {
        if (r.localName === 'r') {
          const t = kid(r, 't')?.textContent ?? '';
          para.runs.push({ text: t, ...this.runProps(kid(r, 'rPr'), part) });
        } else if (r.localName === 'br') {
          para.runs.push({ text: '', br: true, ...this.runProps(kid(r, 'rPr'), part) });
        } else if (r.localName === 'fld') {
          const type = attr(r, 'type') || '';
          const run: Run = { text: kid(r, 't')?.textContent ?? '', ...this.runProps(kid(r, 'rPr'), part) };
          if (type === 'slidenum') run.field = 'slidenum';
          else if (/^datetime/.test(type)) run.field = 'datetime';
          para.runs.push(run);
        } else if (r.localName === 'endParaRPr') {
          const e = this.runProps(r, part);
          if (Object.keys(e).length) para.end = e;
        }
      }
      body.paras.push(para);
    }
    if (!body.paras.length) body.paras.push({ level: 0, runs: [] });
    return body;
  }

  // ------------------------------------------------------------------------------------------
  // Tables and charts

  private graphicFrame(node: Element, base: any, ctx: { part: string; prefix: string }, xf?: (x: number, y: number, w: number, h: number) => [number, number, number, number]): SEl | null {
    const gd = firstDesc(node, 'graphicData');
    const uri = attr(gd, 'uri') || '';
    const frame: any = { ...base };
    this.xfrm(kid(node, 'xfrm'), frame, xf);
    const tbl = kid(gd, 'tbl');
    if (tbl) return this.table(tbl, frame, ctx.part);
    if (/chart$/.test(uri) || kid(gd, 'chart')) {
      const c = kid(gd, 'chart');
      const rel = this.rel(ctx.part, attrQ(c, 'r:id'));
      const chart = rel ? this.chart(rel.target) : null;
      if (chart) return { ...frame, kind: 'chart', chart: chart.chart, rawXml: chart.raw } as ChartElement;
      this.warnings.push('A chart could not be read; it was left out.');
      return null;
    }
    if (/diagram$/.test(uri)) {
      // SmartArt: use the cached drawing the producer saved.
      const dr = this.relOfType(ctx.part, 'diagramDrawing').find((r) => this.pkg.has(r.target));
      const rid = attrQ(kid(gd, 'relIds'), 'r:dm');
      void rid;
      const dd = dr ? this.xml(dr.target) : null;
      const tree = firstDesc(dd, 'spTree');
      if (tree) {
        const ox = frame.x || 0, oy = frame.y || 0;
        const children = this.tree(tree, { part: dr!.target, prefix: `${base.id}_` }, (X, Y, W, H) => [X + ox, Y + oy, W, H]);
        return { ...frame, kind: 'group', children } as GroupElement;
      }
      this.warnings.push('A diagram without a saved drawing was left out.');
      return null;
    }
    // OLE objects and other frames: use the fallback picture when there is one.
    const pic = firstDesc(node, 'pic');
    if (pic) {
      const e = this.element(pic, ctx, xf) as PictureElement | null;
      if (e) { Object.assign(e, { x: frame.x, y: frame.y, w: frame.w, h: frame.h, id: base.id }); return e; }
    }
    return null;
  }

  private table(tbl: Element, frame: any, part: string): TableElement {
    const t: TableElement = { ...frame, kind: 'table', cols: kidsNamed(kid(tbl, 'tblGrid'), 'gridCol').map((g) => (num(g, 'w') || 0) / 12700), rows: [] };
    const pr = kid(tbl, 'tblPr');
    if (pr) {
      const st: any = {};
      for (const k of ['firstRow', 'lastRow', 'firstCol', 'lastCol', 'bandRow', 'bandCol']) if (attr(pr, k) === '1') st[k] = true;
      if (Object.keys(st).length) t.style = st;
      const sid = kid(pr, 'tableStyleId')?.textContent;
      if (sid) t.keep = { tableStyleId: sid.trim() };
    }
    for (const tr of kidsNamed(tbl, 'tr')) {
      const row = { h: (num(tr, 'h') || 0) / 12700, cells: [] as TableCell[] };
      for (const tc of kidsNamed(tr, 'tc')) {
        const cell: TableCell = { text: this.textBody(kid(tc, 'txBody'), part) || { paras: [{ level: 0, runs: [] }] } };
        const gs = num(tc, 'gridSpan'); if (gs && gs > 1) cell.colSpan = gs;
        const rs = num(tc, 'rowSpan'); if (rs && rs > 1) cell.rowSpan = rs;
        if (attr(tc, 'hMerge') === '1' || attr(tc, 'vMerge') === '1') cell.merged = true;
        const tcPr = kid(tc, 'tcPr');
        if (tcPr) {
          const an = attr(tcPr, 'anchor'); if (an === 't' || an === 'ctr' || an === 'b') cell.anchor = an;
          const f = this.fill(tcPr, part); if (f) cell.fill = f;
          const b = ['lnL', 'lnT', 'lnR', 'lnB'].map((k) => this.line(kid(tcPr, k)));
          if (b.some(Boolean)) cell.borders = b as TableCell['borders'];
          const ins = ['marL', 'marT', 'marR', 'marB'].map((k) => num(tcPr, k));
          if (ins.some((v) => v != null)) cell.text.insets = [ins[0] ?? 91440, ins[1] ?? 45720, ins[2] ?? 91440, ins[3] ?? 45720].map((v) => v / 12700) as [number, number, number, number];
        }
        row.cells.push(cell);
      }
      t.rows.push(row);
    }
    return t;
  }

  private chart(part: string): { chart: ChartElement['chart']; raw: string } | null {
    const bytes = this.pkg.get(part);
    const d = this.xml(part);
    if (!d || !bytes) return null;
    const plot = firstDesc(d, 'plotArea');
    const types: [string, ChartType][] = [['barChart', 'column'], ['bar3DChart', 'column'], ['lineChart', 'line'], ['line3DChart', 'line'], ['pieChart', 'pie'], ['pie3DChart', 'pie'], ['ofPieChart', 'pie'], ['doughnutChart', 'doughnut'], ['areaChart', 'area'], ['area3DChart', 'area'], ['scatterChart', 'scatter'], ['bubbleChart', 'scatter'], ['radarChart', 'radar']];
    let typeEl: Element | null = null, type: ChartType = 'column';
    for (const k of kids(plot)) { const t = types.find(([n]) => n === k.localName); if (t) { typeEl = k; type = t[1]; break; } }
    if (!typeEl) return null;
    if (type === 'column' && attr(kid(typeEl, 'barDir'), 'val') === 'bar') type = 'bar';
    const grouping = attr(kid(typeEl, 'grouping'), 'val');
    const cache = (e: Element | null) => {
      const pts = desc(e, 'pt');
      // idx is bounded by the cache's ptCount (and a sane maximum) so a bogus index cannot allocate a huge array.
      const declared = num(firstDesc(e, 'ptCount'), 'val');
      const max = Math.min(CHART_MAX_POINTS, declared != null && declared >= 0 ? declared : Math.max(pts.length, 1) * 4);
      const out: string[] = [];
      for (const p of pts) {
        const idx = Math.floor(num(p, 'idx') || 0);
        if (idx < 0 || idx >= max) continue;
        out[idx] = kid(p, 'v')?.textContent ?? '';
      }
      return out;
    };
    let categories: string[] = [];
    const series = kidsNamed(typeEl, 'ser').map((ser, i) => {
      const name = desc(kid(ser, 'tx'), 'v')[0]?.textContent || firstDesc(kid(ser, 'tx'), 't')?.textContent || `Series ${i + 1}`;
      const cat = kid(ser, 'cat') || kid(ser, 'xVal');
      const val = kid(ser, 'val') || kid(ser, 'yVal');
      const cats = Array.from(cache(cat), (v) => v ?? '');
      if (cats.length > categories.length) categories = cats;
      const vals = Array.from(cache(val), (v) => (v === '' || v == null || isNaN(+v) ? null : +v));
      const color = parseColor(firstDesc(kid(ser, 'spPr'), 'solidFill'));
      return { name, values: vals, ...(color ? { color } : {}) };
    });
    const n = Math.max(categories.length, ...series.map((s) => s.values.length));
    for (let i = 0; i < n; i++) if (categories[i] == null) categories[i] = String(i + 1);
    const titleEl = firstDesc(d, 'title');
    const title = titleEl ? desc(titleEl, 't').map((t) => t.textContent).join('') || undefined : undefined;
    const lp = attr(firstDesc(firstDesc(d, 'legend'), 'legendPos'), 'val');
    const chart: ChartElement['chart'] = { type, categories, series };
    if (title) chart.title = title;
    chart.legend = firstDesc(d, 'legend') ? ((lp === 'r' || lp === 'b' || lp === 't' || lp === 'l') ? lp : 'r') : 'none';
    if (grouping === 'stacked') chart.stacked = true;
    if (grouping === 'percentStacked') chart.stacked = 'percent';
    if (attr(firstDesc(typeEl, 'showVal'), 'val') === '1' || attr(firstDesc(typeEl, 'showPercent'), 'val') === '1') chart.labels = true;
    return { chart, raw: decodeXml(bytes) };
  }

  // ------------------------------------------------------------------------------------------
  // Motion

  private transition(R: Element): Transition | undefined {
    const tr = firstDesc(R, 'transition');
    if (!tr) return undefined;
    const spd = attr(tr, 'spd');
    const durAttr = num(tr, 'dur');
    const t: Transition = { type: 'fade', dur: durAttr ?? (spd === 'slow' ? 1000 : spd === 'med' ? 750 : 500) };
    if (attr(tr, 'advClick') === '0') t.advClick = false;
    const adv = num(tr, 'advTm'); if (adv != null) t.advAfter = adv;
    const eff = kids(tr).find((k) => k.localName !== 'sndAc' && k.localName !== 'extLst');
    if (!eff) {
      if (t.advAfter == null && t.advClick !== false) return durAttr || spd ? { ...t, type: 'none' } : undefined;
      t.type = 'none';
      return t;
    }
    const map: Record<string, TransitionType> = {
      fade: 'fade', push: 'push', wipe: 'wipe', split: 'split', cover: 'cover', pull: 'uncover', randomBar: 'randomBars', zoom: 'zoom', cut: 'cut', dissolve: 'dissolve',
      circle: 'circle', diamond: 'diamond', plus: 'plus', wedge: 'wedge', wheel: 'clock', blinds: 'blinds', checker: 'checker', comb: 'comb', newsflash: 'zoom', strips: 'wipe',
      reveal: 'reveal', morph: 'morph', flip: 'flip', gallery: 'gallery', prism: 'cube', doors: 'split', window: 'split', ferris: 'gallery', conveyor: 'push', pan: 'push',
      glitter: 'dissolve', honeycomb: 'dissolve', vortex: 'zoom', ripple: 'zoom', shred: 'dissolve', switch: 'flip', flash: 'fade', warp: 'zoom', flythrough: 'zoom', wheelReverse: 'clock',
      prstTrans: 'fade', random: 'fade',
    };
    t.type = map[eff.localName] || 'fade';
    const dir = attr(eff, 'dir');
    if (dir) {
      const d = ({ l: 'l', r: 'r', u: 'u', d: 'd', in: 'in', out: 'out', lu: 'lu', ru: 'ru', ld: 'ld', rd: 'rd', horz: 'horz', vert: 'vert' } as any)[dir];
      if (d) t.dir = d;
    }
    if (t.type === 'split') {
      // Split keeps its orientation in dir and whether it closes in or opens out separately.
      const o = attr(eff, 'orient');
      t.dir = o === 'vert' ? 'vert' : 'horz';
      if (dir === 'in' || dir === 'out') t.inOut = dir;
    }
    if (attr(eff, 'thruBlk') === '1') t.thruBlk = true;
    return t;
  }

  private timing(timing: Element | null, prefix: string): Animation[] {
    if (!timing) return [];
    const anims: Animation[] = [];
    const ctns = desc(timing, 'cTn').filter((c) => attr(c, 'presetClass'));
    const lastByKey = new Map<string, Animation>();
    for (const c of ctns) {
      const cls = attr(c, 'presetClass') as string;
      const pid = num(c, 'presetID') || 0;
      const sub = num(c, 'presetSubtype') || 0;
      const node = attr(c, 'nodeType') || 'clickEffect';
      const tgt = firstDesc(c, 'spTgt');
      const spid = attr(tgt, 'spid');
      if (!spid) continue;
      const target = prefix + spid;
      const byPara = !!firstDesc(tgt, 'pRg');
      let mcls: AnimClass = cls === 'exit' ? 'exit' : cls === 'emph' ? 'emph' : cls === 'path' ? 'path' : 'entr';
      let effect: AnimEffect;
      if (mcls === 'emph') effect = (EMPH_PRESETS[pid] || 'pulse') as AnimEffect;
      else if (mcls === 'path') effect = 'line';
      else effect = (ENTR_PRESETS[pid] || 'fade') as AnimEffect;
      if (!['entr', 'exit', 'emph', 'path'].includes(cls)) mcls = 'entr';
      const durs = desc(c, 'cTn').map((x) => num(x, 'dur')).filter((v): v is number => v != null && v > 0);
      const delay = num(firstDesc(kid(c, 'stCondLst'), 'cond'), 'delay');
      const a: Animation = { id: newId('an'), target, cls: mcls, effect, trigger: node === 'withEffect' ? 'with' : node === 'afterEffect' ? 'after' : 'click' };
      if (durs.length) a.dur = Math.max(...durs);
      if (delay) a.delay = delay;
      if ((effect === 'fly' || effect === 'wipe' || effect === 'peek' || effect === 'float') && SUBTYPE_DIR[sub]) a.dir = SUBTYPE_DIR[sub];
      if (effect === 'spin') { const by = num(firstDesc(c, 'animRot'), 'by'); if (by) a.amount = by / 60000; }
      if (mcls === 'path') { const m = firstDesc(c, 'animMotion'); const p = attr(m, 'path'); if (p) a.path = p.replace(/\bE\b/, '').trim(); }
      // The interactive sequence a trigger belongs to.
      const seq = (() => { for (let e: Element | null = c.parentElement; e; e = e.parentElement) if (e.localName === 'seq') return e; return null; })();
      const seqCtn = kid(seq, 'cTn');
      if (attr(seqCtn, 'nodeType') === 'interactiveSeq') { const trig = firstDesc(firstDesc(kid(seqCtn, 'stCondLst'), 'tgtEl'), 'spTgt'); const sid = attr(trig, 'spid'); if (sid) a.onShape = prefix + sid; }
      // Paragraph-by-paragraph builds appear as one effect per paragraph: merge them.
      const key = `${target}|${mcls}|${effect}`;
      const prev = lastByKey.get(key);
      if (byPara && prev && prev.byPara) continue;
      if (byPara) a.byPara = true;
      lastByKey.set(key, a);
      anims.push(a);
    }
    return anims;
  }
}

export function importPptxPkg(pkg: Pkg): PptxImportResult {
  return new Importer(pkg).run();
}

export { Importer as PptxImporter };
export type { Rel };
