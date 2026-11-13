/**
 * OpenDocument presentation import and export (.odp, .otp packages and flat .fodp), written from
 * ISO/IEC 26300 (ODF 1.2/1.3). Master pages become masters with a title-and-content layout;
 * frames, custom shapes, lines, pictures, tables, groups, notes, backgrounds and transitions map
 * onto the model. Charts are exported as pictures; animations are not carried (see FORMATS.md).
 */
import JSZip from 'jszip';
import { Deck, newId, defaultStyles } from '../model/deck';
import type { Color, Element as SEl, Fill, GroupElement, Layout, LevelStyle, Line, Master, Paragraph, PictureElement, Run, RunProps, ShapeElement, Slide, TableCell, TableElement, TextBody, Transition, TransitionType, MediaElement, ChartElement } from '../model/types';
import { resolveColor, type ColorContext } from '../model/theme';
import { geometryPath, GEOMETRY } from '../model/geometry';
import { renderChart } from '../render/chart';
import { attr, b64, dec, decodeXml, desc, enc, esc, imageSizePt, kid, kids, parseXml, sniffMediaMime, unb64, MIME_EXT } from './xml';
import { readZipCapped } from './zip';

export const ODP_MIME = 'application/vnd.oasis.opendocument.presentation';
export const OTP_MIME = 'application/vnd.oasis.opendocument.presentation-template';

/** Parses an ODF length to points. */
export function len(v: string | null | undefined): number | undefined {
  if (!v) return undefined;
  const m = /^(-?[\d.]+)\s*(cm|mm|in|pt|pc|px|inch)?$/.exec(v.trim());
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  switch (m[2]) {
    case 'cm': return (n / 2.54) * 72;
    case 'mm': return (n / 25.4) * 72;
    case 'in': case 'inch': return n * 72;
    case 'pc': return n * 12;
    case 'px': return n * 0.75;
    default: return n;
  }
}
const pt = (n: number | undefined) => `${+(n ?? 0).toFixed(3)}pt`;

/** Parses an ODF angle to degrees: unitless values are tenths of a degree (as LibreOffice writes them); deg, grad and rad suffixes are honoured. */
export function odfAngle(v: string | null | undefined): number {
  const m = /^\s*(-?[\d.]+(?:e[-+]?\d+)?)\s*(deg|grad|rad)?\s*$/i.exec(v || '');
  if (!m) return 0;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return 0;
  switch ((m[2] || '').toLowerCase()) {
    case 'deg': return n;
    case 'grad': return n * 0.9;
    case 'rad': return (n * 180) / Math.PI;
    default: return n / 10;
  }
}

/** Exact SMIL subtype → model direction (barWipe directions also depend on smil:direction). */
const SUB_DIR: Record<string, Transition['dir']> = {
  fromLeft: 'l', fromRight: 'r', fromTop: 'u', fromBottom: 'd', fromTopLeft: 'lu', fromTopRight: 'ru', fromBottomLeft: 'ld', fromBottomRight: 'rd',
  horizontal: 'horz', vertical: 'vert', leftToRight: 'r', topToBottom: 'd',
};

// ------------------------------------------------------------------------------------------
// Import

interface Props { [k: string]: string }
interface OStyle { name: string; family: string; parent?: string; props: Props; listStyle?: string }

const ENH_TO_PRESET: Record<string, string> = {
  rectangle: 'rect', 'round-rectangle': 'roundRect', ellipse: 'ellipse', circle: 'ellipse', 'isosceles-triangle': 'triangle', 'right-triangle': 'rtTriangle',
  diamond: 'diamond', parallelogram: 'parallelogram', trapezoid: 'trapezoid', pentagon: 'pentagon', hexagon: 'hexagon', octagon: 'octagon',
  star4: 'star4', star5: 'star5', star8: 'star8', star24: 'star24', 'concave-star6': 'star6', 'right-arrow': 'rightArrow', 'left-arrow': 'leftArrow', 'up-arrow': 'upArrow',
  'down-arrow': 'downArrow', 'left-right-arrow': 'leftRightArrow', 'up-down-arrow': 'upDownArrow', chevron: 'chevron', 'pentagon-right': 'homePlate', heart: 'heart',
  cloud: 'cloud', sun: 'sun', moon: 'moon', smiley: 'smileyFace', lightning: 'lightningBolt', can: 'can', cube: 'cube', cross: 'plus', frame: 'frame',
  'rectangular-callout': 'wedgeRectCallout', 'round-rectangular-callout': 'wedgeRoundRectCallout', 'round-callout': 'wedgeEllipseCallout', 'cloud-callout': 'cloudCallout',
  'flowchart-process': 'flowChartProcess', 'flowchart-alternate-process': 'flowChartAlternateProcess', 'flowchart-decision': 'flowChartDecision', 'flowchart-data': 'flowChartInputOutput',
  'flowchart-predefined-process': 'flowChartPredefinedProcess', 'flowchart-document': 'flowChartDocument', 'flowchart-terminator': 'flowChartTerminator', 'flowchart-preparation': 'flowChartPreparation',
  'flowchart-manual-input': 'flowChartManualInput', 'flowchart-manual-operation': 'flowChartManualOperation', 'flowchart-connector': 'flowChartConnector', 'flowchart-off-page-connector': 'flowChartOffpageConnector',
  'flowchart-merge': 'flowChartMerge', 'flowchart-extract': 'flowChartExtract', 'flowchart-magnetic-disk': 'flowChartMagneticDisk', 'flowchart-card': 'flowChartPunchedCard', 'flowchart-sort': 'flowChartSort', 'flowchart-delay': 'flowChartDelay',
  'block-arc': 'arc', 'quad-arrow': 'quadArrow', 'notched-right-arrow': 'notchedRightArrow', 'striped-right-arrow': 'stripedRightArrow', 'circular-arrow': 'circularArrow', 'horizontal-scroll': 'horizontalScroll', 'vertical-scroll': 'verticalScroll',
  'mso-spt100': 'rect',
};
const PRESET_TO_ENH: Record<string, string> = Object.fromEntries(Object.entries(ENH_TO_PRESET).filter(([k]) => !['circle', 'mso-spt100'].includes(k)).map(([k, v]) => [v, k]));

const SMIL_TO_TRANS: Record<string, TransitionType> = {
  fade: 'fade', pushWipe: 'push', slideWipe: 'cover', barWipe: 'wipe', barnDoorWipe: 'split', irisWipe: 'zoom', randomBarWipe: 'randomBars', ellipseWipe: 'circle',
  fanWipe: 'wedge', clockWipe: 'clock', blindsWipe: 'blinds', checkerBoardWipe: 'checker', dissolve: 'dissolve', zoom: 'zoom', random: 'fade', fourBoxWipe: 'plus',
  diagonalWipe: 'wipe', boxWipe: 'zoom', pinWheelWipe: 'clock', snakeWipe: 'wipe', waterfallWipe: 'wipe', miscShapeWipe: 'shape', singleSweepWipe: 'clock',
};

class OdpImporter {
  styles = new Map<string, OStyle>();
  listStyles = new Map<string, Element>();
  pageLayouts = new Map<string, Props>();
  deck = new Deck();
  warnings: string[] = [];
  mediaByHref = new Map<string, string>();
  masterByName = new Map<string, Master>();
  layoutByMaster = new Map<string, Layout>();

  constructor(public files: Map<string, Uint8Array>, public content: Document, public stylesDoc: Document | null) {}

  readStyles(root: Element | Document | null): void {
    for (const st of desc(root, 'style')) {
      const name = attr(st, 'name');
      if (!name || st.parentElement?.localName === 'master-styles') continue;
      const props: Props = {};
      for (const p of kids(st)) if (p.localName.endsWith('-properties')) for (const a of Array.from(p.attributes)) props[a.localName] = a.value;
      const family = attr(st, 'family') || '';
      // Paragraph and presentation styles share names across families; key by family too.
      this.styles.set(`${family}:${name}`, { name, family, parent: attr(st, 'parent-style-name') || undefined, props, listStyle: attr(st, 'list-style-name') || undefined });
      if (!this.styles.has(`*:${name}`)) this.styles.set(`*:${name}`, this.styles.get(`${family}:${name}`)!);
    }
    for (const ls of desc(root, 'list-style')) { const n = attr(ls, 'name'); if (n) this.listStyles.set(n, ls); }
    for (const pl of desc(root, 'page-layout')) {
      const n = attr(pl, 'name');
      const pp = kid(pl, 'page-layout-properties');
      if (n && pp) { const props: Props = {}; for (const a of Array.from(pp.attributes)) props[a.localName] = a.value; this.pageLayouts.set(n, props); }
    }
  }

  /** Merged properties of a style and its parents. */
  props(name: string | null | undefined, family = '*'): Props {
    const out: Props = {};
    const chain: OStyle[] = [];
    let s = name ? this.styles.get(`${family}:${name}`) || this.styles.get(`*:${name}`) : undefined;
    for (let i = 0; s && i < 20; i++) { chain.push(s); s = s.parent ? this.styles.get(`${s.family}:${s.parent}`) || this.styles.get(`*:${s.parent}`) : undefined; }
    for (const c of chain.reverse()) Object.assign(out, c.props);
    return out;
  }

