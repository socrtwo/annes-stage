/**
 * PresentationML (.pptx, .pptm, .ppsx, .potx) export. Writes a complete package from the model:
 * themes, masters with text styles, layouts, slides, notes, media, tables, charts (with literal
 * data caches), transitions, a timing tree for animations, sections, custom shows and document
 * properties. Element order follows the ECMA-376 schemas so PowerPoint and LibreOffice open it.
 */
import JSZip from 'jszip';
import type { Deck } from '../../model/deck';
import type {
  Animation, Bullet, ChartElement, Color, Effects, Element, Fill, GroupElement, Layout, LevelStyle, Line, Master, MediaElement, Paragraph, ParaProps,
  PictureElement, RunProps, ShapeElement, Slide, TableElement, TextBody, Theme, Transition,
} from '../../model/types';
import { CT, DIR_SUBTYPE, EFFECT_TO_EMPH, EFFECT_TO_ENTR, REL, relsPartOf, relTarget, toEmu } from './common';
import { esc, MIME_EXT, unb64, XML_DECL } from '../xml';

export type PptxVariant = 'pptx' | 'pptm' | 'ppsx' | 'potx';

const NSDECL = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const SCHEME_NAMES = new Set(['bg1', 'tx1', 'bg2', 'tx2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink', 'phClr', 'dk1', 'lt1', 'dk2', 'lt2']);
/** 1×1 gray PNG used as the poster of a video without one. */
const POSTER_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==';

let guidSeq = 0;
function guid(): string {
  const h = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('').toUpperCase();
  guidSeq++;
  return `{${h(8)}-${h(4)}-4${h(3)}-A${h(3)}-${h(12)}}`;
}

interface RelOut { id: string; type: string; target: string; external?: boolean }

class PartCtx {
  rels: RelOut[] = [];
  spid = 1;
  ids = new Map<string, number>();
  constructor(public part: string, public w: Writer) {}
  addRel(type: string, target: string, external = false): string {
    const t = external ? target : relTarget(this.part, target);
    const ex = this.rels.find((r) => r.type === type && r.target === t && !!r.external === external);
    if (ex) return ex.id;
    const id = `rId${this.rels.length + 1}`;
    this.rels.push({ id, type, target: t, external });
    return id;
  }
  nextId(elId?: string): number {
    const n = ++this.spid;
    if (elId) this.ids.set(elId, n);
    return n;
  }
  relsXml(): string {
    return `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${this.rels.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${esc(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`).join('')}</Relationships>`;
  }
}

class Writer {
  files = new Map<string, string | Uint8Array>();
  overrides = new Map<string, string>();
  defaults = new Map<string, string>([['rels', CT.rels], ['xml', 'application/xml']]);
  mediaParts = new Map<string, string>();
  /** PNG renderings of SVG/WebP pictures, used as the main blip (PowerPoint before 2016 cannot show either). */
  rasters = new Map<string, Uint8Array>();
  svgParts = new Map<string, string>();
  charts = 0;
  constructor(public deck: Deck) {}

  put(part: string, content: string | Uint8Array, ct?: string): void {
    this.files.set(part, content);
    if (ct) this.overrides.set(part, ct);
  }

  /** Writes a media item once; returns its part name. */
  media(id: string): string | null {
    if (this.mediaParts.has(id)) return this.mediaParts.get(id)!;
    const m = this.deck.media[id];
    if (!m) return null;
    const raster = this.rasters.get(id);
    if (raster) {
      const part = `ppt/media/media${this.mediaParts.size + 1}.png`;
      this.files.set(part, raster);
      if (!this.defaults.has('png')) this.defaults.set('png', 'image/png');
      this.mediaParts.set(id, part);
      return part;
    }
    const ext = MIME_EXT[m.mime] || (m.mime.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'bin';
    const part = `ppt/media/media${this.mediaParts.size + 1}.${ext}`;
    this.files.set(part, unb64(m.b64));
    if (!this.defaults.has(ext)) this.defaults.set(ext, m.mime === 'image/x-emf' ? 'image/x-emf' : m.mime === 'image/x-wmf' ? 'image/x-wmf' : m.mime);
    this.mediaParts.set(id, part);
    return part;
  }

  /** The original SVG of a rasterised picture, for the svgBlip extension; null otherwise. */
  svgPart(id: string): string | null {
    const m = this.deck.media[id];
    if (!m || m.mime !== 'image/svg+xml' || !this.rasters.has(id)) return null;
    if (this.svgParts.has(id)) return this.svgParts.get(id)!;
    const part = `ppt/media/image-svg${this.svgParts.size + 1}.svg`;
    this.files.set(part, unb64(m.b64));
    if (!this.defaults.has('svg')) this.defaults.set('svg', 'image/svg+xml');
    this.svgParts.set(id, part);
    return part;
  }

  posterPart(): string {
    const part = 'ppt/media/poster.png';
    if (!this.files.has(part)) { this.files.set(part, unb64(POSTER_PNG)); if (!this.defaults.has('png')) this.defaults.set('png', 'image/png'); }
    return part;
  }

  contentTypes(): string {
    const d = [...this.defaults].map(([e, c]) => `<Default Extension="${esc(e)}" ContentType="${esc(c)}"/>`).join('');
    const o = [...this.overrides].map(([p, c]) => `<Override PartName="/${esc(p)}" ContentType="${esc(c)}"/>`).join('');
    return `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${d}${o}</Types>`;
  }
}

// ------------------------------------------------------------------------------------------
// DrawingML pieces

function colorXml(c: Color | undefined, fallback = '000000'): string {
  if (c == null) return `<a:srgbClr val="${fallback}"/>`;
  const base = typeof c === 'string' ? c : c.s;
  const lum = typeof c === 'string' ? 0 : c.lum || 0;
  const alpha = typeof c === 'string' ? undefined : c.alpha;
  let mods = '';
  if (lum > 0) mods += `<a:lumMod val="${Math.round((1 - lum) * 100000)}"/><a:lumOff val="${Math.round(lum * 100000)}"/>`;
  else if (lum < 0) mods += `<a:lumMod val="${Math.round((1 + lum) * 100000)}"/>`;
  if (alpha != null && alpha < 1) mods += `<a:alpha val="${Math.round(alpha * 100000)}"/>`;
  if (base.startsWith('#')) {
    let hex = base.slice(1).toUpperCase();
    if (hex.length === 3) hex = hex.split('').map((x) => x + x).join('');
    if (!/^[0-9A-F]{6}$/.test(hex)) hex = fallback;
    return mods ? `<a:srgbClr val="${hex}">${mods}</a:srgbClr>` : `<a:srgbClr val="${hex}"/>`;
  }
  const s = SCHEME_NAMES.has(base) ? base : 'tx1';
  return mods ? `<a:schemeClr val="${s}">${mods}</a:schemeClr>` : `<a:schemeClr val="${s}"/>`;
}

function fillXml(f: Fill | undefined, ctx: PartCtx): string {
  if (!f) return '';
  switch (f.type) {
    case 'none': return '<a:noFill/>';
    case 'solid': return `<a:solidFill>${colorXml(f.color)}</a:solidFill>`;
    case 'gradient': {
      const gs = f.stops.map((s) => `<a:gs pos="${Math.round(Math.max(0, Math.min(1, s.pos)) * 100000)}">${colorXml(s.color)}</a:gs>`).join('');
      const dir = f.path === 'radial' ? '<a:path path="circle"><a:fillToRect l="50000" t="50000" r="50000" b="50000"/></a:path>' : `<a:lin ang="${Math.round((((f.angle ?? 90) % 360) + 360) % 360 * 60000)}" scaled="0"/>`;
      return `<a:gradFill rotWithShape="1"><a:gsLst>${gs}</a:gsLst>${dir}</a:gradFill>`;
    }
    case 'image': {
      const part = ctx.w.media(f.media);
      if (!part) return '<a:noFill/>';
      const rid = ctx.addRel(REL.image, part);
      return `<a:blipFill dpi="0" rotWithShape="1"><a:blip r:embed="${rid}"${f.alpha != null && f.alpha < 1 ? `><a:alphaModFix amt="${Math.round(f.alpha * 100000)}"/></a:blip>` : '/>'}<a:srcRect/>${f.mode === 'tile' ? '<a:tile tx="0" ty="0" sx="100000" sy="100000" flip="none" algn="tl"/>' : '<a:stretch><a:fillRect/></a:stretch>'}</a:blipFill>`;
    }
    case 'pattern': {
      const valid = ['pct5', 'pct10', 'pct20', 'pct25', 'pct30', 'pct40', 'pct50', 'pct60', 'pct70', 'pct75', 'pct80', 'pct90', 'horz', 'vert', 'ltHorz', 'ltVert', 'dkHorz', 'dkVert', 'narHorz', 'narVert', 'dashHorz', 'dashVert', 'cross', 'dnDiag', 'upDiag', 'ltDnDiag', 'ltUpDiag', 'dkDnDiag', 'dkUpDiag', 'wdDnDiag', 'wdUpDiag', 'dashDnDiag', 'dashUpDiag', 'diagCross', 'smCheck', 'lgCheck', 'smGrid', 'lgGrid', 'dotGrid', 'smConfetti', 'lgConfetti', 'horzBrick', 'diagBrick', 'solidDmnd', 'openDmnd', 'dotDmnd', 'plaid', 'sphere', 'weave', 'divot', 'shingle', 'wave', 'trellis', 'zigZag'];
      const prst = f.preset && valid.includes(f.preset) ? f.preset : 'pct50';
      return `<a:pattFill prst="${prst}"><a:fgClr>${colorXml(f.fg)}</a:fgClr><a:bgClr>${colorXml(f.bg, 'FFFFFF')}</a:bgClr></a:pattFill>`;
    }
  }
  return '';
}

const DASH_OUT: Record<string, string> = { dash: 'dash', dot: 'dot', dashDot: 'dashDot', longDash: 'lgDash', longDashDot: 'lgDashDot', sysDash: 'sysDash', sysDot: 'sysDot' };

function lineXml(l: Line | undefined, ctx: PartCtx, tag = 'a:ln'): string {
  if (!l) return '';
  const attrs = `${l.width != null ? ` w="${toEmu(l.width)}"` : ''}${l.cap ? ` cap="${l.cap === 'round' ? 'rnd' : l.cap === 'square' ? 'sq' : 'flat'}"` : ''}`;
  let inner = l.fill ? fillXml(l.fill, ctx) : '';
  if (l.dash && l.dash !== 'solid') inner += `<a:prstDash val="${DASH_OUT[l.dash] || 'dash'}"/>`;
  if (l.join) inner += l.join === 'round' ? '<a:round/>' : l.join === 'bevel' ? '<a:bevel/>' : '<a:miter lim="800000"/>';
  if (l.head && l.head !== 'none') inner += `<a:headEnd type="${l.head}"/>`;
  if (l.tail && l.tail !== 'none') inner += `<a:tailEnd type="${l.tail}"/>`;
  return inner || attrs ? `<${tag}${attrs}>${inner}</${tag}>` : '';
}

function effectsXml(fx: Effects | undefined): string {
  if (!fx) return '';
  let s = '';
  if (fx.glow) s += `<a:glow rad="${toEmu(fx.glow.rad)}">${colorXml(fx.glow.color)}</a:glow>`;
  if (fx.shadow) {
    const sh = fx.shadow;
    const col = typeof sh.color === 'string' ? { s: sh.color, alpha: sh.alpha ?? 0.4 } : { ...sh.color, alpha: sh.alpha ?? sh.color.alpha ?? 0.4 };
    s += `<a:outerShdw blurRad="${toEmu(sh.blur)}" dist="${toEmu(sh.dist)}" dir="${Math.round((((sh.dir % 360) + 360) % 360) * 60000)}" algn="ctr" rotWithShape="0">${colorXml(col)}</a:outerShdw>`;
  }
  if (fx.reflection) s += '<a:reflection blurRad="6350" stA="50000" endA="300" endPos="55000" dir="5400000" sy="-100000" algn="bl" rotWithShape="0"/>';
  if (fx.softEdge) s += `<a:softEdge rad="${toEmu(fx.softEdge)}"/>`;
  return s ? `<a:effectLst>${s}</a:effectLst>` : '';
}

function xfrmXml(e: { x?: number; y?: number; w?: number; h?: number; rot?: number; flipH?: boolean; flipV?: boolean }, tag = 'a:xfrm', child = ''): string {
  if (e.x == null && e.y == null && e.w == null && e.h == null) return '';
  const a = `${e.rot ? ` rot="${Math.round(e.rot * 60000)}"` : ''}${e.flipH ? ' flipH="1"' : ''}${e.flipV ? ' flipV="1"' : ''}`;
  return `<${tag}${a}><a:off x="${toEmu(e.x)}" y="${toEmu(e.y)}"/><a:ext cx="${Math.max(0, toEmu(e.w))}" cy="${Math.max(0, toEmu(e.h))}"/>${child}</${tag}>`;
}

function geomXml(geom: string | undefined, adj: Record<string, number> | undefined, path: ShapeElement['path']): string {
  if (geom === 'custom' && path?.length) {
    const paths = path.map((p) => `<a:path w="${Math.round(p.w)}" h="${Math.round(p.h)}">${svgPathToDml(p.d)}</a:path>`).join('');
    return `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst>${paths}</a:pathLst></a:custGeom>`;
  }
  const g = geom && geom !== 'custom' ? geom : 'rect';
  const av = adj ? Object.entries(adj).map(([k, v]) => `<a:gd name="${esc(k)}" fmla="val ${Math.round(v)}"/>`).join('') : '';
  return `<a:prstGeom prst="${esc(g)}"><a:avLst>${av}</a:avLst></a:prstGeom>`;
}

/** Converts an absolute SVG path (M L C Q A Z H V) to DrawingML path commands. */
function svgPathToDml(d: string): string {
  const toks = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) || [];
  let i = 0, cmd = '', x = 0, y = 0, sx = 0, sy = 0;
  const out: string[] = [];
  const n = () => parseFloat(toks[i++]);
  const pt = (px: number, py: number) => `<a:pt x="${Math.round(px)}" y="${Math.round(py)}"/>`;
  while (i < toks.length) {
    if (/[a-zA-Z]/.test(toks[i])) cmd = toks[i++];
    switch (cmd.toUpperCase()) {
      case 'M': x = n(); y = n(); sx = x; sy = y; out.push(`<a:moveTo>${pt(x, y)}</a:moveTo>`); cmd = 'L'; break;
      case 'L': x = n(); y = n(); out.push(`<a:lnTo>${pt(x, y)}</a:lnTo>`); break;
      case 'H': x = n(); out.push(`<a:lnTo>${pt(x, y)}</a:lnTo>`); break;
      case 'V': y = n(); out.push(`<a:lnTo>${pt(x, y)}</a:lnTo>`); break;
      case 'C': { const a = [n(), n(), n(), n(), n(), n()]; x = a[4]; y = a[5]; out.push(`<a:cubicBezTo>${pt(a[0], a[1])}${pt(a[2], a[3])}${pt(x, y)}</a:cubicBezTo>`); break; }
      case 'Q': { const a = [n(), n(), n(), n()]; x = a[2]; y = a[3]; out.push(`<a:quadBezTo>${pt(a[0], a[1])}${pt(x, y)}</a:quadBezTo>`); break; }
      case 'A': { n(); n(); n(); n(); n(); x = n(); y = n(); out.push(`<a:lnTo>${pt(x, y)}</a:lnTo>`); break; }
      case 'Z': out.push('<a:close/>'); x = sx; y = sy; break;
      default: i++;
    }
  }
  return out.join('');
}

// ------------------------------------------------------------------------------------------
// Text

function rPrXml(r: RunProps, ctx: PartCtx, tag = 'a:rPr', extra = ''): string {
  let a = ' lang="' + esc(r.lang || 'en-US') + '"';
  if (tag === 'a:defRPr') a = '';
  if (r.size != null) a += ` sz="${Math.round(r.size * 100)}"`;
  if (r.b != null) a += ` b="${r.b ? 1 : 0}"`;
  if (r.i != null) a += ` i="${r.i ? 1 : 0}"`;
  if (r.u != null) a += ` u="${r.u === false ? 'none' : r.u === 'dbl' ? 'dbl' : r.u === 'wavy' ? 'wavy' : 'sng'}"`;
  if (r.strike != null) a += ` strike="${r.strike === false ? 'noStrike' : r.strike === 'dbl' ? 'dblStrike' : 'sngStrike'}"`;
  if (r.caps && r.caps !== 'none') a += ` cap="${r.caps}"`;
  if (r.spc) a += ` spc="${Math.round(r.spc * 100)}"`;
  if (r.baseline) a += ` baseline="${Math.round(r.baseline * 1000)}"`;
  if (tag !== 'a:defRPr') a += ' dirty="0"';
  let c = '';
  if (r.color != null) c += `<a:solidFill>${colorXml(r.color)}</a:solidFill>`;
  if (r.highlight != null) c += `<a:highlight>${colorXml(r.highlight, 'FFFF00')}</a:highlight>`;
  if (r.font) c += `<a:latin typeface="${esc(r.font)}"/>`;
  if (r.link && tag === 'a:rPr') {
    const rid = ctx.addRel(REL.hyperlink, r.link, true);
    c += `<a:hlinkClick r:id="${rid}"/>`;
  }
  c += extra;
  return c ? `<${tag}${a}>${c}</${tag}>` : `<${tag}${a}/>`;
}

const NUM_OUT: Record<string, string> = { arabicPeriod: 'arabicPeriod', arabicParenR: 'arabicParenR', arabicPlain: 'arabicPlain', alphaLcPeriod: 'alphaLcPeriod', alphaUcPeriod: 'alphaUcPeriod', alphaLcParenR: 'alphaLcParenR', romanLcPeriod: 'romanLcPeriod', romanUcPeriod: 'romanUcPeriod' };

function bulletXml(b: Bullet | undefined): string {
  if (!b) return '';
  let s = '';
  if (b.kind !== 'none') {
    if (b.color != null) s += `<a:buClr>${colorXml(b.color)}</a:buClr>`;
    if (b.size) s += `<a:buSzPct val="${Math.round(b.size * 1000)}"/>`;
    if (b.font) s += `<a:buFont typeface="${esc(b.font)}"/>`;
  }
  if (b.kind === 'none') s += '<a:buNone/>';
  else if (b.kind === 'num') s += `<a:buAutoNum type="${NUM_OUT[b.scheme || ''] || 'arabicPeriod'}"${b.startAt != null && b.startAt !== 1 ? ` startAt="${b.startAt}"` : ''}/>`;
  else s += `<a:buChar char="${esc(b.char || '•')}"/>`;
  return s;
}

function pPrInner(p: ParaProps): { attrs: string; kids: string } {
  let a = '';
  if (p.marL != null) a += ` marL="${toEmu(p.marL)}"`;
  if (p.indent != null) a += ` indent="${toEmu(p.indent)}"`;
  if (p.align) a += ` algn="${p.align}"`;
  if (p.rtl) a += ' rtl="1"';
  let k = '';
  if (p.lineSpacing != null) k += p.lineSpacingPt ? `<a:lnSpc><a:spcPts val="${Math.round(p.lineSpacing * 100)}"/></a:lnSpc>` : `<a:lnSpc><a:spcPct val="${Math.round(p.lineSpacing * 1000)}"/></a:lnSpc>`;
  if (p.spaceBefore != null) k += `<a:spcBef><a:spcPts val="${Math.round(p.spaceBefore * 100)}"/></a:spcBef>`;
  if (p.spaceAfter != null) k += `<a:spcAft><a:spcPts val="${Math.round(p.spaceAfter * 100)}"/></a:spcAft>`;
  k += bulletXml(p.bullet);
  return { attrs: a, kids: k };
}

function levelXml(lv: LevelStyle, i: number, ctx: PartCtx): string {
  const { attrs, kids } = pPrInner(lv);
  const def = lv.run && Object.keys(lv.run).length ? rPrXml(lv.run, ctx, 'a:defRPr') : '';
  return `<a:lvl${i + 1}pPr${attrs}>${kids}${def}</a:lvl${i + 1}pPr>`;
}

function lstStyleXml(levels: LevelStyle[] | undefined, ctx: PartCtx): string {
  if (!levels?.length) return '<a:lstStyle/>';
  return `<a:lstStyle>${levels.map((lv, i) => (lv ? levelXml(lv, i, ctx) : '')).join('')}</a:lstStyle>`;
}

function paraXml(p: Paragraph, ctx: PartCtx): string {
  const { attrs, kids } = pPrInner(p);
  const lvl = p.level ? ` lvl="${Math.min(8, p.level)}"` : '';
  const pPr = attrs || kids || lvl ? `<a:pPr${lvl}${attrs}>${kids}</a:pPr>` : '';
  let runs = '';
  for (const r of p.runs) {
    const props = r as RunProps;
    if (r.br) { runs += `<a:br>${rPrXml({ ...props, link: undefined }, ctx)}</a:br>`; continue; }
    if (r.field === 'slidenum' || r.field === 'datetime' || r.field === 'date' || r.field === 'time') {
      const type = r.field === 'slidenum' ? 'slidenum' : 'datetime1';
      runs += `<a:fld id="${guid()}" type="${type}">${rPrXml(props, ctx)}<a:t>${esc(r.text || (r.field === 'slidenum' ? '‹#›' : ''))}</a:t></a:fld>`;
      continue;
    }
    runs += `<a:r>${rPrXml(props, ctx)}<a:t>${esc(r.text)}</a:t></a:r>`;
  }
  const end = p.end ? rPrXml(p.end, ctx, 'a:endParaRPr') : '';
  return `<a:p>${pPr}${runs}${end}</a:p>`;
}

function bodyPrXml(t: TextBody | undefined): string {
  if (!t) return '<a:bodyPr/>';
  let a = '';
  if (t.wrap === false) a += ' wrap="none"';
  if (t.insets) { const [l, tp, r, b] = t.insets; a += ` lIns="${toEmu(l)}" tIns="${toEmu(tp)}" rIns="${toEmu(r)}" bIns="${toEmu(b)}"`; }
  if (t.columns && t.columns > 1) a += ` numCol="${t.columns}"`;
  if (t.anchor) a += ` anchor="${t.anchor}"`;
  if (t.vert && t.vert !== 'horz') a += ` vert="${t.vert === 'stacked' ? 'wordArtVert' : t.vert}"`;
  let k = '';
  if (t.autofit === 'shrink') k = `<a:normAutofit${t.fontScale && t.fontScale < 1 ? ` fontScale="${Math.round(t.fontScale * 100000)}"` : ''}${t.lineReduction ? ` lnSpcReduction="${Math.round(t.lineReduction * 1000)}"` : ''}/>`;
  else if (t.autofit === 'resize') k = '<a:spAutoFit/>';
  else if (t.autofit === 'none') k = '<a:noAutofit/>';
  return `<a:bodyPr${a}>${k}</a:bodyPr>`;
}

function txBodyXml(t: TextBody | undefined, ctx: PartCtx, tag = 'p:txBody'): string {
  const paras = t?.paras?.length ? t.paras : [{ level: 0, runs: [] }];
  return `<${tag}>${bodyPrXml(t)}${lstStyleXml(t?.levels, ctx)}${paras.map((p) => paraXml(p, ctx)).join('')}</${tag}>`;
}

// ------------------------------------------------------------------------------------------
// Elements

function linkXml(e: Element, ctx: PartCtx): string {
  const l = e.link;
  if (!l) return '';
  if (l.url) return `<a:hlinkClick r:id="${ctx.addRel(REL.hyperlink, l.url, true)}"/>`;
  const jump: Record<string, string> = { next: 'nextslide', prev: 'previousslide', first: 'firstslide', last: 'lastslide', end: 'endshow' };
  if (l.action && jump[l.action]) return `<a:hlinkClick r:id="" action="ppaction://hlinkshowjump?jump=${jump[l.action]}"/>`;
  return '';
}

function cNvPr(e: Element, ctx: PartCtx, fallbackName: string): string {
  const id = ctx.nextId(e.id);
  const a = ` id="${id}" name="${esc(e.name || `${fallbackName} ${id}`)}"${e.alt ? ` descr="${esc(e.alt)}"` : ''}${e.title ? ` title="${esc(e.title)}"` : ''}${e.hidden ? ' hidden="1"' : ''}`;
  const link = linkXml(e, ctx);
  return link ? `<p:cNvPr${a}>${link}</p:cNvPr>` : `<p:cNvPr${a}/>`;
}

function phXml(e: Element): string {
  if (!e.ph) return '<p:nvPr/>';
  const t = e.ph.type === 'obj' ? '' : ` type="${e.ph.type}"`;
  const idx = e.ph.idx != null && e.ph.idx !== 0 ? ` idx="${e.ph.idx}"` : '';
  return `<p:nvPr><p:ph${t}${idx}/></p:nvPr>`;
}

function elementXml(e: Element, ctx: PartCtx): string {
  switch (e.kind) {
    case 'shape': return shapeXml(e, ctx);
    case 'picture': return pictureXml(e, ctx);
    case 'media': return mediaXml(e, ctx);
    case 'table': return tableXml(e, ctx);
    case 'chart': return chartFrameXml(e, ctx);
    case 'group': return groupXml(e, ctx);
  }
  return '';
}

function shapeXml(e: ShapeElement, ctx: PartCtx): string {
  const nv = `<p:nvSpPr>${cNvPr(e, ctx, e.ph ? 'Placeholder' : e.textbox ? 'TextBox' : 'Shape')}<p:cNvSpPr${e.textbox ? ' txBox="1"' : ''}${e.ph ? '><a:spLocks noGrp="1"/></p:cNvSpPr>' : '/>'}${phXml(e)}</p:nvSpPr>`;
  const hasGeomBox = e.x != null || e.w != null;
  const geom = e.ph && !hasGeomBox && (!e.geom || e.geom === 'rect') ? '' : geomXml(e.geom, e.adj, e.path);
  const spPr = `<p:spPr>${xfrmXml(e)}${geom}${fillXml(e.fill, ctx)}${lineXml(e.line, ctx)}${effectsXml(e.effects)}</p:spPr>`;
  const hasText = !!e.text && (e.text.paras.some((p) => p.runs.length) || !!e.ph || !!e.text.levels || e.text.anchor != null);
  const tx = hasText || e.ph ? txBodyXml(e.text, ctx) : '';
  return `<p:sp>${nv}${spPr}${tx}</p:sp>`;
}

function pictureXml(e: PictureElement, ctx: PartCtx): string {
  const part = e.media ? ctx.w.media(e.media) : null;
  if (!part) {
    // Missing image: keep a framed placeholder so the layout survives.
    return shapeXml({ id: e.id, kind: 'shape', geom: 'rect', name: e.name, x: e.x, y: e.y, w: e.w, h: e.h, alt: e.alt, fill: { type: 'solid', color: '#DDDDDD' }, line: { fill: { type: 'solid', color: '#999999' } } }, ctx);
  }
  const rid = ctx.addRel(REL.image, part);
  const c = e.crop;
  const src = c && c.some((v) => v) ? `<a:srcRect l="${Math.round(c[0] * 100000)}" t="${Math.round(c[1] * 100000)}" r="${Math.round(c[2] * 100000)}" b="${Math.round(c[3] * 100000)}"/>` : '';
  const adj = e.adjust;
  const blipKids = adj?.grayscale ? '<a:grayscl/>' : adj?.transparency ? `<a:alphaModFix amt="${Math.round((1 - adj.transparency) * 100000)}"/>` : '';
  const svg = e.media ? ctx.w.svgPart(e.media) : null;
  const svgExt = svg ? `<a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="${ctx.addRel(REL.image, svg)}"/></a:ext></a:extLst>` : '';
  const blip = blipKids || svgExt ? `<a:blip r:embed="${rid}">${blipKids}${svgExt}</a:blip>` : `<a:blip r:embed="${rid}"/>`;
  return `<p:pic><p:nvPicPr>${cNvPr(e, ctx, 'Picture')}<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr>${phXml(e)}</p:nvPicPr><p:blipFill>${blip}${src}<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrmXml(e)}${geomXml(e.geom || 'rect', undefined, undefined)}${lineXml(e.line, ctx)}${effectsXml(e.effects)}</p:spPr></p:pic>`;
}

function mediaXml(e: MediaElement, ctx: PartCtx): string {
  const part = ctx.w.media(e.media);
  const poster = (e.poster && ctx.w.media(e.poster)) || ctx.w.posterPart();
  const prid = ctx.addRel(REL.image, poster);
  let nvPr = '<p:nvPr/>';
  if (part) {
    const link = ctx.addRel(e.mediaKind === 'audio' ? REL.audio : REL.video, part);
    const emb = ctx.addRel(REL.media, part);
    nvPr = `<p:nvPr><a:${e.mediaKind === 'audio' ? 'audioFile' : 'videoFile'} r:link="${link}"/><p:extLst><p:ext uri="{DAA4B4D4-6D71-4841-9C94-3DE7FCFB9230}"><p14:media xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" r:embed="${emb}"/></p:ext></p:extLst></p:nvPr>`;
  }
  return `<p:pic><p:nvPicPr>${cNvPr(e, ctx, e.mediaKind === 'audio' ? 'Audio' : 'Video')}<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr>${nvPr}</p:nvPicPr><p:blipFill><a:blip r:embed="${prid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrmXml(e)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
}

function groupXml(g: GroupElement, ctx: PartCtx): string {
  // Children are stored in slide coordinates: child offset/extent = the group's own box.
  const box = groupBox(g);
  const off = `<a:off x="${toEmu(box.x)}" y="${toEmu(box.y)}"/><a:ext cx="${toEmu(box.w)}" cy="${toEmu(box.h)}"/>`;
  const x = `<a:xfrm${g.rot ? ` rot="${Math.round(g.rot * 60000)}"` : ''}${g.flipH ? ' flipH="1"' : ''}${g.flipV ? ' flipV="1"' : ''}>${off}<a:chOff x="${toEmu(box.x)}" y="${toEmu(box.y)}"/><a:chExt cx="${toEmu(box.w)}" cy="${toEmu(box.h)}"/></a:xfrm>`;
  const nv = `<p:nvGrpSpPr>${cNvPr(g, ctx, 'Group')}<p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>`;
  return `<p:grpSp>${nv}<p:grpSpPr>${x}</p:grpSpPr>${g.children.map((c) => elementXml(c, ctx)).join('')}</p:grpSp>`;
}

function groupBox(g: GroupElement): { x: number; y: number; w: number; h: number } {
  if (g.x != null && g.y != null && g.w != null && g.h != null) return { x: g.x, y: g.y, w: g.w, h: g.h };
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const c of g.children) {
    const b = c.kind === 'group' ? groupBox(c) : { x: c.x ?? 0, y: c.y ?? 0, w: c.w ?? 0, h: c.h ?? 0 };
    x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y); x2 = Math.max(x2, b.x + b.w); y2 = Math.max(y2, b.y + b.h);
  }
  if (!Number.isFinite(x1)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

function tableXml(t: TableElement, ctx: PartCtx): string {
  const nv = `<p:nvGraphicFramePr>${cNvPr(t, ctx, 'Table')}<p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>`;
  const st = t.style || {};
  const flags = ['firstRow', 'lastRow', 'firstCol', 'lastCol', 'bandRow', 'bandCol'].filter((k) => (st as any)[k]).map((k) => ` ${k}="1"`).join('');
  const styleId = t.keep?.tableStyleId || (flags ? '{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}' : '');
  const tblPr = `<a:tblPr${flags}>${styleId ? `<a:tableStyleId>${esc(styleId)}</a:tableStyleId>` : ''}</a:tblPr>`;
  const grid = `<a:tblGrid>${t.cols.map((w) => `<a:gridCol w="${toEmu(w)}"/>`).join('')}</a:tblGrid>`;
  // Which covered cells are horizontal (hMerge) or vertical (vMerge) continuations.
  const nCols = t.cols.length;
  const cover: ('h' | 'v' | '')[][] = t.rows.map(() => new Array(nCols).fill(''));
  t.rows.forEach((row, ri) => row.cells.forEach((cell, ci) => {
    if (cell.merged) return;
    for (let r = ri; r < Math.min(t.rows.length, ri + (cell.rowSpan || 1)); r++) {
      for (let c = ci; c < Math.min(nCols, ci + (cell.colSpan || 1)); c++) {
        if (r === ri && c === ci) continue;
        cover[r][c] = r === ri ? 'h' : 'v';
      }
    }
  }));
  const rows = t.rows.map((row, ri) => {
    const cells: string[] = [];
    for (let ci = 0; ci < nCols; ci++) {
      const cell = row.cells[ci] || { text: { paras: [{ level: 0, runs: [] }] } };
      let a = '';
      if (!cell.merged) { if ((cell.colSpan || 1) > 1) a += ` gridSpan="${cell.colSpan}"`; if ((cell.rowSpan || 1) > 1) a += ` rowSpan="${cell.rowSpan}"`; }
      else if (cover[ri][ci] === 'v') a += ' vMerge="1"';
      else a += ' hMerge="1"';
      const tb = cell.text || { paras: [{ level: 0, runs: [] }] };
      const ins = tb.insets;
      let tcA = ins ? ` marL="${toEmu(ins[0])}" marR="${toEmu(ins[2])}" marT="${toEmu(ins[1])}" marB="${toEmu(ins[3])}"` : '';
      if (cell.anchor) tcA += ` anchor="${cell.anchor}"`;
      const b = cell.borders || [];
      const tcK = `${lineXml(b[0], ctx, 'a:lnL')}${lineXml(b[2], ctx, 'a:lnR')}${lineXml(b[1], ctx, 'a:lnT')}${lineXml(b[3], ctx, 'a:lnB')}${fillXml(cell.fill, ctx)}`;
      const body = txBodyXml({ ...tb, insets: undefined }, ctx, 'a:txBody');
      cells.push(`<a:tc${a}>${body}<a:tcPr${tcA}>${tcK}</a:tcPr></a:tc>`);
    }
    return `<a:tr h="${toEmu(row.h)}">${cells.join('')}</a:tr>`;
  }).join('');
  return `<p:graphicFrame>${nv}${xfrmXml(t, 'p:xfrm') || '<p:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></p:xfrm>'}<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>${tblPr}${grid}${rows}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}