  media(href: string): string | undefined {
    if (this.mediaByHref.has(href)) return this.mediaByHref.get(href);
    const p = href.replace(/^\.\//, '');
    const bytes = this.files.get(p);
    if (!bytes) { if (href && !/^https?:/.test(href)) this.warnings.push(`Missing picture ${href}.`); return undefined; }
    const id = this.deck.addMedia({ mime: sniffMediaMime(bytes, p), b64: b64(bytes), name: p.split('/').pop() });
    this.mediaByHref.set(href, id);
    return id;
  }

  color(v: string | undefined): Color | undefined {
    return v && /^#[0-9a-f]{6}$/i.test(v) ? v.toUpperCase() : undefined;
  }

  fill(p: Props): Fill | undefined {
    const f = p['fill'];
    if (f === 'none') return { type: 'none' };
    if (f === 'solid') { const c = this.color(p['fill-color']); return c ? { type: 'solid', color: c } : undefined; }
    if (f === 'gradient') {
      const g = desc(this.stylesDoc || this.content, 'gradient').find((e) => attr(e, 'name') === p['fill-gradient-name']);
      const a = this.color(attr(g, 'start-color') || undefined) || '#FFFFFF', b = this.color(attr(g, 'end-color') || undefined) || '#000000';
      const ang = odfAngle(attr(g, 'angle'));
      return { type: 'gradient', stops: [{ pos: 0, color: a }, { pos: 1, color: b }], angle: +((((90 - ang) % 360) + 360) % 360).toFixed(3), ...(attr(g, 'style') === 'radial' ? { path: 'radial' as const } : {}) };
    }
    if (f === 'bitmap') {
      const img = desc(this.stylesDoc || this.content, 'fill-image').find((e) => attr(e, 'name') === p['fill-image-name']);
      const href = attr(img, 'href');
      const m = href ? this.media(href) : undefined;
      return m ? { type: 'image', media: m, mode: p['repeat'] === 'repeat' ? 'tile' : 'stretch' } : undefined;
    }
    return undefined;
  }

  line(p: Props): Line | undefined {
    if (p['stroke'] === 'none') return { fill: { type: 'none' } };
    const c = this.color(p['stroke-color']);
    const w = len(p['stroke-width']);
    if (!c && w == null && !p['stroke']) return undefined;
    const ln: Line = { fill: { type: 'solid', color: c || '#000000' } };
    if (w != null) ln.width = Math.max(0.25, w);
    if (p['stroke'] === 'dash') ln.dash = 'dash';
    if (p['marker-end']) ln.tail = 'triangle';
    if (p['marker-start']) ln.head = 'triangle';
    return ln;
  }

  runProps(p: Props): RunProps {
    const r: RunProps = {};
    const sz = p['font-size'];
    if (sz && !sz.endsWith('%')) { const v = len(sz); if (v) r.size = v; }
    if (p['font-weight']) r.b = p['font-weight'] === 'bold' || +p['font-weight'] >= 600;
    if (p['font-style']) r.i = p['font-style'] === 'italic' || p['font-style'] === 'oblique';
    if (p['text-underline-style']) r.u = p['text-underline-style'] !== 'none';
    if (p['text-line-through-style']) r.strike = p['text-line-through-style'] !== 'none';
    const c = this.color(p['color']); if (c) r.color = c;
    const fam = p['font-name'] || p['font-family'];
    if (fam) r.font = fam.replace(/^['"]|['"]$/g, '');
    if (p['background-color'] && p['background-color'] !== 'transparent') { const h = this.color(p['background-color']); if (h) r.highlight = h; }
    const pos = p['text-position'];
    if (pos) { const m = /^(super|sub|-?\d+%)/.exec(pos); if (m) r.baseline = m[1] === 'super' ? 30 : m[1] === 'sub' ? -25 : parseFloat(m[1]); }
    if (p['font-variant'] === 'small-caps') r.caps = 'small';
    if (p['text-transform'] === 'uppercase') r.caps = 'all';
    return r;
  }

  paraProps(p: Props): Partial<Paragraph> {
    const out: Partial<Paragraph> = {};
    const al = p['text-align'];
    if (al) out.align = al === 'center' ? 'ctr' : al === 'end' || al === 'right' ? 'r' : al === 'justify' ? 'just' : 'l';
    const ml = len(p['margin-left']); if (ml != null && ml) out.marL = ml;
    const ti = len(p['text-indent']); if (ti != null && ti) out.indent = ti;
    const mt = len(p['margin-top']); if (mt) out.spaceBefore = mt;
    const mb = len(p['margin-bottom']); if (mb) out.spaceAfter = mb;
    const lh = p['line-height'];
    if (lh && lh.endsWith('%')) out.lineSpacing = parseFloat(lh);
    return out;
  }

  // ------------------------------------------------------------------------------------------

  run(): Deck {
    this.readStyles(this.stylesDoc);
    this.readStyles(this.content);
    const d = this.deck.data;
    d.masters = []; d.layouts = []; d.slides = [];
    const theme = d.themes[0];
    // Master pages
    const masterRoot = desc(this.stylesDoc || this.content, 'master-styles')[0];
    for (const mp of desc(masterRoot, 'master-page')) {
      const name = attr(mp, 'name') || 'Default';
      const pl = this.pageLayouts.get(attr(mp, 'page-layout-name') || '');
      if (pl && !this.masterByName.size) {
        const w = len(pl['page-width']), h = len(pl['page-height']);
        if (w && h) d.size = { w, h };
      }
      const styles = defaultStyles();
      const tp = this.props(`${name}-title`, 'presentation');
      const tr = this.runProps(tp);
      styles.title[0] = { ...styles.title[0], ...this.paraProps(tp), run: { ...styles.title[0].run, ...tr } };
      for (let i = 0; i < 9; i++) {
        const op = this.props(`${name}-outline${i + 1}`, 'presentation');
        if (Object.keys(op).length) styles.body[i] = { ...styles.body[i], run: { ...styles.body[i].run, ...this.runProps(op) } };
      }
      const master: Master = { id: newId('mst'), name, theme: theme.id, styles, elements: [], clrMap: { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' } };
      const bg = this.fill(this.props(attr(mp, 'style-name'), 'drawing-page'));
      if (bg && bg.type !== 'none') master.bg = bg;
      const ctx: Ctx = { owner: 'master' };
      for (const e of kids(mp)) { const el = this.element(e, ctx); if (el) master.elements.push(el); }
      // Placeholders without presentation:class are graphics; the title and outline frames are placeholders.
      d.masters.push(master);
      this.masterByName.set(name, master);
      const phEls = master.elements.filter((e) => e.ph && (e.ph.type === 'title' || e.ph.type === 'body'));
      const lay: Layout = { id: newId('lay'), name: 'Title, Content', master: master.id, type: 'obj', elements: phEls.map((e) => ({ ...e, id: newId('ph'), ...(e.ph!.type === 'body' ? { ph: { type: 'body', idx: 1 } } : {}) } as SEl)) };
      const blank: Layout = { id: newId('lay'), name: 'Blank', master: master.id, type: 'blank', elements: [] };
      d.layouts.push(lay, blank);
      this.layoutByMaster.set(name, lay);
    }
    if (!d.masters.length) {
      const fresh = Deck.blankData(d.size);
      d.masters = fresh.masters; d.layouts = fresh.layouts; d.themes = fresh.themes;
    }
    // Pages
    const pres = desc(this.content, 'presentation')[0] || this.content.documentElement;
    for (const page of desc(pres, 'page')) {
      if (page.parentElement?.localName !== 'presentation') continue;
      const mname = attr(page, 'master-page-name') || '';
      const master = this.masterByName.get(mname) || d.masters[0];
      const layout = this.layoutByMaster.get(mname) || d.layouts.find((l) => l.master === master.id) || d.layouts[0];
      const slide: Slide = { id: newId('sld'), layout: layout.id, elements: [], notes: [], anims: [] };
      const nm = attr(page, 'name');
      if (nm && !/^page\d+$/i.test(nm)) slide.name = nm;
      const pp = this.props(attr(page, 'style-name'), 'drawing-page');
      const bg = this.fill(pp);
      if (bg) slide.bg = bg;
      if (pp['visibility'] === 'hidden') slide.hidden = true;
      const tr = this.transition(pp, page);
      if (tr) slide.transition = tr;
      const ctx: Ctx = { owner: 'slide' };
      for (const e of kids(page)) {
        if (e.localName === 'notes') {
          for (const f of desc(e, 'frame')) if (attr(f, 'class') === 'notes') { const tb = this.textBody(kid(f, 'text-box'), {}, true); if (tb) slide.notes = tb.paras; }
          continue;
        }
        const el = this.element(e, ctx);
        if (el) slide.elements.push(el);
      }
      d.slides.push(slide);
    }
    this.readMeta();
    this.deck.clearHistory();
    return this.deck;
  }

  private readMeta(): void {
    const m = this.files.get('meta.xml');
    const doc = m ? parseXml(decodeXml(m)) : this.content;
    const t = (n: string) => desc(doc, n)[0]?.textContent?.trim() || undefined;
    const p = this.deck.data.props;
    const title = t('title'); if (title) p.title = title;
    const subj = t('subject'); if (subj) p.subject = subj;
    const cr = t('initial-creator') || t('creator'); if (cr) p.author = cr;
    const kw = desc(doc, 'keyword').map((k) => k.textContent).join(', '); if (kw) p.keywords = kw;
    const ds = t('description'); if (ds) p.description = ds;
    const cd = t('creation-date'); if (cd && !isNaN(Date.parse(cd))) p.created = Date.parse(cd);
  }

  private transition(pp: Props, page: Element): Transition | undefined {
    let type = pp['type'];
    let sub = pp['subtype'], dir = pp['direction'];
    const tf = desc(page, 'transitionFilter')[0];
    if (!type && tf) { type = attr(tf, 'type') || ''; sub = attr(tf, 'subtype') || ''; dir = attr(tf, 'direction') || ''; }
    const auto = pp['transition-type'] === 'automatic';
    const durM = /PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/.exec(pp['duration'] || '');
    const advAfter = auto && durM ? ((+(durM[1] || 0)) * 3600 + (+(durM[2] || 0)) * 60 + (+(durM[3] || 0))) * 1000 : undefined;
    if (!type && advAfter == null) return undefined;
    const t: Transition = { type: type ? SMIL_TO_TRANS[type] || 'fade' : 'none' };
    const speed = pp['transition-speed'];
    const sd = tf ? attr(tf, 'dur') : null;
    t.dur = sd ? parseFloat(sd) * (sd.endsWith('ms') ? 1 : 1000) : speed === 'slow' ? 1000 : speed === 'fast' ? 500 : 750;
    if (type === 'fade' && sub === 'fadeOverColor') t.thruBlk = true;
    const reverse = dir === 'reverse';
    if (sub && SUB_DIR[sub]) {
      t.dir = SUB_DIR[sub];
      // A reversed bar wipe runs right-to-left / bottom-to-top.
      if (type === 'barWipe' && reverse) t.dir = t.dir === 'r' ? 'l' : t.dir === 'd' ? 'u' : t.dir;
    }
    if (t.type === 'split' && reverse) t.inOut = 'in';
    if (t.type === 'cover' && reverse) t.type = 'uncover';
    if (advAfter != null) t.advAfter = advAfter;
    return t;
  }

  // ------------------------------------------------------------------------------------------
  // Elements

  private box(e: Element, el: any): void {
    const x = len(attr(e, 'x')), y = len(attr(e, 'y')), w = len(attr(e, 'width')), h = len(attr(e, 'height'));
    if (x != null) el.x = x; if (y != null) el.y = y; if (w != null) el.w = w; if (h != null) el.h = h;
    const tr = attr(e, 'transform');
    if (tr) {
      // rotate(a) translate(x y): ODF rotates around the top-left corner, counter-clockwise, in radians.
      const r = /rotate\s*\(\s*(-?[\d.e-]+)\s*\)/.exec(tr), t = /translate\s*\(\s*(-?[\d.]+[a-z]*)\s*[ ,]\s*(-?[\d.]+[a-z]*)\s*\)/.exec(tr);
      if (r) {
        const ang = -parseFloat(r[1]) * 180 / Math.PI;
        el.rot = +(((ang % 360) + 360) % 360).toFixed(2);
        if (t && el.w != null && el.h != null) {
          // Translate is the rotated top-left corner; recover the unrotated box from its center.
          const tx = len(t[1]) || 0, ty = len(t[2]) || 0, a = parseFloat(r[1]);
          const cx = tx + (el.w / 2) * Math.cos(a) + (el.h / 2) * Math.sin(a);
          const cy = ty - (el.w / 2) * Math.sin(a) + (el.h / 2) * Math.cos(a);
          el.x = cx - el.w / 2; el.y = cy - el.h / 2;
        }
      }
    }
    const nm = attr(e, 'name'); if (nm) el.name = nm;
  }

  element(e: Element, ctx: Ctx): SEl | null {
    const id = newId('od');
    const ln = e.localName;
    const gp = this.props(attr(e, 'style-name'), 'graphic');
    const prp = attr(e, 'class') ? { ...this.props(attr(e, 'style-name'), 'presentation') } : {};
    const props = { ...gp, ...prp };
    const title = kid(e, 'title')?.textContent || undefined;
    const descr = kid(e, 'desc')?.textContent || undefined;
    const common = (el: any) => { if (descr) el.alt = descr; if (title) el.title = title; return el; };
    if (ln === 'frame') {
      const cls = attr(e, 'class');
      const tbox = kid(e, 'text-box'), img = kid(e, 'image'), obj = kid(e, 'object'), tbl = kid(e, 'table'), plugin = kid(e, 'plugin');
      if (tbl) {
        const t = this.table(tbl, id);
        this.box(e, t);
        return common(t);
      }
      if (plugin) {
        const href = attr(plugin, 'href') || '';
        const m = this.media(href);
        if (m) {
          const me: MediaElement = { id, kind: 'media', media: m, mediaKind: /audio/.test(attr(plugin, 'mime-type') || sniffMediaMime(this.files.get(href) || new Uint8Array(), href)) ? 'audio' : 'video' };
          this.box(e, me);
          return common(me);
        }
      }
      if (img && !tbox) {
        const href = attr(img, 'href') || '';
        const m = this.media(href) || (kid(e, 'image') ? this.media(attr(kids(e).filter((k) => k.localName === 'image')[1], 'href') || '') : undefined);
        const pic: PictureElement = { id, kind: 'picture', media: m || '' };
        this.box(e, pic);
        const clip = gp['clip'];
        if (clip && pic.w && pic.h) {
          const v = /rect\(([^)]*)\)/.exec(clip)?.[1].trim().split(/\s*,\s*|\s+/).map((x) => (x === 'auto' ? 0 : len(x)));
          if (v && v.length === 4) {
            const [t, r, b, l] = (v as (number | undefined)[]).map((x) => x || 0);
            // fo:clip offsets are measured against the picture's intrinsic size, not the frame.
            const bytes = this.files.get(href.replace(/^\.\//, ''));
            const nat = bytes ? imageSizePt(bytes) : null;
            const W = nat ? nat.w : pic.w + l + r, H = nat ? nat.h : pic.h + t + b;
            const c = [l / W, t / H, r / W, b / H].map((x) => Math.max(0, Math.min(0.999, x)));
            if (W > 0 && H > 0 && c.some((x) => x > 0)) pic.crop = c as [number, number, number, number];
          }
        }
        if (cls === 'graphic' || cls === 'object') pic.ph = undefined;
        return common(pic);
      }
      if (obj && !tbox) {
        // Embedded objects (charts, formulas): use the replacement picture when there is one.
        const rep = kids(e).find((k) => k.localName === 'image');
        const m = rep ? this.media(attr(rep, 'href') || '') : undefined;
        if (m) { const pic: PictureElement = { id, kind: 'picture', media: m }; this.box(e, pic); return common(pic); }
        this.warnings.push('An embedded object without a preview picture was left out.');
        return null;
      }
      const sp: ShapeElement = { id, kind: 'shape', geom: 'rect', textbox: !cls };
      this.box(e, sp);
      if (cls) {
        const map: Record<string, ShapeElement['ph']> = { title: { type: 'title' }, subtitle: { type: 'subTitle', idx: 1 }, outline: { type: 'body', idx: 1 }, notes: { type: 'body' }, 'date-time': { type: 'dt' }, footer: { type: 'ftr' }, 'page-number': { type: 'sldNum' }, graphic: { type: 'pic', idx: 1 }, object: { type: 'obj', idx: 1 }, chart: { type: 'chart', idx: 1 }, table: { type: 'tbl', idx: 1 } };
        if (map[cls]) { sp.ph = map[cls]; delete sp.textbox; }
        if (ctx.owner === 'slide' && sp.ph?.type === 'title' && this.isCenteredTitle(e)) sp.ph = { type: 'ctrTitle' };
      }
      const f = this.fill(props); if (f && !(sp.ph && f.type === 'none')) sp.fill = f;
      const l = this.line(props); if (l && !(sp.ph && l.fill?.type === 'none')) sp.line = l;
      const tb = this.textBody(tbox, props, sp.ph?.type === 'body' || attr(e, 'class') === 'outline');
      if (tb && (tb.paras.some((p) => p.runs.length) || !sp.ph)) sp.text = tb;
      if (attr(e, 'placeholder') === 'true' && sp.text) sp.text.paras = [{ level: 0, runs: [] }];
      return common(sp);
    }
    if (ln === 'custom-shape' || ln === 'rect' || ln === 'ellipse' || ln === 'circle' || ln === 'polygon' || ln === 'path' || ln === 'polyline' || ln === 'regular-polygon') {
      const sp: ShapeElement = { id, kind: 'shape', geom: ln === 'ellipse' || ln === 'circle' ? 'ellipse' : 'rect' };
      this.box(e, sp);
      if (ln === 'custom-shape') {
        const g = kid(e, 'enhanced-geometry');
        const t = attr(g, 'type') || 'rectangle';
        if (ENH_TO_PRESET[t]) sp.geom = ENH_TO_PRESET[t];
        else if (t.startsWith('ooxml-') && GEOMETRY[t.slice(6)]) sp.geom = t.slice(6);
        else {
          const vb = (attr(g, 'viewBox') || '0 0 21600 21600').split(/\s+/).map(Number);
          const ep = attr(g, 'enhanced-path');
          const d = ep ? enhancedToSvg(ep) : '';
          if (d) { sp.geom = 'custom'; sp.path = [{ d, w: vb[2] || 21600, h: vb[3] || 21600 }]; }
        }
        if (attr(g, 'mirror-horizontal') === 'true') sp.flipH = true;
        if (attr(g, 'mirror-vertical') === 'true') sp.flipV = true;
      } else if (ln === 'polygon' || ln === 'path' || ln === 'polyline') {
        const vb = (attr(e, 'viewBox') || '0 0 1 1').split(/\s+/).map(Number);
        let d = attr(e, 'd') || '';
        if (!d && attr(e, 'points')) d = 'M' + (attr(e, 'points') || '').trim().split(/\s+/).map((p) => p.replace(',', ' ')).join(' L') + (ln === 'polygon' ? ' Z' : '');
        if (d) { sp.geom = 'custom'; sp.path = [{ d: absolutize(d), w: vb[2] || 1, h: vb[3] || 1 }]; }
      }
      const f = this.fill(props); sp.fill = f || (ln === 'polyline' ? { type: 'none' } : { type: 'solid', color: this.color(props['fill-color']) || '#729FCF' });
      const l = this.line(props); sp.line = l || { fill: { type: 'solid', color: '#3465A4' }, width: 0.75 };
      const tb = this.textBody(e, props, false);
      if (tb && tb.paras.some((p) => p.runs.length)) sp.text = tb;
      return common(sp);
    }
    if (ln === 'line' || ln === 'connector') {
      const x1 = len(attr(e, 'x1')) ?? 0, y1 = len(attr(e, 'y1')) ?? 0, x2 = len(attr(e, 'x2')) ?? 0, y2 = len(attr(e, 'y2')) ?? 0;
      const sp: ShapeElement = { id, kind: 'shape', geom: 'line', x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
      if (x2 < x1) sp.flipH = true;
      if (y2 < y1) sp.flipV = true;
      sp.line = this.line(props) || { fill: { type: 'solid', color: '#3465A4' }, width: 0.75 };
      sp.fill = { type: 'none' };
      return common(sp);
    }
    if (ln === 'g') {
      const children = kids(e).map((k) => this.element(k, ctx)).filter(Boolean) as SEl[];
      if (!children.length) return null;
      const g: GroupElement = { id, kind: 'group', children };
      return common(g);
    }
    return null;
  }

  private isCenteredTitle(_e: Element): boolean { return false; }

  private table(tbl: Element, id: string): TableElement {
    const cols: number[] = [];
    for (const c of desc(tbl, 'table-column')) {
      const w = len(this.props(attr(c, 'style-name'), 'table-column')['column-width']) || 72;
      const rep = Math.min(64, parseInt(attr(c, 'number-columns-repeated') || '1', 10) || 1);
      for (let i = 0; i < rep; i++) cols.push(w);
    }
    const t: TableElement = { id, kind: 'table', cols, rows: [] };
    for (const r of desc(tbl, 'table-row')) {
      const h = len(this.props(attr(r, 'style-name'), 'table-row')['row-height']) || 28;
      const cells: TableCell[] = [];
      for (const c of kids(r)) {
        if (c.localName === 'covered-table-cell') { cells.push({ text: { paras: [{ level: 0, runs: [] }] }, merged: true }); continue; }
        if (c.localName !== 'table-cell') continue;
        const cp = this.props(attr(c, 'style-name'), 'table-cell');
        const cell: TableCell = { text: this.textBody(c, cp, false) || { paras: [{ level: 0, runs: [] }] } };
        const cs = parseInt(attr(c, 'number-columns-spanned') || '1', 10); if (cs > 1) cell.colSpan = cs;
        const rs = parseInt(attr(c, 'number-rows-spanned') || '1', 10); if (rs > 1) cell.rowSpan = rs;
        const f = this.fill(cp) || (cp['background-color'] && cp['background-color'] !== 'transparent' ? { type: 'solid' as const, color: this.color(cp['background-color']) || '#FFFFFF' } : undefined);
        if (f) cell.fill = f;
        cells.push(cell);
      }
      t.rows.push({ h, cells });
    }
    if (!t.cols.length) t.cols = new Array(Math.max(1, ...t.rows.map((r) => r.cells.length))).fill(96);
    return t;
  }

  textBody(container: Element | null, frameProps: Props, outline: boolean): TextBody | undefined {
    if (!container) return undefined;
    const body: TextBody = { paras: [] };
    const va = frameProps['textarea-vertical-align'];
    if (va) body.anchor = va === 'middle' ? 'ctr' : va === 'bottom' ? 'b' : 't';
    const pad = ['padding-left', 'padding-top', 'padding-right', 'padding-bottom'].map((k) => len(frameProps[k]));
    if (pad.some((v) => v != null)) body.insets = pad.map((v) => v ?? 7.2) as [number, number, number, number];
    if (frameProps['shrink-to-fit'] === 'true' || frameProps['fit-to-size'] === 'shrink-to-fit' || frameProps['fit-to-size'] === 'true') body.autofit = 'shrink';
    else if (frameProps['auto-grow-height'] === 'true') body.autofit = 'resize';
    if (frameProps['wrap-option'] === 'no-wrap') body.wrap = false;
    const walk = (el: Element, level: number, listStyle?: string, inList = false) => {
      for (const c of kids(el)) {
        if (c.localName === 'p' || c.localName === 'h') body.paras.push(this.paragraph(c, inList ? level : 0, inList && !outline ? this.bulletFor(listStyle, level) : undefined));
        else if (c.localName === 'list') walk(c, inList ? level + 1 : 0, attr(c, 'style-name') || listStyle, true);
        else if (c.localName === 'list-item' || c.localName === 'list-header') walk(c, level, listStyle, true);
      }
    };
    walk(container, 0);
    if (!body.paras.length) return undefined;
    return body;
  }

  private bulletFor(listStyle: string | undefined, level: number): Paragraph['bullet'] {
    const ls = listStyle ? this.listStyles.get(listStyle) : undefined;
    const lv = ls ? kids(ls).find((k) => attr(k, 'level') === String(level + 1)) : undefined;
    if (lv?.localName === 'list-level-style-number') {
      const f = attr(lv, 'num-format') || '1';
      const suf = attr(lv, 'num-suffix') || '.';
      const scheme = f === 'a' ? 'alphaLcPeriod' : f === 'A' ? 'alphaUcPeriod' : f === 'i' ? 'romanLcPeriod' : f === 'I' ? 'romanUcPeriod' : suf === ')' ? 'arabicParenR' : 'arabicPeriod';
      return { kind: 'num', scheme };
    }
    const ch = attr(lv, 'bullet-char');
    return { kind: 'char', char: ch || '•' };
  }

  private paragraph(p: Element, level: number, bullet?: Paragraph['bullet']): Paragraph {
    const pp = this.props(attr(p, 'style-name'), 'paragraph');
    const para: Paragraph = { level: Math.min(8, level), runs: [], ...this.paraProps(pp) };
    if (bullet) { para.bullet = bullet; if (para.marL == null) { para.marL = 18 + 36 * level; para.indent = -18; } }
    const base = this.runProps(pp);
    const walk = (el: Element, rp: RunProps, link?: string) => {
      for (let n = el.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3) {
          const t = (n.nodeValue || '').replace(/\s+/g, ' ');
          if (t) para.runs.push({ text: t, ...rp, ...(link ? { link } : {}) });
          continue;
        }
        if (n.nodeType !== 1) continue;
        const c = n as Element;
        switch (c.localName) {
          case 'span': walk(c, { ...rp, ...this.runProps(this.props(attr(c, 'style-name'), 'text')) }, link); break;
          case 'a': walk(c, rp, attr(c, 'href') || undefined); break;
          case 's': para.runs.push({ text: ' '.repeat(parseInt(attr(c, 'c') || '1', 10) || 1), ...rp }); break;
          case 'tab': para.runs.push({ text: '\t', ...rp }); break;
          case 'line-break': para.runs.push({ text: '', br: true, ...rp }); break;
          case 'page-number': para.runs.push({ text: c.textContent || '', field: 'slidenum', ...rp }); break;
          case 'date': case 'time': case 'date-time': para.runs.push({ text: c.textContent || '', field: 'datetime', ...rp }); break;
          default: if (c.textContent) walk(c, rp, link);
        }
      }
    };
    walk(p, base);
    // Merge adjacent runs with identical props.
    const merged: Run[] = [];
    for (const r of para.runs) {
      const last = merged[merged.length - 1];
      if (last && !last.br && !r.br && !last.field && !r.field && JSON.stringify({ ...last, text: '' }) === JSON.stringify({ ...r, text: '' })) last.text += r.text;
      else merged.push({ ...r });
    }
    if (merged.length) { merged[0].text = merged[0].text.replace(/^ +/, (m) => (merged[0].text.length === m.length ? m : '')); }
    para.runs = merged;
    return para;
  }
}

interface Ctx { owner: 'master' | 'slide' }

/** Converts an ODF enhanced-path (M L C Z N F S with numbers) to an SVG path; returns '' when it uses formulas. */
function enhancedToSvg(p: string): string {
  if (/[?$]/.test(p)) return '';
  return p.replace(/\b[NFS]\b/g, '').replace(/\s+/g, ' ').trim();
}

/** Makes relative SVG path commands absolute (enough for polygons and simple paths). */
function absolutize(d: string): string {
  if (!/[mlhvcqz]/.test(d.replace(/[MLHVCQZAS]/g, ''))) return d;
  const toks = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) || [];
  let i = 0, x = 0, y = 0, sx = 0, sy = 0, cmd = '';
  const out: string[] = [];
  const n = () => parseFloat(toks[i++]);
  while (i < toks.length) {
    if (/[a-zA-Z]/.test(toks[i])) cmd = toks[i++];
    const rel = cmd === cmd.toLowerCase();
    switch (cmd.toUpperCase()) {
      case 'M': { const a = n(), b = n(); x = rel ? x + a : a; y = rel ? y + b : b; sx = x; sy = y; out.push(`M${x} ${y}`); cmd = rel ? 'l' : 'L'; break; }
      case 'L': { const a = n(), b = n(); x = rel ? x + a : a; y = rel ? y + b : b; out.push(`L${x} ${y}`); break; }
      case 'H': { const a = n(); x = rel ? x + a : a; out.push(`L${x} ${y}`); break; }
      case 'V': { const b = n(); y = rel ? y + b : b; out.push(`L${x} ${y}`); break; }
      case 'C': { const v = [n(), n(), n(), n(), n(), n()]; if (rel) for (let k = 0; k < 6; k++) v[k] += k % 2 ? y : x; out.push(`C${v.join(' ')}`); x = v[4]; y = v[5]; break; }
      case 'Q': { const v = [n(), n(), n(), n()]; if (rel) for (let k = 0; k < 4; k++) v[k] += k % 2 ? y : x; out.push(`Q${v.join(' ')}`); x = v[2]; y = v[3]; break; }
      case 'Z': out.push('Z'); x = sx; y = sy; break;
      default: i++;
    }
  }
  return out.join(' ');
}

export async function importOdp(data: Uint8Array): Promise<{ deck: Deck; warnings: string[] }> {
  const head = dec(data.subarray(0, 512));
  if (/^\s*<|^﻿/.test(head)) return importFodp(data);
  // Parts are inflated with size caps; binaries only when content or styles refer to them.
  const files = await readZipCapped(data, {
    phase2: (parts) => {
      let xml = '';
      for (const [k, v] of parts) if (/\.xml$/i.test(k) && !/manifest\.xml$/i.test(k)) xml += decodeXml(v);
      return (name) => { const base = name.split('/').pop() || name; return xml.includes(name) || xml.includes(encodeURI(name)) || xml.includes(base); };
    },
  });
  const r = importOdpParts(files.files);
  r.warnings.push(...files.warnings);
  return r;
}

export function importOdpParts(files: Map<string, Uint8Array>): { deck: Deck; warnings: string[] } {
  const c = files.get('content.xml');
  const content = c ? parseXml(decodeXml(c)) : null;
  if (!content) throw new Error('The presentation content (content.xml) is missing or unreadable.');
  const s = files.get('styles.xml');
  const styles = s ? parseXml(decodeXml(s)) : null;
  const imp = new OdpImporter(files, content, styles);
  if (s && !styles) imp.warnings.push('styles.xml could not be read; default styles were used.');
  return { deck: imp.run(), warnings: imp.warnings };
}

export function importFodp(data: Uint8Array): { deck: Deck; warnings: string[] } {
  const doc = parseXml(decodeXml(data));
  if (!doc) throw new Error('This flat OpenDocument file is not well-formed XML.');
  // Embedded pictures in flat files carry base64 data in office:binary-data.
  const files = new Map<string, Uint8Array>();
  let n = 0;
  for (const img of desc(doc, 'image')) {
    const bin = kid(img, 'binary-data');
    if (bin?.textContent) {
      const name = `Pictures/embedded${++n}`;
      try { files.set(name, unb64(bin.textContent.replace(/\s+/g, ''))); img.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', name); } catch { /* bad base64 */ }
    }
  }
  const imp = new OdpImporter(files, doc, doc);
  return { deck: imp.run(), warnings: imp.warnings };
}

// ------------------------------------------------------------------------------------------
// Export

const NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:smil="urn:oasis:names:tc:opendocument:xmlns:smil-compatible:1.0" xmlns:anim="urn:oasis:names:tc:opendocument:xmlns:animation:1.0" xmlns:loext="urn:org:documentfoundation:names:experimental:office:xmlns:loext:1.0"';

const TRANS_TO_SMIL: Record<string, [string, string]> = {
  fade: ['fade', 'crossfade'], push: ['pushWipe', 'fromRight'], wipe: ['barWipe', 'leftToRight'], split: ['barnDoorWipe', 'vertical'], cover: ['slideWipe', 'fromRight'],
  uncover: ['slideWipe', 'fromRight'], reveal: ['slideWipe', 'fromRight'], pull: ['slideWipe', 'fromRight'], zoom: ['irisWipe', 'rectangle'], randomBars: ['randomBarWipe', 'vertical'],
  circle: ['ellipseWipe', 'circle'], shape: ['ellipseWipe', 'circle'], diamond: ['irisWipe', 'diamond'], plus: ['fourBoxWipe', 'cornersIn'], wedge: ['fanWipe', 'centerTop'],
  clock: ['clockWipe', 'clockwiseTwelve'], blinds: ['blindsWipe', 'vertical'], checker: ['checkerBoardWipe', 'down'], comb: ['randomBarWipe', 'horizontal'], dissolve: ['dissolve', 'defaultSubtype'],
  flip: ['fade', 'crossfade'], cube: ['pushWipe', 'fromRight'], gallery: ['pushWipe', 'fromRight'], morph: ['fade', 'crossfade'],
};
const DIR_SUB: Record<string, Record<string, string>> = {
  pushWipe: { l: 'fromLeft', r: 'fromRight', u: 'fromTop', d: 'fromBottom' },
  slideWipe: { l: 'fromLeft', r: 'fromRight', u: 'fromTop', d: 'fromBottom', lu: 'fromTopLeft', ru: 'fromTopRight', ld: 'fromBottomLeft', rd: 'fromBottomRight' },
  barWipe: { l: 'leftToRight', r: 'leftToRight', u: 'topToBottom', d: 'topToBottom' },
  barnDoorWipe: { horz: 'horizontal', vert: 'vertical' },
};

/** A split transition also records whether it opens out (default) or closes in. */
export type SplitTransition = Transition;

/** SMIL type, subtype and reverse flag of a transition. */
function smilOf(t: Transition): { type: string; sub: string; reverse: boolean } {
  const [type, sub0] = TRANS_TO_SMIL[t.type] || TRANS_TO_SMIL.fade;
  const sub = (t.dir && DIR_SUB[type]?.[t.dir]) || (t.thruBlk && type === 'fade' ? 'fadeOverColor' : sub0);
  let reverse = t.type === 'uncover' || t.type === 'reveal' || t.type === 'pull';
  // Bar wipes run left-to-right / top-to-bottom; the opposite directions are reversed.
  if (type === 'barWipe' && (t.dir === 'l' || t.dir === 'u')) reverse = true;
  if (type === 'barnDoorWipe' && t.inOut === 'in') reverse = true;
  return { type, sub, reverse };
}

class OdpWriter {
  auto: string[] = [];
  autoKeys = new Map<string, string>();
  counters: Record<string, number> = {};
  files = new Map<string, Uint8Array>();
  manifest: [string, string][] = [];
  mediaPaths = new Map<string, string>();
  fonts = new Set<string>();
  warnings: string[] = [];
  constructor(public deck: Deck, public flat: boolean) {}

  /** Returns an automatic style name for these properties, reusing identical ones. */
  style(family: string, prefix: string, body: string, attrs = ''): string {
    const key = `${family}|${attrs}|${body}`;
    const hit = this.autoKeys.get(key);
    if (hit) return hit;
    const n = (this.counters[prefix] = (this.counters[prefix] || 0) + 1);
    const name = `${prefix}${n}`;
    this.auto.push(`<style:style style:name="${name}" style:family="${family}"${attrs}>${body}</style:style>`);
    this.autoKeys.set(key, name);
    return name;
  }

  cc(owner: Slide | Layout | Master): ColorContext {
    const m = 'styles' in owner ? owner : this.deck.masterOf(owner as any);
    return { theme: this.deck.theme(m.theme), master: m };
  }

  hex(c: Color | undefined, ctx: ColorContext, fb = '#000000'): string { return resolveColor(c, ctx, fb).hex.toLowerCase(); }

  media(id: string): string | null {
    if (this.mediaPaths.has(id)) return this.mediaPaths.get(id)!;
    const m = this.deck.media[id];
    if (!m) return null;
    // Flat files embed pictures inline (office:binary-data); nothing goes into a package.
    if (this.flat) { const p = `Pictures/${id}`; this.mediaPaths.set(id, p); return p; }
    const ext = MIME_EXT[m.mime] || 'bin';
    const dir = /^image\//.test(m.mime) ? 'Pictures' : 'Media';
    const p = `${dir}/${id}.${ext}`;
    this.files.set(p, unb64(m.b64));
    this.manifest.push([p, m.mime]);
    this.mediaPaths.set(id, p);
    return p;
  }

  href(p: string): string {
    if (!this.flat) return `xlink:href="${esc(p)}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"`;
    return '';
  }

  graphicProps(fill: Fill | undefined, line: Line | undefined, ctx: ColorContext, text?: TextBody, isText = false): string {
    let a = '';
    if (!fill || fill.type === 'none') a += ' draw:fill="none"';
    else if (fill.type === 'solid') a += ` draw:fill="solid" draw:fill-color="${this.hex(fill.color, ctx)}"`;
    else if (fill.type === 'gradient') a += ` draw:fill="solid" draw:fill-color="${this.hex(fill.stops[0]?.color, ctx)}"`;
    else if (fill.type === 'pattern') a += ` draw:fill="solid" draw:fill-color="${this.hex(fill.fg, ctx)}"`;
    else a += ' draw:fill="none"';
    if (!line || !line.fill || line.fill.type === 'none') a += ' draw:stroke="none"';
    else {
      const c = line.fill.type === 'solid' ? line.fill.color : '#000000';
      a += ` draw:stroke="${line.dash && line.dash !== 'solid' ? 'dash' : 'solid'}" svg:stroke-color="${this.hex(c, ctx)}" svg:stroke-width="${pt(line.width ?? 0.75)}"`;
      if (line.tail && line.tail !== 'none') a += ' draw:marker-end="Arrow" draw:marker-end-width="0.3cm"';
      if (line.head && line.head !== 'none') a += ' draw:marker-start="Arrow" draw:marker-start-width="0.3cm"';
    }
    if (text) {
      const an = text.anchor || (isText ? 't' : 'ctr');
      a += ` draw:textarea-vertical-align="${an === 'ctr' ? 'middle' : an === 'b' ? 'bottom' : 'top'}"`;
      const ins = text.insets || [7.2, 3.6, 7.2, 3.6];
      a += ` fo:padding-left="${pt(ins[0])}" fo:padding-top="${pt(ins[1])}" fo:padding-right="${pt(ins[2])}" fo:padding-bottom="${pt(ins[3])}"`;
      if (text.autofit === 'shrink') a += ' draw:fit-to-size="false" style:shrink-to-fit="true"';
      if (text.autofit === 'resize') a += ' draw:auto-grow-height="true"';
      else a += ' draw:auto-grow-height="false"';
      if (text.wrap === false) a += ' fo:wrap-option="no-wrap"';
    }
    return `<style:graphic-properties${a}/>`;
  }

  textProps(r: RunProps, ctx: ColorContext): string {
    let a = '';
    if (r.size) a += ` fo:font-size="${pt(r.size)}"`;
    if (r.b != null) a += ` fo:font-weight="${r.b ? 'bold' : 'normal'}"`;
    if (r.i != null) a += ` fo:font-style="${r.i ? 'italic' : 'normal'}"`;
    if (r.u != null) a += r.u ? ' style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"' : ' style:text-underline-style="none"';
    if (r.strike != null) a += ` style:text-line-through-style="${r.strike ? 'solid' : 'none'}"`;
    if (r.color != null) a += ` fo:color="${this.hex(r.color, ctx)}"`;
    if (r.font) { const f = r.font.startsWith('+') ? (r.font.startsWith('+mj') ? ctx.theme.fonts.major : ctx.theme.fonts.minor) : r.font; this.fonts.add(f); a += ` style:font-name="${esc(f)}" fo:font-family="${esc(f)}"`; }
    if (r.highlight != null) a += ` fo:background-color="${this.hex(r.highlight, ctx, '#FFFF00')}"`;
    if (r.baseline) a += ` style:text-position="${r.baseline > 0 ? 'super' : 'sub'} 58%"`;
    if (r.caps === 'small') a += ' fo:font-variant="small-caps"';
    if (r.caps === 'all') a += ' fo:text-transform="uppercase"';
    return a ? `<style:text-properties${a}/>` : '';
  }

  paraStyle(p: Paragraph, ctx: ColorContext): string {
    let a = '';
    if (p.align) a += ` fo:text-align="${p.align === 'ctr' ? 'center' : p.align === 'r' ? 'end' : p.align === 'just' || p.align === 'dist' ? 'justify' : 'start'}"`;
    if (p.marL != null && !p.bullet) a += ` fo:margin-left="${pt(p.marL)}"`;
    if (p.indent != null && !p.bullet) a += ` fo:text-indent="${pt(p.indent)}"`;
    if (p.spaceBefore) a += ` fo:margin-top="${pt(p.spaceBefore)}"`;
    if (p.spaceAfter) a += ` fo:margin-bottom="${pt(p.spaceAfter)}"`;
    if (p.lineSpacing && !p.lineSpacingPt) a += ` fo:line-height="${Math.round(p.lineSpacing)}%"`;
    const tp = p.end ? this.textProps(p.end, ctx) : '';
    if (!a && !tp) return '';
    return this.style('paragraph', 'P', `${a ? `<style:paragraph-properties${a}/>` : ''}${tp}`);
  }

  paraXml(p: Paragraph, ctx: ColorContext): string {
    const ps = this.paraStyle(p, ctx);
    let inner = '';
    for (const r of p.runs) {
      if (r.br) { inner += '<text:line-break/>'; continue; }
      let t = esc(r.text).replace(/\t/g, '<text:tab/>').replace(/ {2,}/g, (m) => ` <text:s text:c="${m.length - 1}"/>`);
      if (r.field === 'slidenum') t = `<text:page-number>${t || '1'}</text:page-number>`;
      else if (r.field) t = `<text:date>${t}</text:date>`;
      const tp = this.textProps(r, ctx);
      let span = tp ? `<text:span text:style-name="${this.style('text', 'T', tp)}">${t}</text:span>` : t;
      if (r.link) span = `<text:a xlink:type="simple" xlink:href="${esc(r.link)}">${span}</text:a>`;
      inner += span;
    }
    return `<text:p${ps ? ` text:style-name="${ps}"` : ''}>${inner}</text:p>`;
  }

  listStyle(): string {
    if (this.autoKeys.has('list-style')) return this.autoKeys.get('list-style')!;
    const name = 'L1';
    const lv = Array.from({ length: 9 }, (_, i) => `<text:list-level-style-bullet text:level="${i + 1}" text:bullet-char="${i % 2 ? '–' : '•'}"><style:list-level-properties text:space-before="${pt(i * 36)}" text:min-label-width="${pt(18)}"/></text:list-level-style-bullet>`).join('');
    this.auto.push(`<text:list-style style:name="${name}">${lv}</text:list-style>`);
    this.autoKeys.set('list-style', name);
    return name;
  }

  numListStyle(): string {
    if (this.autoKeys.has('num-list-style')) return this.autoKeys.get('num-list-style')!;
    const name = 'L2';
    const lv = Array.from({ length: 9 }, (_, i) => `<text:list-level-style-number text:level="${i + 1}" style:num-suffix="." style:num-format="1"><style:list-level-properties text:space-before="${pt(i * 36)}" text:min-label-width="${pt(18)}"/></text:list-level-style-number>`).join('');
    this.auto.push(`<text:list-style style:name="${name}">${lv}</text:list-style>`);
    this.autoKeys.set('num-list-style', name);
    return name;
  }

  /** Paragraphs as text:p, with outline (or bulleted) paragraphs nested in text:list by level. */
  textXml(paras: Paragraph[], ctx: ColorContext, outline: boolean): string {
    let out = '';
    let i = 0;
    while (i < paras.length) {
      const p = paras[i];
      const listed = outline ? p.bullet?.kind !== 'none' : !!p.bullet && p.bullet.kind !== 'none';
      if (!listed) { out += this.paraXml(p, ctx); i++; continue; }
      const num = p.bullet?.kind === 'num';
      const style = outline && !p.bullet ? '' : num ? this.numListStyle() : this.listStyle();
      // Collect a run of listed paragraphs.
      let j = i;
      while (j < paras.length && (outline ? paras[j].bullet?.kind !== 'none' : !!paras[j].bullet && paras[j].bullet!.kind !== 'none')) j++;
      out += this.listXml(paras.slice(i, j), ctx, style);
      i = j;
    }
    return out;
  }

  private listXml(paras: Paragraph[], ctx: ColorContext, style: string): string {
    // Each paragraph becomes <text:list-item> nested level+1 lists deep.
    return paras.map((p) => {
      let s = this.paraXml(p, ctx);
      for (let l = 0; l < p.level; l++) s = `<text:list><text:list-item>${s}</text:list-item></text:list>`;
      return `<text:list${style ? ` text:style-name="${style}"` : ''}><text:list-item>${s}</text:list-item></text:list>`;
    }).join('');
  }

  boxAttrs(e: { x?: number; y?: number; w?: number; h?: number; rot?: number }, fallback?: { x?: number; y?: number; w?: number; h?: number }): string {
    const x = e.x ?? fallback?.x ?? 0, y = e.y ?? fallback?.y ?? 0, w = e.w ?? fallback?.w ?? 100, h = e.h ?? fallback?.h ?? 50;
    if (e.rot) {
      const a = (-e.rot * Math.PI) / 180;
      // ODF rotates around the top-left: translate to the rotated top-left of the box.
      const cx = x + w / 2, cy = y + h / 2;
      const tx = cx - (w / 2) * Math.cos(a) - (h / 2) * Math.sin(a);
      const ty = cy + (w / 2) * Math.sin(a) - (h / 2) * Math.cos(a);
      return `svg:width="${pt(w)}" svg:height="${pt(h)}" draw:transform="rotate (${a.toFixed(6)}) translate (${pt(tx)} ${pt(ty)})"`;
    }
    return `svg:x="${pt(x)}" svg:y="${pt(y)}" svg:width="${pt(w)}" svg:height="${pt(h)}"`;
  }

  element(e: SEl, owner: Slide | Layout | Master, layer = 'layout'): string {
    const ctx = this.cc(owner);
    const nm = e.name ? ` draw:name="${esc(e.name)}"` : '';
    const td = `${e.title ? `<svg:title>${esc(e.title)}</svg:title>` : ''}${e.alt ? `<svg:desc>${esc(e.alt)}</svg:desc>` : ''}`;
    const fb = e.ph ? this.inheritBox(e, owner) : undefined;
    switch (e.kind) {
      case 'shape': {
        const s = e as ShapeElement;
        const text = s.text?.paras.some((p) => p.runs.some((r) => r.text)) ? s.text : undefined;
        const isLine = /^(line|straightConnector1|bentConnector\d|curvedConnector\d)$/.test(s.geom);
        if (isLine) {
          const x = s.x ?? 0, y = s.y ?? 0, w = s.w ?? 0, h = s.h ?? 0;
          const [x1, x2] = s.flipH ? [x + w, x] : [x, x + w];
          const [y1, y2] = s.flipV ? [y + h, y] : [y, y + h];
          const gs = this.style('graphic', 'gr', this.graphicProps({ type: 'none' }, s.line || { fill: { type: 'solid', color: 'accent1' }, width: 1 }, ctx));
          return `<draw:line draw:style-name="${gs}" draw:layer="${layer}"${nm} svg:x1="${pt(x1)}" svg:y1="${pt(y1)}" svg:x2="${pt(x2)}" svg:y2="${pt(y2)}">${td}${text ? this.textXml(text.paras, ctx, false) : ''}</draw:line>`;
        }
        if (s.ph || s.textbox || (s.geom === 'rect' && !s.fill && !s.line)) {
          const cls = s.ph ? ({ title: 'title', ctrTitle: 'title', subTitle: 'subtitle', body: 'outline', obj: 'outline', dt: 'date-time', ftr: 'footer', sldNum: 'page-number', pic: 'graphic', chart: 'chart', tbl: 'table', media: 'object' } as any)[s.ph.type] || 'outline' : '';
          const outline = cls === 'outline';
          const gp = this.graphicProps(s.fill || { type: 'none' }, s.line, ctx, s.text || { paras: [] }, true);
          const gs = this.style(cls ? 'presentation' : 'graphic', cls ? 'pr' : 'gr', gp);
          const styleAttr = cls ? `presentation:style-name="${gs}" presentation:class="${cls}"${text ? '' : ' presentation:placeholder="true"'} presentation:user-transformed="true"` : `draw:style-name="${gs}"`;
          return `<draw:frame ${styleAttr} draw:layer="${layer}"${nm} ${this.boxAttrs(s, fb)}><draw:text-box>${text ? this.textXml(text.paras, ctx, outline) : ''}</draw:text-box>${td}</draw:frame>`;
        }
        const gp = this.graphicProps(s.fill ?? { type: 'solid', color: 'accent1' }, s.line ?? { fill: { type: 'solid', color: { s: 'accent1', lum: -0.5 } }, width: 1 }, ctx, s.text || { paras: [] });
        const gs = this.style('graphic', 'gr', gp);
        const enh = s.geom !== 'custom' ? PRESET_TO_ENH[s.geom] : undefined;
        const w = s.w ?? 100, h = s.h ?? 50;
        const textXml = text ? this.textXml(text.paras, ctx, false) : '';
        if (enh) {
          const mirror = `${s.flipH ? ' draw:mirror-horizontal="true"' : ''}${s.flipV ? ' draw:mirror-vertical="true"' : ''}`;
          return `<draw:custom-shape draw:style-name="${gs}" draw:layer="${layer}"${nm} ${this.boxAttrs(s)}>${td}${textXml}<draw:enhanced-geometry svg:viewBox="0 0 21600 21600" draw:type="${enh}"${mirror}/></draw:custom-shape>`;
        }
        const { d } = geometryPath(s.geom, w, h, s.adj, s.path);
        return `<draw:path draw:style-name="${gs}" draw:layer="${layer}"${nm} ${this.boxAttrs(s)} svg:viewBox="0 0 ${Math.max(1, Math.round(w))} ${Math.max(1, Math.round(h))}" svg:d="${esc(d.replace(/(\d+\.\d{2})\d+/g, '$1'))}">${td}${textXml}</draw:path>`;
      }
      case 'picture': {
        const p = e.media ? this.media(e.media) : null;
        let gp = '<style:graphic-properties draw:fill="none" draw:stroke="none"/>';
        if (e.crop && e.crop.some((v) => v) && e.w && e.h) {
          const [l, t, r, b] = e.crop; const vw = 1 - l - r, vh = 1 - t - b;
          // fo:clip is measured against the picture's intrinsic size (96 dpi when it records none).
          const m = this.deck.media[e.media];
          let nat: { w: number; h: number } | null = null;
          try { nat = m && /^image\//.test(m.mime) ? imageSizePt(unb64(m.b64.slice(0, 200000))) : null; } catch { nat = null; }
          const W = nat ? nat.w : e.w / (vw || 1), H = nat ? nat.h : e.h / (vh || 1);
          gp = `<style:graphic-properties draw:fill="none" draw:stroke="none" fo:clip="rect(${pt(t * H)}, ${pt(r * W)}, ${pt(b * H)}, ${pt(l * W)})"/>`;
        }
        const gs = this.style('graphic', 'gr', gp);
        if (!p) return '';
        const img = this.flat ? `<draw:image><office:binary-data>${this.deck.media[e.media].b64}</office:binary-data></draw:image>` : `<draw:image ${this.href(p)}/>`;
        return `<draw:frame draw:style-name="${gs}" draw:layer="${layer}"${nm} ${this.boxAttrs(e, fb)}>${img}${td}</draw:frame>`;
      }
      case 'media': {
        if (this.flat) {
          // A flat file cannot carry audio or video (draw:plugin has no inline data): keep the poster frame.
          this.warnings.push(`A ${e.mediaKind === 'audio' ? 'sound' : 'video'} was left out: flat OpenDocument files cannot embed media${e.poster ? ' (its poster picture was kept)' : ''}.`);
          if (!e.poster || !this.deck.media[e.poster]) return '';
          return this.element({ id: e.id, kind: 'picture', media: e.poster, x: e.x, y: e.y, w: e.w, h: e.h, name: e.name, alt: e.alt } as PictureElement, owner, layer);
        }
        const p = this.media(e.media);
        if (!p) return '';
        const gs = this.style('graphic', 'gr', '<style:graphic-properties draw:fill="none" draw:stroke="none"/>');
        return `<draw:frame draw:style-name="${gs}" draw:layer="${layer}"${nm} ${this.boxAttrs(e)}><draw:plugin ${this.href(p)} draw:mime-type="${esc(this.deck.media[e.media].mime)}"/>${td}</draw:frame>`;
      }
      case 'table': return this.tableXml(e, ctx, layer, nm, td);
      case 'chart': {
        // Charts travel as pictures (SVG), which every ODF consumer can show.
        const c = (e as ChartElement).chart;
        const w = e.w ?? 400, h = e.h ?? 300;
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}pt" height="${h}pt">${renderChart(c, w, h, (col) => this.hex(col, ctx), e.id)}</svg>`;
        const path = `Pictures/${e.id.replace(/[^\w-]/g, '_')}.svg`;
        this.files.set(path, enc(svg));
        this.manifest.push([path, 'image/svg+xml']);
        const gs = this.style('graphic', 'gr', '<style:graphic-properties draw:fill="none" draw:stroke="none"/>');
        const img = this.flat ? `<draw:image><office:binary-data>${b64(enc(svg))}</office:binary-data></draw:image>` : `<draw:image ${this.href(path)}/>`;
        return `<draw:frame draw:style-name="${gs}" draw:layer="${layer}"${nm} ${this.boxAttrs(e)}>${img}${td}</draw:frame>`;
      }
      case 'group': return `<draw:g${nm}>${(e as GroupElement).children.map((c) => this.element(c, owner, layer)).join('')}</draw:g>`;
    }
    return '';
  }

  /** Geometry a placeholder inherits from its layout or master. */
  inheritBox(e: SEl, owner: Slide | Layout | Master): { x?: number; y?: number; w?: number; h?: number } | undefined {
    if (e.x != null && e.w != null) return undefined;
    const lay = 'layout' in owner ? this.deck.layout(owner.layout) : undefined;
    const cands = [...(lay?.elements || []), ...(this.deck.masterOf(owner as any)?.elements || [])].filter((c) => c.ph);
    const t = e.ph!.type;
    const norm = (x: string) => (x === 'ctrTitle' ? 'title' : x === 'obj' || x === 'subTitle' ? 'body' : x);
    const m = cands.find((c) => c.ph!.type === t && (c.ph!.idx ?? 0) === (e.ph!.idx ?? 0)) || cands.find((c) => c.ph!.type === t) || cands.find((c) => norm(c.ph!.type) === norm(t));
    return m ? { x: m.x, y: m.y, w: m.w, h: m.h } : undefined;
  }

  private tableXml(t: TableElement, ctx: ColorContext, layer: string, nm: string, td: string): string {
    const cols = t.cols.map((w) => `<table:table-column table:style-name="${this.style('table-column', 'co', `<style:table-column-properties style:column-width="${pt(w)}"/>`)}"/>`).join('');
    const rows = t.rows.map((r) => {
      const rs = this.style('table-row', 'ro', `<style:table-row-properties style:row-height="${pt(r.h)}"/>`);
      const cells = r.cells.map((c) => {
        if (c.merged) return '<table:covered-table-cell/>';
        const fill = c.fill?.type === 'solid' ? ` draw:fill="solid" draw:fill-color="${this.hex(c.fill.color, ctx)}"` : '';
        const cs = fill ? ` table:style-name="${this.style('table-cell', 'ce', `<style:graphic-properties${fill}/>`)}"` : '';
        const span = `${(c.colSpan || 1) > 1 ? ` table:number-columns-spanned="${c.colSpan}"` : ''}${(c.rowSpan || 1) > 1 ? ` table:number-rows-spanned="${c.rowSpan}"` : ''}`;
        return `<table:table-cell${cs}${span}>${this.textXml(c.text?.paras || [{ level: 0, runs: [] }], ctx, false)}</table:table-cell>`;
      }).join('');
      return `<table:table-row table:style-name="${rs}">${cells}</table:table-row>`;
    }).join('');
    const flags = t.style?.firstRow ? ' table:use-first-row-styles="true"' : '';
    const gs = this.style('graphic', 'gr', '<style:graphic-properties draw:fill="none" draw:stroke="none"/>');
    return `<draw:frame draw:style-name="${gs}" draw:layer="${layer}"${nm} ${this.boxAttrs(t)}><table:table${flags}>${cols}${rows}</table:table>${td}</draw:frame>`;
  }

  pageStyle(s: Slide): string {
    const ctx = this.cc(s);
    let a = '';
    if (s.bg?.type === 'solid') a += ` draw:fill="solid" draw:fill-color="${this.hex(s.bg.color, ctx)}" draw:background-size="full"`;
    else if (s.bg?.type === 'gradient') a += ` draw:fill="solid" draw:fill-color="${this.hex(s.bg.stops[0]?.color, ctx)}"`;
    if (s.hidden) a += ' presentation:visibility="hidden"';
    const t = s.transition;
    if (t && t.type !== 'none' && t.type !== 'cut') {
      const { type, sub, reverse } = smilOf(t);
      a += ` smil:type="${type}" smil:subtype="${sub}"${reverse ? ' smil:direction="reverse"' : ''} presentation:transition-speed="${(t.dur ?? 700) >= 1000 ? 'slow' : (t.dur ?? 700) >= 600 ? 'medium' : 'fast'}"`;
    }
    if (t?.advAfter != null) a += ` presentation:transition-type="automatic" presentation:duration="PT${(t.advAfter / 1000).toFixed(3).replace(/\.?0+$/, '')}S"`;
    return this.style('drawing-page', 'dp', `<style:drawing-page-properties presentation:background-visible="true" presentation:background-objects-visible="${s.hideMasterShapes ? 'false' : 'true'}" presentation:display-footer="true" presentation:display-page-number="false" presentation:display-date-time="false"${a}/>`);
  }

  transitionAnim(s: Slide): string {
    const t = s.transition;
    if (!t || t.type === 'none' || t.type === 'cut') return '';
    const { type, sub, reverse } = smilOf(t);
    return `<anim:par presentation:node-type="timing-root"><anim:transitionFilter smil:dur="${((t.dur ?? 700) / 1000).toFixed(3)}s" smil:type="${type}" smil:subtype="${sub}"${reverse ? ' smil:direction="reverse"' : ''}/></anim:par>`;
  }
}

export async function exportOdp(deck: Deck, opts: { flat?: boolean; template?: boolean; /** Receives notes about content that could not be written. */ warnings?: string[] } = {}): Promise<Uint8Array> {
  const w = new OdpWriter(deck, !!opts.flat);
  const data = deck.data;
  const page = `<style:page-layout style:name="PM1"><style:page-layout-properties fo:margin-top="0pt" fo:margin-bottom="0pt" fo:margin-left="0pt" fo:margin-right="0pt" fo:page-width="${pt(data.size.w)}" fo:page-height="${pt(data.size.h)}" style:print-orientation="${data.size.w >= data.size.h ? 'landscape' : 'portrait'}"/></style:page-layout>`;
  const masterNames = new Map<string, string>();
  const masterStyles: string[] = [];
  const presStyles: string[] = [];
  const masterAuto: string[] = [];
  data.masters.forEach((m, i) => {
    const name = (m.name || `Master${i + 1}`).replace(/[^\w-]/g, '_') + (data.masters.slice(0, i).some((x) => x.name === m.name) ? `_${i}` : '');
    masterNames.set(m.id, name);
    const ctx = w.cc(m);
    const tl = m.styles.title[0] || {};
    presStyles.push(`<style:style style:name="${name}-title" style:family="presentation"><style:graphic-properties draw:fill="none" draw:stroke="none" draw:textarea-vertical-align="middle"/><style:paragraph-properties fo:text-align="${tl.align === 'ctr' ? 'center' : 'start'}"/>${w.textProps({ size: 44, ...(tl.run || {}) }, ctx)}</style:style>`);
    presStyles.push(`<style:style style:name="${name}-subtitle" style:family="presentation"><style:graphic-properties draw:fill="none" draw:stroke="none"/><style:paragraph-properties fo:text-align="center"/>${w.textProps({ size: 24, color: 'tx1', font: '+mn-lt' }, ctx)}</style:style>`);
    m.styles.body.slice(0, 9).forEach((lv, li) => {
      presStyles.push(`<style:style style:name="${name}-outline${li + 1}" style:family="presentation"${li ? ` style:parent-style-name="${name}-outline${li}"` : ''}>${li ? '' : '<style:graphic-properties draw:fill="none" draw:stroke="none"/>'}<style:paragraph-properties fo:margin-top="${pt(lv.spaceBefore ?? 6)}"/>${w.textProps(lv.run || {}, ctx)}</style:style>`);
    });
    presStyles.push(`<style:style style:name="${name}-background" style:family="presentation"><style:graphic-properties draw:stroke="none" draw:fill="none"/></style:style><style:style style:name="${name}-notes" style:family="presentation"><style:graphic-properties draw:fill="none" draw:stroke="none"/>${w.textProps({ size: 12 }, ctx)}</style:style>`);
    const bg = m.bg?.type === 'solid' ? ` draw:fill="solid" draw:fill-color="${w.hex(m.bg.color, ctx, '#FFFFFF')}"` : m.bg?.type === 'gradient' ? ` draw:fill="solid" draw:fill-color="${w.hex(m.bg.stops[0]?.color, ctx, '#FFFFFF')}"` : ' draw:fill="solid" draw:fill-color="#ffffff"';
    masterAuto.push(`<style:style style:name="Mdp${i + 1}" style:family="drawing-page"><style:drawing-page-properties${bg} draw:background-size="full"/></style:style>`);
    const els = m.elements.map((e) => {
      if (!e.ph) return w.element(e, m, 'backgroundobjects');
      if (e.ph.type === 'title' || e.ph.type === 'body') {
        const cls = e.ph.type === 'title' ? 'title' : 'outline';
        return `<draw:frame presentation:style-name="${name}-${cls === 'title' ? 'title' : 'outline1'}" draw:layer="backgroundobjects" ${w.boxAttrs(e)} presentation:class="${cls}" presentation:placeholder="true"><draw:text-box/></draw:frame>`;
      }
      return '';
    }).join('');
    masterStyles.push(`<style:master-page style:name="${name}" style:page-layout-name="PM1" draw:style-name="Mdp${i + 1}">${els}<presentation:notes style:page-layout-name="PM1"/></style:master-page>`);
  });
  // Master graphics may have created automatic styles in w.auto: those belong to styles.xml.
  // In a flat file both sets share one office:automatic-styles, so names must stay unique: keep the
  // counters (and allow reuse of identical styles) instead of starting over.
  const stylesAuto = w.auto.splice(0);
  if (!opts.flat) { w.autoKeys.clear(); w.counters = {}; }
  // Slides
  const pages = data.slides.map((s, i) => {
    const ps = w.pageStyle(s);
    const els = s.elements.map((e) => w.element(e, s)).join('');
    const notes = s.notes?.some((p) => p.runs.some((r) => r.text))
      ? `<presentation:notes><draw:page-thumbnail draw:layer="layout" svg:width="${pt(data.size.w * 0.5)}" svg:height="${pt(data.size.h * 0.5)}" svg:x="${pt(data.size.w * 0.25)}" svg:y="20pt" draw:page-number="${i + 1}" presentation:class="page"/><draw:frame presentation:class="notes" draw:layer="layout" svg:width="${pt(data.size.w * 0.8)}" svg:height="${pt(data.size.h * 0.5)}" svg:x="${pt(data.size.w * 0.1)}" svg:y="${pt(data.size.h * 0.6)}" presentation:user-transformed="true"><draw:text-box>${w.textXml(s.notes, w.cc(s), false)}</draw:text-box></draw:frame></presentation:notes>`
      : '';
    const mn = masterNames.get(deck.masterOf(s).id) || [...masterNames.values()][0];
    return `<draw:page draw:name="${esc(s.name || `page${i + 1}`)}" draw:style-name="${ps}" draw:master-page-name="${esc(mn)}">${els}${w.transitionAnim(s)}${notes}</draw:page>`;
  }).join('');
  const fontDecls = `<office:font-face-decls>${[...w.fonts, 'Carlito'].filter((f, i, a) => a.indexOf(f) === i).map((f) => `<style:font-face style:name="${esc(f)}" svg:font-family="${esc(f.includes(' ') ? `'${f}'` : f)}"/>`).join('')}</office:font-face-decls>`;
  const defaults = '<style:default-style style:family="graphic"><style:graphic-properties svg:stroke-color="#3465a4" draw:fill-color="#729fcf"/><style:paragraph-properties style:text-autospace="ideograph-alpha" style:writing-mode="lr-tb"/><style:text-properties fo:font-size="18pt" style:font-name="Carlito" fo:language="en" fo:country="US"/></style:default-style><style:style style:name="standard" style:family="graphic"><style:graphic-properties draw:stroke="solid" svg:stroke-width="0pt" svg:stroke-color="#3465a4" draw:fill="solid" draw:fill-color="#729fcf"/><style:text-properties fo:font-size="18pt"/></style:style>';
  const markers = '<draw:marker draw:name="Arrow" svg:viewBox="0 0 20 30" svg:d="M10 0l-10 30h20z"/>';
  const officeStyles = `<office:styles>${markers}${defaults}${presStyles.join('')}</office:styles>`;
  const stylesAutoXml = `<office:automatic-styles>${page}${masterAuto.join('')}${stylesAuto.join('')}</office:automatic-styles>`;
  const masterXml = `<office:master-styles>${masterStyles.join('')}</office:master-styles>`;
  const contentAuto = `<office:automatic-styles>${w.auto.join('')}</office:automatic-styles>`;
  const body = `<office:body><office:presentation>${pages}</office:presentation></office:body>`;
  const p = data.props;
  const now = new Date().toISOString().replace(/\.\d+Z$/, '');
  const metaInner = `<meta:generator>Anne\'s Stage</meta:generator>${p.title ? `<dc:title>${esc(p.title)}</dc:title>` : ''}${p.subject ? `<dc:subject>${esc(p.subject)}</dc:subject>` : ''}${p.author ? `<meta:initial-creator>${esc(p.author)}</meta:initial-creator><dc:creator>${esc(p.author)}</dc:creator>` : ''}${p.description ? `<dc:description>${esc(p.description)}</dc:description>` : ''}${(p.keywords || '').split(/\s*,\s*/).filter(Boolean).map((k) => `<meta:keyword>${esc(k)}</meta:keyword>`).join('')}<meta:creation-date>${p.created ? new Date(p.created).toISOString().replace(/\.\d+Z$/, '') : now}</meta:creation-date><dc:date>${now}</dc:date>`;
  const mime = opts.template ? OTP_MIME : ODP_MIME;
  if (opts.warnings) opts.warnings.push(...w.warnings.filter((x, i, a) => a.indexOf(x) === i));
  if (opts.flat) {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<office:document ${NS} office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.presentation"><office:meta>${metaInner}</office:meta>${fontDecls}${officeStyles}<office:automatic-styles>${page}${masterAuto.join('')}${stylesAuto.join('')}${w.auto.join('')}</office:automatic-styles>${masterXml}${body}</office:document>`;
    return enc(xml);
  }
  const contentXml = `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-content ${NS} office:version="1.3">${fontDecls}${contentAuto}${body}</office:document-content>`;
  const stylesXml = `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-styles ${NS} office:version="1.3">${fontDecls}${officeStyles}${stylesAutoXml}${masterXml}</office:document-styles>`;
  const metaXml = `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-meta ${NS} office:version="1.3"><office:meta>${metaInner}</office:meta></office:document-meta>`;
  const manifest = `<?xml version="1.0" encoding="UTF-8"?>\n<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="${mime}"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>${w.manifest.map(([f, m]) => `<manifest:file-entry manifest:full-path="${esc(f)}" manifest:media-type="${esc(m)}"/>`).join('')}</manifest:manifest>`;
  const zip = new JSZip();
  zip.file('mimetype', mime, { compression: 'STORE' });
  zip.file('content.xml', contentXml);
  zip.file('styles.xml', stylesXml);
  zip.file('meta.xml', metaXml);
  for (const [k, v] of w.files) zip.file(k, v);
  zip.file('META-INF/manifest.xml', manifest);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', mimeType: mime });
}

export type { TextBody, LevelStyle };