function chartFrameXml(e: ChartElement, ctx: PartCtx): string {
  const n = ++ctx.w.charts;
  const part = `ppt/charts/chart${n}.xml`;
  ctx.w.put(part, chartXml(e.chart), CT.chart);
  const rid = ctx.addRel(REL.chart, part);
  const nv = `<p:nvGraphicFramePr>${cNvPr(e, ctx, 'Chart')}<p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>`;
  return `<p:graphicFrame>${nv}${xfrmXml(e, 'p:xfrm') || '<p:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></p:xfrm>'}<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="${rid}"/></a:graphicData></a:graphic></p:graphicFrame>`;
}

/** A chart part with literal data (no embedded workbook). */
export function chartXml(c: ChartElement['chart']): string {
  const strLit = (vals: string[]) => `<c:strLit><c:ptCount val="${vals.length}"/>${vals.map((v, i) => `<c:pt idx="${i}"><c:v>${esc(v)}</c:v></c:pt>`).join('')}</c:strLit>`;
  const numLit = (vals: (number | null)[]) => `<c:numLit><c:formatCode>General</c:formatCode><c:ptCount val="${vals.length}"/>${vals.map((v, i) => (v == null ? '' : `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`)).join('')}</c:numLit>`;
  const spPr = (col: Color | undefined, line: boolean) => (col ? `<c:spPr>${line ? `<a:ln w="28575" cap="rnd"><a:solidFill>${colorXml(col)}</a:solidFill><a:round/></a:ln>` : `<a:solidFill>${colorXml(col)}</a:solidFill>`}</c:spPr>` : '');
  const dLbls = c.labels ? `<c:dLbls><c:showLegendKey val="0"/><c:showVal val="${c.type === 'pie' || c.type === 'doughnut' ? 0 : 1}"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="${c.type === 'pie' || c.type === 'doughnut' ? 1 : 0}"/><c:showBubbleSize val="0"/></c:dLbls>` : '';
  const isLine = c.type === 'line' || c.type === 'radar';
  const sers = c.series.map((s, i) => {
    const head = `<c:idx val="${i}"/><c:order val="${i}"/><c:tx><c:v>${esc(s.name)}</c:v></c:tx>${spPr(s.color, isLine || c.type === 'scatter')}`;
    if (c.type === 'scatter') return `<c:ser>${head}<c:marker><c:symbol val="circle"/><c:size val="5"/></c:marker>${dLbls}<c:xVal>${numLit(c.categories.map((x, k) => (isNaN(+x) ? k + 1 : +x)))}</c:xVal><c:yVal>${numLit(s.values)}</c:yVal><c:smooth val="0"/></c:ser>`;
    const cat = `<c:cat>${strLit(c.categories)}</c:cat><c:val>${numLit(s.values)}</c:val>`;
    if (c.type === 'line') return `<c:ser>${head}<c:marker><c:symbol val="circle"/><c:size val="5"/></c:marker>${dLbls}${cat}<c:smooth val="0"/></c:ser>`;
    if (c.type === 'radar') return `<c:ser>${head}<c:marker><c:symbol val="none"/></c:marker>${dLbls}${cat}</c:ser>`;
    if (c.type === 'pie' || c.type === 'doughnut') return `<c:ser>${head}${dLbls}${cat}</c:ser>`;
    if (c.type === 'area') return `<c:ser>${head}${dLbls}${cat}</c:ser>`;
    return `<c:ser>${head}<c:invertIfNegative val="0"/>${dLbls}${cat}</c:ser>`;
  }).join('');
  const grouping = c.stacked === 'percent' ? 'percentStacked' : c.stacked ? 'stacked' : c.type === 'line' || c.type === 'area' ? 'standard' : 'clustered';
  const ax = '<c:axId val="111111111"/><c:axId val="222222222"/>';
  const catAx = '<c:catAx><c:axId val="111111111"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="222222222"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>';
  const valAx = (id: string, cross: string, pos: string) => `<c:valAx><c:axId val="${id}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${pos}"/><c:majorGridlines/><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="${cross}"/><c:crosses val="autoZero"/><c:crossBetween val="${c.type === 'scatter' ? 'midCat' : 'between'}"/></c:valAx>`;
  let plot = '';
  switch (c.type) {
    case 'bar': case 'column':
      plot = `<c:barChart><c:barDir val="${c.type === 'bar' ? 'bar' : 'col'}"/><c:grouping val="${grouping}"/><c:varyColors val="0"/>${sers}<c:gapWidth val="150"/>${c.stacked ? '<c:overlap val="100"/>' : ''}${ax}</c:barChart>${catAx.replace('<c:axPos val="b"/>', `<c:axPos val="${c.type === 'bar' ? 'l' : 'b'}"/>`)}${valAx('222222222', '111111111', c.type === 'bar' ? 'b' : 'l')}`;
      break;
    case 'line':
      plot = `<c:lineChart><c:grouping val="${grouping}"/><c:varyColors val="0"/>${sers}<c:marker val="1"/>${ax}</c:lineChart>${catAx}${valAx('222222222', '111111111', 'l')}`;
      break;
    case 'area':
      plot = `<c:areaChart><c:grouping val="${grouping}"/><c:varyColors val="0"/>${sers}${ax}</c:areaChart>${catAx}${valAx('222222222', '111111111', 'l')}`;
      break;
    case 'pie':
      plot = `<c:pieChart><c:varyColors val="1"/>${sers}<c:firstSliceAng val="0"/></c:pieChart>`;
      break;
    case 'doughnut':
      plot = `<c:doughnutChart><c:varyColors val="1"/>${sers}<c:firstSliceAng val="0"/><c:holeSize val="50"/></c:doughnutChart>`;
      break;
    case 'scatter':
      plot = `<c:scatterChart><c:scatterStyle val="lineMarker"/><c:varyColors val="0"/>${sers}${ax}</c:scatterChart>${valAx('111111111', '222222222', 'b').replace('<c:majorGridlines/>', '')}${valAx('222222222', '111111111', 'l')}`;
      break;
    case 'radar':
      plot = `<c:radarChart><c:radarStyle val="marker"/><c:varyColors val="0"/>${sers}${ax}</c:radarChart>${catAx}${valAx('222222222', '111111111', 'l')}`;
      break;
  }
  const title = c.title ? `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${esc(c.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>` : '<c:autoTitleDeleted val="1"/>';
  const legend = c.legend === 'none' ? '' : `<c:legend><c:legendPos val="${c.legend || 'r'}"/><c:overlay val="0"/></c:legend>`;
  return `${XML_DECL}<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:roundedCorners val="0"/><c:chart>${title}<c:plotArea><c:layout/>${plot}</c:plotArea>${legend}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`;
}

function spTreeXml(elements: Element[], ctx: PartCtx): string {
  return `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${elements.map((e) => elementXml(e, ctx)).join('')}</p:spTree>`;
}

function bgXml(f: Fill | undefined, ctx: PartCtx): string {
  if (!f) return '';
  return `<p:bg><p:bgPr>${fillXml(f, ctx) || '<a:noFill/>'}<a:effectLst/></p:bgPr></p:bg>`;
}

// ------------------------------------------------------------------------------------------
// Motion

const TRANS_OUT: Record<string, (t: Transition) => string> = {
  fade: (t) => `<p:fade${t.thruBlk ? ' thruBlk="1"' : ''}/>`,
  push: (t) => `<p:push dir="${dir4(t.dir, 'u')}"/>`,
  wipe: (t) => `<p:wipe dir="${dir4(t.dir, 'r')}"/>`,
  split: (t) => {
    const io = t.inOut || (t.dir === 'in' ? 'in' : 'out');
    return `<p:split orient="${t.dir === 'vert' ? 'vert' : 'horz'}" dir="${io}"/>`;
  },
  reveal: (t) => `<p:pull dir="${dir8(t.dir, 'l')}"/>`,
  cover: (t) => `<p:cover dir="${dir8(t.dir, 'l')}"/>`,
  uncover: (t) => `<p:pull dir="${dir8(t.dir, 'l')}"/>`,
  pull: (t) => `<p:pull dir="${dir8(t.dir, 'l')}"/>`,
  zoom: (t) => `<p:zoom${t.dir === 'out' ? ' dir="out"' : ''}/>`,
  randomBars: (t) => `<p:randomBar dir="${t.dir === 'vert' ? 'vert' : 'horz'}"/>`,
  cut: (t) => `<p:cut${t.thruBlk ? ' thruBlk="1"' : ''}/>`,
  dissolve: () => '<p:dissolve/>',
  circle: () => '<p:circle/>', shape: () => '<p:circle/>', diamond: () => '<p:diamond/>', plus: () => '<p:plus/>', wedge: () => '<p:wedge/>',
  clock: () => '<p:wheel spokes="1"/>',
  blinds: (t) => `<p:blinds dir="${t.dir === 'vert' ? 'vert' : 'horz'}"/>`,
  checker: (t) => `<p:checker dir="${t.dir === 'vert' ? 'vert' : 'horz'}"/>`,
  comb: (t) => `<p:comb dir="${t.dir === 'vert' ? 'vert' : 'horz'}"/>`,
};
const dir4 = (d: string | undefined, def: string) => (d === 'l' || d === 'r' || d === 'u' || d === 'd' ? d : def);
const dir8 = (d: string | undefined, def: string) => (['l', 'r', 'u', 'd', 'lu', 'ru', 'ld', 'rd'].includes(d || '') ? d! : def);

function transitionXml(t: Transition | undefined): string {
  if (!t) return '';
  const dur = t.dur ?? 700;
  const spd = dur >= 1000 ? 'slow' : dur >= 600 ? 'med' : 'fast';
  const a = ` spd="${spd}"${t.advClick === false ? ' advClick="0"' : ''}${t.advAfter != null ? ` advTm="${Math.round(t.advAfter)}"` : ''}`;
  if (t.type === 'none') return `<p:transition${a}/>`;
  if (t.type === 'morph') {
    return `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice xmlns:p159="http://schemas.microsoft.com/office/powerpoint/2015/09/main" Requires="p159"><p:transition${a}><p159:morph option="byObject"/></p:transition></mc:Choice><mc:Fallback><p:transition${a}><p:fade/></p:transition></mc:Fallback></mc:AlternateContent>`;
  }
  if (t.type === 'reveal') {
    // Reveal is a PowerPoint 2010 transition: p14:reveal, with a pull for older readers.
    const d = t.dir === 'r' ? 'r' : 'l';
    return `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" Requires="p14"><p:transition${a}><p14:reveal${t.thruBlk ? ' thruBlk="1"' : ''} dir="${d}"/></p:transition></mc:Choice><mc:Fallback><p:transition${a}><p:pull dir="${d}"/></p:transition></mc:Fallback></mc:AlternateContent>`;
  }
  const fn = TRANS_OUT[t.type] || TRANS_OUT.fade;
  return `<p:transition${a}>${fn(t)}</p:transition>`;
}

const FILTERS: Record<string, string> = { wipe: 'wipe(down)', split: 'barn(inVertical)', randomBars: 'randombar(horizontal)', wheel: 'wheel(1)', shape: 'circle(in)', peek: 'slide(fromBottom)' };

function timingXml(slide: Slide, ctx: PartCtx): string {
  // Expand by-paragraph builds into one effect per paragraph.
  type Eff = { a: Animation; spid: number; para?: number; trigger: Animation['trigger'] };
  const effs: Eff[] = [];
  for (const a of slide.anims) {
    const spid = ctx.ids.get(a.target);
    if (!spid) continue;
    const el = slide.elements.find((e) => e.id === a.target);
    const paras = a.byPara && el?.kind === 'shape' ? (el.text?.paras.length || 0) : 0;
    if (paras > 1) for (let i = 0; i < paras; i++) effs.push({ a, spid, para: i, trigger: i === 0 ? a.trigger : 'click' });
    else effs.push({ a, spid, trigger: a.trigger });
  }
  if (!effs.length) return '';
  let id = 2;
  const tgt = (e: Eff) => `<p:tgtEl><p:spTgt spid="${e.spid}">${e.para != null ? `<p:txEl><p:pRg st="${e.para}" end="${e.para}"/></p:txEl>` : ''}</p:spTgt></p:tgtEl>`;
  const cBhvr = (e: Eff, dur: number | string, attrs: string[], extraCtn = '', additive = '') => `<p:cBhvr${additive}><p:cTn id="${++id}" dur="${dur}" fill="hold"${extraCtn}/>${tgt(e)}${attrs.length ? `<p:attrNameLst>${attrs.map((x) => `<p:attrName>${x}</p:attrName>`).join('')}</p:attrNameLst>` : ''}</p:cBhvr>`;
  const setVis = (e: Eff, val: string, delay = 0) => `<p:set><p:cBhvr><p:cTn id="${++id}" dur="1" fill="hold"><p:stCondLst><p:cond delay="${delay}"/></p:stCondLst></p:cTn>${tgt(e)}<p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="${val}"/></p:to></p:set>`;
  const behaviors = (e: Eff): { xml: string; preset: number; cls: string; sub: number } => {
    const a = e.a;
    const dur = Math.max(1, Math.round(a.dur ?? 500));
    if (a.cls === 'entr' || a.cls === 'exit') {
      const preset = EFFECT_TO_ENTR[a.effect] ?? 10;
      const sub = a.effect === 'fly' || a.effect === 'peek' || a.effect === 'wipe' ? DIR_SUBTYPE[a.dir || 'd'] ?? 4 : 0;
      const tin = a.cls === 'entr' ? 'in' : 'out';
      if (a.effect === 'appear') return { xml: setVis(e, a.cls === 'entr' ? 'visible' : 'hidden'), preset: 1, cls: a.cls, sub: 0 };
      if (a.effect === 'fly') {
        const side = a.dir || 'd';
        const prop = side === 'l' || side === 'r' ? 'ppt_x' : 'ppt_y';
        const off = side === 'l' ? '0-#ppt_w/2' : side === 'r' ? '1+#ppt_w/2' : side === 'u' ? '0-#ppt_h/2' : '1+#ppt_h/2';
        const [from, to] = a.cls === 'entr' ? [off, `#${prop}`] : [`#${prop}`, off];
        const anim = `<p:anim calcmode="lin" valueType="num">${cBhvr(e, dur, [prop], '', ' additive="base"')}<p:tavLst><p:tav tm="0"><p:val><p:strVal val="${from}"/></p:val></p:tav><p:tav tm="100000"><p:val><p:strVal val="${to}"/></p:val></p:tav></p:tavLst></p:anim>`;
        return { xml: a.cls === 'entr' ? setVis(e, 'visible') + anim : anim + setVis(e, 'hidden', dur - 1), preset, cls: a.cls, sub };
      }
      const filt = FILTERS[a.effect] || 'fade';
      const eff = `<p:animEffect transition="${tin}" filter="${filt}">${cBhvr(e, dur, [])}</p:animEffect>`;
      return { xml: a.cls === 'entr' ? setVis(e, 'visible') + eff : eff + setVis(e, 'hidden', dur - 1), preset, cls: a.cls, sub };
    }
    if (a.cls === 'emph') {
      const preset = EFFECT_TO_EMPH[a.effect] ?? 26;
      if (a.effect === 'spin') return { xml: `<p:animRot by="${Math.round((a.amount ?? 360) * 60000)}">${cBhvr(e, dur, ['r'])}</p:animRot>`, preset, cls: 'emph', sub: 0 };
      if (a.effect === 'transparency') return { xml: `<p:set>${cBhvr(e, dur, ['style.opacity'])}<p:to><p:strVal val="0.5"/></p:to></p:set>`, preset, cls: 'emph', sub: 0 };
      const pct = a.effect === 'growShrink' ? Math.round((a.amount ?? 150) * 1000) : 110000;
      return { xml: `<p:animScale>${cBhvr(e, dur, [], a.effect === 'growShrink' ? '' : ' autoRev="1"')}<p:by x="${pct}" y="${pct}"/></p:animScale>`, preset, cls: 'emph', sub: 0 };
    }
    const path = (a.path || 'M 0 0 L 0.25 0').replace(/\s+E\s*$/, '') + ' E';
    return { xml: `<p:animMotion origin="layout" path="${esc(path)}" pathEditMode="relative">${cBhvr(e, dur, ['ppt_x', 'ppt_y'])}</p:animMotion>`, preset: 0, cls: 'path', sub: 0 };
  };
  // Group: click groups → after-chains → effects.
  const groups: Eff[][][] = [];
  for (const e of effs) {
    if (e.trigger === 'click' || !groups.length) groups.push([[e]]);
    else if (e.trigger === 'after') groups[groups.length - 1].push([e]);
    else { const g = groups[groups.length - 1]; g[g.length - 1].push(e); }
  }
  const clickPars = groups.map((g, gi) => {
    let t = 0;
    const subs = g.map((chain) => {
      const start = t;
      let longest = 0;
      const items = chain.map((e) => {
        const b = behaviors(e);
        const d = (e.a.delay || 0) + (e.a.dur ?? 500);
        if (d > longest) longest = d;
        const node = e.trigger === 'with' ? 'withEffect' : e.trigger === 'after' ? 'afterEffect' : 'clickEffect';
        return `<p:par><p:cTn id="${++id}" presetID="${b.preset}" presetClass="${b.cls}" presetSubtype="${b.sub}" fill="hold"${e.para != null || ctx.ids.has(e.a.target) ? ' grpId="0"' : ''} nodeType="${node}"><p:stCondLst><p:cond delay="${Math.round(e.a.delay || 0)}"/></p:stCondLst><p:childTnLst>${b.xml}</p:childTnLst></p:cTn></p:par>`;
      });
      t += longest;
      return `<p:par><p:cTn id="${++id}" fill="hold"><p:stCondLst><p:cond delay="${Math.round(start)}"/></p:stCondLst><p:childTnLst>${items.join('')}</p:childTnLst></p:cTn></p:par>`;
    });
    const first = g[0][0];
    const cond = gi === 0 && first.trigger !== 'click' ? '<p:cond delay="indefinite"/><p:cond evt="onBegin" delay="0"><p:tn val="2"/></p:cond>' : '<p:cond delay="indefinite"/>';
    return `<p:par><p:cTn id="${++id}" fill="hold"><p:stCondLst>${cond}</p:stCondLst><p:childTnLst>${subs.join('')}</p:childTnLst></p:cTn></p:par>`;
  });
  const bld = [...new Set(effs.map((e) => e.spid))].filter((spid) => {
    const el = [...ctx.ids].find(([, v]) => v === spid)?.[0];
    return slide.elements.some((x) => x.id === el && x.kind === 'shape');
  }).map((spid) => {
    const byPara = effs.some((e) => e.spid === spid && e.para != null);
    return `<p:bldP spid="${spid}" grpId="0"${byPara ? ' build="p"' : ''} animBg="1"/>`;
  }).join('');
  return `<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst><p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>${clickPars.join('')}</p:childTnLst></p:cTn><p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst><p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq></p:childTnLst></p:cTn></p:par></p:tnLst>${bld ? `<p:bldLst>${bld}</p:bldLst>` : ''}</p:timing>`;
}

// ------------------------------------------------------------------------------------------
// Theme, master, layouts

function themeXml(t: Theme, name = t.name): string {
  const clr = (['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'] as const)
    .map((k) => `<a:${k}><a:srgbClr val="${(t.colors[k] || '#000000').replace('#', '').toUpperCase()}"/></a:${k}>`).join('');
  const font = (f: string) => `<a:latin typeface="${esc(f)}"/><a:ea typeface=""/><a:cs typeface=""/>`;
  const fmt = t.keep?.fmtScheme && /^<a:fmtScheme/.test(t.keep.fmtScheme) && !/:(embed|link|id)="/.test(t.keep.fmtScheme) ? t.keep.fmtScheme : DEFAULT_FMT;
  return `${XML_DECL}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="${esc(name)}"><a:themeElements><a:clrScheme name="${esc(name)}">${clr}</a:clrScheme><a:fontScheme name="${esc(name)}"><a:majorFont>${font(t.fonts.major)}</a:majorFont><a:minorFont>${font(t.fonts.minor)}</a:minorFont></a:fontScheme>${fmt}</a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;
}

const DEFAULT_FMT = '<a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:lumMod val="110000"/><a:satMod val="105000"/><a:tint val="67000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:lumMod val="105000"/><a:satMod val="109000"/><a:tint val="81000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:satMod val="103000"/><a:lumMod val="102000"/><a:tint val="94000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:lumMod val="99000"/><a:satMod val="120000"/><a:shade val="78000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln><a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln><a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst><a:outerShdw blurRad="57150" dist="19050" dir="5400000" algn="ctr" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="63000"/></a:srgbClr></a:outerShdw></a:effectLst></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/><a:satMod val="170000"/></a:schemeClr></a:solidFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="93000"/><a:satMod val="150000"/><a:shade val="98000"/><a:lumMod val="102000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="63000"/><a:satMod val="120000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill></a:bgFillStyleLst></a:fmtScheme>';

function stylesXml(levels: LevelStyle[], ctx: PartCtx, tag: string): string {
  const lv = levels.slice(0, 9).map((l, i) => (l ? levelXml(l, i, ctx) : '')).join('');
  return `<p:${tag}>${lv}</p:${tag}>`;
}

function clrMapAttrs(m: Master): string {
  const cm = { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2', ...(m.clrMap || {}) };
  return `bg1="${cm.bg1}" tx1="${cm.tx1}" bg2="${cm.bg2}" tx2="${cm.tx2}" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"`;
}

const LAYOUT_TYPES = new Set(['title', 'tx', 'twoColTx', 'tbl', 'txAndChart', 'chartAndTx', 'dgm', 'chart', 'txAndClipArt', 'clipArtAndTx', 'titleOnly', 'blank', 'txAndObj', 'objAndTx', 'objOnly', 'obj', 'txAndMedia', 'mediaAndTx', 'objOverTx', 'txOverObj', 'txAndTwoObj', 'twoObjAndTx', 'twoObjOverTx', 'fourObj', 'vertTx', 'clipArtAndVertTx', 'vertTitleAndTx', 'vertTitleAndTxOverChart', 'twoObj', 'objAndTwoObj', 'twoObjAndObj', 'cust', 'secHead', 'twoTxTwoObj', 'objTx', 'picTx']);

// ------------------------------------------------------------------------------------------

/**
 * SVG and WebP pictures are not shown by every PowerPoint version: when a browser canvas is at
 * hand, picture media of those types get a PNG rendering (SVG keeps its original through the
 * svgBlip extension). Without a canvas (tests, workers) the media is written as it is.
 */
async function rasterizePictures(w: Writer): Promise<void> {
  if (typeof document === 'undefined' || typeof Image === 'undefined') return;
  const ids = new Set<string>();
  const any = Object.values(w.deck.media).some((m) => m.mime === 'image/svg+xml' || m.mime === 'image/webp');
  if (!any) return;
  try { if (!document.createElement('canvas').getContext('2d')) return; } catch { return; }
  const visit = (els: Element[]) => { for (const e of els) { if (e.kind === 'picture' && e.media) ids.add(e.media); if (e.kind === 'group') visit(e.children); } };
  for (const o of [...w.deck.data.masters, ...w.deck.data.layouts, ...w.deck.data.slides]) visit(o.elements);
  for (const id of ids) {
    const m = w.deck.media[id];
    if (!m || (m.mime !== 'image/svg+xml' && m.mime !== 'image/webp')) continue;
    try {
      const png = await toPng(`data:${m.mime};base64,${m.b64}`);
      if (png) w.rasters.set(id, png);
    } catch { /* keep the original */ }
  }
}

async function toPng(url: string): Promise<Uint8Array | null> {
  const img = new Image();
  const ok = await new Promise<boolean>((res) => { img.onload = () => res(true); img.onerror = () => res(false); img.src = url; setTimeout(() => res(false), 5000); });
  if (!ok) return null;
  const nw = img.naturalWidth || 1024, nh = img.naturalHeight || 768;
  const k = Math.min(1, 4096 / Math.max(nw, nh));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(nw * k)); canvas.height = Math.max(1, Math.round(nh * k));
  const g = canvas.getContext('2d');
  if (!g) return null;
  g.drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((res) => { try { canvas.toBlob((b) => res(b), 'image/png'); } catch { res(null); } });
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

export async function exportPptx(deck: Deck, variant: PptxVariant = 'pptx'): Promise<Uint8Array> {
  const w = new Writer(deck);
  const data = deck.data;
  await rasterizePictures(w);
  const pres = new PartCtx('ppt/presentation.xml', w);
  let uid = 2147483648;

  // Themes
  const themePart = new Map<string, string>();
  data.themes.forEach((t, i) => {
    const part = `ppt/theme/theme${i + 1}.xml`;
    w.put(part, themeXml(t), CT.theme);
    themePart.set(t.id, part);
  });

  // Masters and layouts
  const masterIds: string[] = [];
  const layoutPart = new Map<string, string>();
  let layoutN = 0;
  data.masters.forEach((m, mi) => {
    const part = `ppt/slideMasters/slideMaster${mi + 1}.xml`;
    const ctx = new PartCtx(part, w);
    const lays = data.layouts.filter((l) => l.master === m.id);
    const masterUid = uid++;
    const layIds: string[] = [];
    // Layout rels must come first (rId1..n) by convention.
    for (const l of lays) {
      layoutN++;
      const lpart = `ppt/slideLayouts/slideLayout${layoutN}.xml`;
      layoutPart.set(l.id, lpart);
      const rid = ctx.addRel(REL.slideLayout, lpart);
      layIds.push(`<p:sldLayoutId id="${uid++}" r:id="${rid}"/>`);
      writeLayout(w, l, lpart, part);
    }
    const thr = ctx.addRel(REL.theme, themePart.get(m.theme) || themePart.values().next().value!);
    const tree = spTreeXml(m.elements, ctx);
    const xml = `${XML_DECL}<p:sldMaster ${NSDECL}><p:cSld>${bgXml(m.bg || { type: 'solid', color: 'bg1' }, ctx)}${tree}</p:cSld><p:clrMap ${clrMapAttrs(m)}/><p:sldLayoutIdLst>${layIds.join('')}</p:sldLayoutIdLst><p:txStyles>${stylesXml(m.styles.title, ctx, 'titleStyle')}${stylesXml(m.styles.body, ctx, 'bodyStyle')}${stylesXml(m.styles.other, ctx, 'otherStyle')}</p:txStyles></p:sldMaster>`;
    w.put(part, xml, CT.slideMaster);
    w.put(relsPartOf(part), ctx.relsXml());
    masterIds.push(`<p:sldMasterId id="${masterUid}" r:id="${pres.addRel(REL.slideMaster, part)}"/>`);
    void thr;
  });

  // Notes master (only when a slide has notes)
  const hasNotes = data.slides.some((s) => s.notes?.some((p) => p.runs.some((r) => r.text)));
  let notesMasterPart = '';
  if (hasNotes) {
    notesMasterPart = 'ppt/notesMasters/notesMaster1.xml';
    const nThemePart = `ppt/theme/theme${data.themes.length + 1}.xml`;
    w.put(nThemePart, themeXml(data.themes[0], 'Notes'), CT.theme);
    const ctx = new PartCtx(notesMasterPart, w);
    ctx.addRel(REL.theme, nThemePart);
    const nw = 6858000, nh = 9144000;
    const sp = `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="1143000"/><a:ext cx="5486400" cy="3086100"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="12700"><a:solidFill><a:prstClr val="black"/></a:solidFill></a:ln></p:spPr></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" sz="quarter" idx="3"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="4400550"/><a:ext cx="5486400" cy="3600450"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0"/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Click to edit Master text styles</a:t></a:r></a:p></p:txBody></p:sp>`;
    const lvl = (i: number) => `<a:lvl${i}pPr marL="${(i - 1) * 457200}" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1200" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl${i}pPr>`;
    const xml = `${XML_DECL}<p:notesMaster ${NSDECL}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${sp}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:notesStyle>${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(lvl).join('')}</p:notesStyle></p:notesMaster>`;
    w.put(notesMasterPart, xml, CT.notesMaster);
    w.put(relsPartOf(notesMasterPart), ctx.relsXml());
    void nw; void nh;
  }

  // Slides
  const sldIds: string[] = [];
  const slideNumId = new Map<string, number>();
  const slideRid = new Map<string, string>();
  const hf = data.hf;
  data.slides.forEach((s, si) => {
    const part = `ppt/slides/slide${si + 1}.xml`;
    const ctx = new PartCtx(part, w);
    const lay = deck.layout(s.layout);
    ctx.addRel(REL.slideLayout, layoutPart.get(lay.id) || layoutPart.values().next().value!);
    let elements = s.elements;
    if (hf && !(hf.hideOnTitle && lay.type === 'title')) {
      // Footer placeholders the deck's header-and-footer settings switch on.
      const extra: Element[] = [];
      const has = (t: string) => s.elements.some((e) => e.ph?.type === t);
      const lp = (t: string) => lay.elements.find((e) => e.ph?.type === t);
      if (hf.slideNum && !has('sldNum') && lp('sldNum')) extra.push({ id: `${s.id}~num`, kind: 'shape', geom: 'rect', ph: { ...lp('sldNum')!.ph! }, text: { paras: [{ level: 0, runs: [{ text: String(si + (data.firstNumber ?? 1)), field: 'slidenum' }] }] } });
      if (hf.footer && hf.footerText && !has('ftr') && lp('ftr')) extra.push({ id: `${s.id}~ftr`, kind: 'shape', geom: 'rect', ph: { ...lp('ftr')!.ph! }, text: { paras: [{ level: 0, runs: [{ text: hf.footerText }] }] } });
      if (hf.date && !has('dt') && lp('dt')) extra.push({ id: `${s.id}~dt`, kind: 'shape', geom: 'rect', ph: { ...lp('dt')!.ph! }, text: { paras: [{ level: 0, runs: [hf.dateFixed ? { text: hf.dateText || '' } : { text: new Date().toLocaleDateString(), field: 'datetime' }] }] } });
      if (extra.length) elements = [...elements, ...extra];
    }
    const tree = spTreeXml(elements, ctx);
    const timing = timingXml(s, ctx);
    const attrs = `${s.hidden ? ' show="0"' : ''}${s.hideMasterShapes ? ' showMasterSp="0"' : ''}`;
    const name = s.name ? ` name="${esc(s.name)}"` : '';
    const xml = `${XML_DECL}<p:sld ${NSDECL}${attrs}><p:cSld${name}>${bgXml(s.bg, ctx)}${tree}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>${transitionXml(s.transition)}${timing}</p:sld>`;
    w.put(part, xml, CT.slide);
    if (hasNotes && s.notes?.some((p) => p.runs.some((r) => r.text))) {
      const npart = `ppt/notesSlides/notesSlide${si + 1}.xml`;
      const nctx = new PartCtx(npart, w);
      nctx.addRel(REL.notesMaster, notesMasterPart);
      nctx.addRel(REL.slide, part);
      ctx.addRel(REL.notesSlide, npart);
      const body = txBodyXml({ paras: s.notes }, nctx);
      const nxml = `${XML_DECL}<p:notes ${NSDECL}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/>${body}</p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`;
      w.put(npart, nxml, CT.notesSlide);
      w.put(relsPartOf(npart), nctx.relsXml());
    }
    w.put(relsPartOf(part), ctx.relsXml());
    const rid = pres.addRel(REL.slide, part);
    slideRid.set(s.id, rid);
    const nid = 256 + si;
    slideNumId.set(s.id, nid);
    sldIds.push(`<p:sldId id="${nid}" r:id="${rid}"/>`);
  });

  // Presentation part
  const notesIdLst = notesMasterPart ? `<p:notesMasterIdLst><p:notesMasterId r:id="${pres.addRel(REL.notesMaster, notesMasterPart)}"/></p:notesMasterIdLst>` : '';
  pres.addRel(REL.presProps, 'ppt/presProps.xml');
  pres.addRel(REL.viewProps, 'ppt/viewProps.xml');
  pres.addRel(REL.theme, themePart.values().next().value!);
  pres.addRel(REL.tableStyles, 'ppt/tableStyles.xml');
  const custShows = data.customShows.length ? `<p:custShowLst>${data.customShows.map((cs, i) => `<p:custShow name="${esc(cs.name)}" id="${i}"><p:sldLst>${cs.slides.filter((id) => slideRid.has(id)).map((id) => `<p:sld r:id="${slideRid.get(id)}"/>`).join('')}</p:sldLst></p:custShow>`).join('')}</p:custShowLst>` : '';
  const sections = data.sections.length ? `<p:extLst><p:ext uri="{521415D9-36F7-43E2-AB2F-B90AF26B5E84}"><p14:sectionLst xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main">${data.sections.map((sec) => `<p14:section name="${esc(sec.name)}" id="${guid()}"><p14:sldIdLst>${sec.slides.filter((id) => slideNumId.has(id)).map((id) => `<p14:sldId id="${slideNumId.get(id)}"/>`).join('')}</p14:sldIdLst></p14:section>`).join('')}</p14:sectionLst></p:ext></p:extLst>` : '';
  const cx = toEmu(data.size.w), cy = toEmu(data.size.h);
  const first = data.firstNumber != null && data.firstNumber !== 1 ? ` firstSlideNum="${data.firstNumber}"` : '';
  const presXml = `${XML_DECL}<p:presentation ${NSDECL} saveSubsetFonts="1"${first}><p:sldMasterIdLst>${masterIds.join('')}</p:sldMasterIdLst>${notesIdLst}${sldIds.length ? `<p:sldIdLst>${sldIds.join('')}</p:sldIdLst>` : ''}<p:sldSz cx="${cx}" cy="${cy}"/><p:notesSz cx="6858000" cy="9144000"/>${custShows}<p:defaultTextStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr></p:defaultTextStyle>${sections}</p:presentation>`;
  const presCt = variant === 'pptm' ? CT.presentationMacro : variant === 'ppsx' ? CT.show : variant === 'potx' ? CT.template : CT.presentation;
  w.put('ppt/presentation.xml', presXml, presCt);
  if (variant === 'pptm' && data.vba) {
    w.put('ppt/vbaProject.bin', unb64(data.vba), CT.vba);
    pres.addRel(REL.vba, 'ppt/vbaProject.bin');
  }
  w.put(relsPartOf('ppt/presentation.xml'), pres.relsXml());
  const sh = data.show;
  const showPr = sh.loop || sh.kiosk || sh.useTimings === false ? `<p:showPr${sh.loop ? ' loop="1"' : ''}${sh.useTimings === false ? ' useTimings="0"' : ''}>${sh.kiosk ? '<p:kiosk/>' : '<p:present/>'}<p:sldAll/></p:showPr>` : '';
  w.put('ppt/presProps.xml', `${XML_DECL}<p:presentationPr ${NSDECL}>${showPr}</p:presentationPr>`, CT.presProps);
  w.put('ppt/viewProps.xml', `${XML_DECL}<p:viewPr ${NSDECL}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`, CT.viewProps);
  w.put('ppt/tableStyles.xml', `${XML_DECL}<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`, CT.tableStyles);

  // Document properties
  const p = data.props;
  const iso = (t?: number) => new Date(t || Date.now()).toISOString().replace(/\.\d+Z$/, 'Z');
  const core = `${XML_DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">${p.title ? `<dc:title>${esc(p.title)}</dc:title>` : ''}${p.subject ? `<dc:subject>${esc(p.subject)}</dc:subject>` : ''}<dc:creator>${esc(p.author || '')}</dc:creator>${p.keywords ? `<cp:keywords>${esc(p.keywords)}</cp:keywords>` : ''}${p.description ? `<dc:description>${esc(p.description)}</dc:description>` : ''}<cp:lastModifiedBy>${esc(p.lastModifiedBy || p.author || '')}</cp:lastModifiedBy>${p.category ? `<cp:category>${esc(p.category)}</cp:category>` : ''}<dcterms:created xsi:type="dcterms:W3CDTF">${iso(p.created)}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${iso(p.modified)}</dcterms:modified></cp:coreProperties>`;
  w.put('docProps/core.xml', core, CT.core);
  const app = `${XML_DECL}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Anne\'s Stage</Application><PresentationFormat>On-screen Show</PresentationFormat><Slides>${data.slides.length}</Slides><Notes>${data.slides.filter((s) => s.notes?.some((q) => q.runs.some((r) => r.text))).length}</Notes><HiddenSlides>${data.slides.filter((s) => s.hidden).length}</HiddenSlides>${p.company ? `<Company>${esc(p.company)}</Company>` : ''}<AppVersion>16.0000</AppVersion></Properties>`;
  w.put('docProps/app.xml', app, CT.app);
  const root = new PartCtx('', w);
  root.rels.push({ id: 'rId1', type: REL.officeDocument, target: 'ppt/presentation.xml' }, { id: 'rId2', type: REL.coreProps, target: 'docProps/core.xml' }, { id: 'rId3', type: REL.extProps, target: 'docProps/app.xml' });
  w.put('_rels/.rels', root.relsXml());

  const zip = new JSZip();
  zip.file('[Content_Types].xml', w.contentTypes());
  for (const [k, v] of w.files) zip.file(k, v);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
}

function writeLayout(w: Writer, l: Layout, part: string, masterPart: string): void {
  const ctx = new PartCtx(part, w);
  ctx.addRel(REL.slideMaster, masterPart);
  const type = l.type && LAYOUT_TYPES.has(l.type) ? ` type="${l.type}"` : '';
  const xml = `${XML_DECL}<p:sldLayout ${NSDECL}${type} preserve="1"${l.hideMasterShapes ? ' showMasterSp="0"' : ''}><p:cSld name="${esc(l.name)}">${bgXml(l.bg, ctx)}${spTreeXml(l.elements, ctx)}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
  w.put(part, xml, CT.slideLayout);
  w.put(relsPartOf(part), ctx.relsXml());
}

