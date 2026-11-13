/**
 * Slide renderer. Every surface (edit view, thumbnails, slide show, presenter view, print, PNG and
 * PDF export, the HTML show) draws slides with this module, so what you see is what you present and
 * export. Output is SVG markup in slide points; callers scale it with the viewBox.
 */
import type { Deck } from '../model/deck';
import type { Color, Element, Fill, Layout, Line, Master, Slide, ShapeElement, PictureElement, TableElement, Effects, Paragraph, LevelStyle, TextBody, GroupElement, MediaElement, ChartElement } from '../model/types';
import { chain, isEmptyPlaceholder, levelStyle, masterOfOwner, promptText, resolveBody, resolveBox, resolveFillLine, type Owner, isSlide } from '../model/inherit';
import { cssColor, themeFont, type ColorContext } from '../model/theme';
import { geometryPath, textRect } from '../model/geometry';
import { layoutText, type LayoutResult } from './text';
import { renderChart } from './chart';
import { fontFamilyCss } from '../fonts';
import { escXml } from '../util/sanitize';

export interface RenderOptions {
  mode?: 'edit' | 'show' | 'thumb' | 'print';
  /** Show prompts in empty placeholders (edit view). */
  prompts?: boolean;
  /** Elements not drawn (build steps not reached yet, the shape being edited in place). */
  hide?: Set<string>;
  /** Per-element extra SVG attributes (opacity during builds). */
  attrs?: Map<string, string>;
  /** Paragraph visibility for by-paragraph builds: element id → visible paragraph indexes. */
  paraVisible?: Map<string, Set<number>>;
  /** Number shown by slide-number fields. */
  number?: number;
  /** Add data-id attributes for hit testing. */
  ids?: boolean;
  /** Draw ink strokes. */
  ink?: boolean;
  /** Draw the grid / guides (edit view). */
  grid?: number;
  grayscale?: boolean;
  /** Pure black and white preview (print preview of black-and-white printers). */
  blackWhite?: boolean;
}

let uid = 0;
/** Escapes text for markup; also drops characters that are illegal in XML (they blank the slide in XML parsers). */
export const esc = escXml;
const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? +x.toFixed(2) : 0; };
/** A number in [0, 1] (opacities). */
const unit = (v: unknown, dflt: number) => { const x = Number(v); return Number.isFinite(x) ? Math.max(0, Math.min(1, +x.toFixed(3))) : dflt; };
const CAPS: Record<string, string> = { flat: 'butt', butt: 'butt', round: 'round', square: 'square', sq: 'square' };
const JOINS: Record<string, string> = { round: 'round', bevel: 'bevel', miter: 'miter' };

interface Ctx {
  deck: Deck;
  owner: Owner;
  cc: ColorContext;
  defs: string[];
  prefix: string;
  opts: RenderOptions;
  slide?: Slide;
}

/** Renders a slide (or a layout or master when editing those) to SVG markup. */
export function slideSvg(deck: Deck, owner: Owner, opts: RenderOptions = {}): string {
  const { w, h } = deck.size;
  const master = masterOfOwner(deck, owner);
  const theme = deck.theme(master.theme);
  const ctx: Ctx = { deck, owner, cc: { theme, master }, defs: [], prefix: `q${(uid++).toString(36)}_`, opts, slide: isSlide(owner) ? owner : undefined };
  const body: string[] = [];
  body.push(backgroundSvg(ctx, owner, w, h));
  const layout: Layout | undefined = isSlide(owner) ? deck.layout(owner.layout) : 'master' in owner && !('styles' in owner) ? owner as Layout : undefined;
  const hideMaster = (isSlide(owner) && owner.hideMasterShapes) || (layout?.hideMasterShapes);
  // Master graphics, then layout graphics (placeholders on masters and layouts are not drawn on slides).
  if (owner !== master && !hideMaster) for (const e of master.elements) if (!e.ph) body.push(elementSvg(ctx, e, master));
  if (layout && owner !== layout && !(isSlide(owner) && owner.hideMasterShapes)) {
    for (const e of layout.elements) if (!e.ph) body.push(elementSvg(ctx, e, layout));
  }
  if (isSlide(owner) && layout) body.push(footersSvg(ctx, owner, layout));
  for (const e of owner.elements) body.push(elementSvg(ctx, e, owner));
  if (opts.ink !== false && isSlide(owner) && owner.ink?.length) {
    for (const s of owner.ink) body.push(`<path d="${esc(s.d)}" fill="none" stroke="${esc(s.color)}" stroke-width="${n(s.width)}" stroke-linecap="round" stroke-linejoin="round"${s.highlighter ? ' opacity="0.4"' : ''}/>`);
  }
  if (opts.grid) {
    const g = opts.grid;
    const lines: string[] = [];
    for (let x = g; x < w; x += g) lines.push(`M${n(x)} 0 V${n(h)}`);
    for (let y = g; y < h; y += g) lines.push(`M0 ${n(y)} H${n(w)}`);
    body.push(`<path d="${lines.join(' ')}" stroke="#8888" stroke-width="0.4" fill="none" pointer-events="none"/>`);
  }
  const filter = opts.grayscale || opts.blackWhite ? ` filter="url(#${ctx.prefix}gray)"` : '';
  if (opts.blackWhite) ctx.defs.push(`<filter id="${ctx.prefix}gray"><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncR type="discrete" tableValues="0 1"/><feFuncG type="discrete" tableValues="0 1"/><feFuncB type="discrete" tableValues="0 1"/></feComponentTransfer></filter>`);
  else if (opts.grayscale) ctx.defs.push(`<filter id="${ctx.prefix}gray"><feColorMatrix type="saturate" values="0"/></filter>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${n(w)} ${n(h)}" width="${n(w)}" height="${n(h)}" preserveAspectRatio="xMidYMid meet" class="qs-slide-svg"><defs>${ctx.defs.join('')}</defs><g${filter}>${body.join('')}</g></svg>`;
}

/** The background fill in effect for a slide, layout or master. */
export function effectiveBackground(deck: Deck, owner: Owner): Fill {
  if (owner.bg) return owner.bg;
  if (isSlide(owner)) {
    const lay = deck.layout(owner.layout);
    if (lay.bg) return lay.bg;
    return deck.master(lay.master).bg || { type: 'solid', color: 'bg1' };
  }
  if ('master' in owner && !('styles' in owner)) return deck.master((owner as Layout).master).bg || { type: 'solid', color: 'bg1' };
  return { type: 'solid', color: 'bg1' };
}

function backgroundSvg(ctx: Ctx, owner: Owner, w: number, h: number): string {
  const bg = effectiveBackground(ctx.deck, owner);
  const paint = fillPaint(ctx, bg, w, h);
  return `<rect x="0" y="0" width="${n(w)}" height="${n(h)}" fill="${paint}" class="qs-bg"/>`;
}

function footersSvg(ctx: Ctx, slide: Slide, layout: Layout): string {
  const hf = ctx.deck.data.hf;
  if (!hf) return '';
  if (hf.hideOnTitle && layout.type === 'title') return '';
  const out: string[] = [];
  for (const e of layout.elements) {
    if (!e.ph || e.kind !== 'shape') continue;
    // A slide may carry its own footer placeholders (from a file); those are drawn as its elements.
    if (slide.elements.some((s) => s.ph?.type === e.ph!.type)) continue;
    let text = '';
    if (e.ph.type === 'sldNum' && hf.slideNum) text = String(ctx.opts.number ?? (ctx.deck.slideIndex(slide.id) + (ctx.deck.data.firstNumber ?? 1)));
    else if (e.ph.type === 'ftr' && hf.footer) text = hf.footerText || '';
    else if (e.ph.type === 'dt' && hf.date) text = hf.dateFixed ? hf.dateText || '' : new Date().toLocaleDateString();
    if (!text) continue;
    const el: ShapeElement = { ...(e as ShapeElement), id: `${e.id}~f`, text: { ...(e as ShapeElement).text!, paras: [{ level: 0, runs: [{ text }] }] } };
    out.push(elementSvg(ctx, el, layout, true));
  }
  return out.join('');
}

function transformOf(x: number, y: number, w: number, h: number, rot: number, flipH: boolean, flipV: boolean): string {
  let t = `translate(${n(x)} ${n(y)})`;
  if (rot) t += ` rotate(${n(rot)} ${n(w / 2)} ${n(h / 2)})`;
  if (flipH || flipV) t += ` translate(${flipH ? n(w) : 0} ${flipV ? n(h) : 0}) scale(${flipH ? -1 : 1} ${flipV ? -1 : 1})`;
  return t;
}

export function elementSvg(ctx: Ctx, el: Element, owner: Owner, footer = false): string {
  if (el.hidden && ctx.opts.mode !== 'edit') return '';
  if (ctx.opts.hide?.has(el.id)) return '';
  const box = resolveBox(ctx.deck, owner, el);
  const t = transformOf(box.x, box.y, box.w, box.h, box.rot, box.flipH, box.flipV);
  const idAttr = ctx.opts.ids && !footer ? ` data-id="${esc(el.id)}"` : '';
  const extra = ctx.opts.attrs?.get(el.id) || '';
  const hiddenStyle = el.hidden ? ' opacity="0.35"' : '';
  let inner = '';
  switch (el.kind) {
    case 'shape': inner = shapeSvg(ctx, el, owner, box.w, box.h, box.flipH, box.flipV); break;
    case 'picture': inner = pictureSvg(ctx, el, box.w, box.h); break;
    case 'table': inner = tableSvg(ctx, el, owner, box.w, box.h); break;
    case 'chart': inner = renderChart((el as ChartElement).chart, box.w, box.h, (c) => cssColor(c, ctx.cc), ctx.prefix + esc(el.id)); break;
    case 'media': inner = mediaSvg(ctx, el, box.w, box.h); break;
    case 'group': inner = groupSvg(ctx, el, owner); break;
  }
  const effects = (el as ShapeElement).effects;
  const filter = effects ? effectFilter(ctx, effects) : '';
  return `<g transform="${t}"${idAttr}${extra}${hiddenStyle}${filter}>${inner}</g>`;
}

function groupSvg(ctx: Ctx, g: GroupElement, owner: Owner): string {
  // Children are stored in slide coordinates, so undo the group's translation.
  const x = g.x ?? 0, y = g.y ?? 0;
  return `<g transform="translate(${n(-x)} ${n(-y)})">${g.children.map((c) => elementSvg(ctx, c, owner)).join('')}</g>`;
}

function effectFilter(ctx: Ctx, fx: Effects): string {
  const id = `${ctx.prefix}fx${ctx.defs.length}`;
  const parts: string[] = [];
  if (fx.shadow) {
    const s = fx.shadow;
    const rad = (s.dir * Math.PI) / 180;
    parts.push(`<feDropShadow dx="${n(Math.cos(rad) * s.dist)}" dy="${n(Math.sin(rad) * s.dist)}" stdDeviation="${n(s.blur / 2)}" flood-color="${esc(cssColor(s.color, ctx.cc))}" flood-opacity="${unit(s.alpha, 0.4)}"/>`);
  }
  if (fx.glow) parts.push(`<feMorphology operator="dilate" radius="${n(fx.glow.rad / 3)}" in="SourceAlpha" result="g1"/><feGaussianBlur in="g1" stdDeviation="${n(fx.glow.rad / 2)}" result="g2"/><feFlood flood-color="${esc(cssColor(fx.glow.color, ctx.cc))}" flood-opacity="0.6"/><feComposite in2="g2" operator="in" result="g3"/><feMerge><feMergeNode in="g3"/><feMergeNode in="SourceGraphic"/></feMerge>`);
  if (fx.softEdge) parts.push(`<feGaussianBlur stdDeviation="${n(fx.softEdge / 3)}"/>`);
  if (!parts.length) return '';
  ctx.defs.push(`<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%">${parts.join('')}</filter>`);
  return ` filter="url(#${id})"`;
}

// ------------------------------------------------------------------------------------------
// Fills and lines

export function fillPaint(ctx: Ctx, fill: Fill | undefined, w: number, h: number): string {
  if (!fill || fill.type === 'none') return 'none';
  if (fill.type === 'solid') return esc(cssColor(fill.color, ctx.cc));
  if (fill.type === 'gradient') {
    const id = `${ctx.prefix}g${ctx.defs.length}`;
    const stops = fill.stops.map((s) => `<stop offset="${n(s.pos * 100)}%" stop-color="${esc(cssColor(s.color, ctx.cc))}"/>`).join('');
    if (fill.path === 'radial') ctx.defs.push(`<radialGradient id="${id}">${stops}</radialGradient>`);
    else {
      const a = ((fill.angle ?? 90) * Math.PI) / 180;
      const dx = Math.cos(a) / 2, dy = Math.sin(a) / 2;
      ctx.defs.push(`<linearGradient id="${id}" x1="${n(0.5 - dx)}" y1="${n(0.5 - dy)}" x2="${n(0.5 + dx)}" y2="${n(0.5 + dy)}">${stops}</linearGradient>`);
    }
    return `url(#${id})`;
  }
  if (fill.type === 'image') {
    const id = `${ctx.prefix}i${ctx.defs.length}`;
    const href = esc(ctx.deck.mediaUrl(fill.media));
    if (fill.mode === 'tile') ctx.defs.push(`<pattern id="${id}" patternUnits="userSpaceOnUse" width="96" height="96"><image href="${href}" width="96" height="96"/></pattern>`);
    else ctx.defs.push(`<pattern id="${id}" patternUnits="objectBoundingBox" width="1" height="1" patternContentUnits="objectBoundingBox"><image href="${href}" width="1" height="1" preserveAspectRatio="none"${fill.alpha != null ? ` opacity="${unit(fill.alpha, 1)}"` : ''}/></pattern>`);
    return `url(#${id})`;
  }
  if (fill.type === 'pattern') {
    const id = `${ctx.prefix}p${ctx.defs.length}`;
    const fg = esc(cssColor(fill.fg, ctx.cc)), bg = esc(cssColor(fill.bg, ctx.cc, '#FFFFFF'));
    const p = fill.preset || '';
    const mark = /horz/i.test(p) ? `<path d="M0 4 H8" stroke="${fg}"/>` : /vert/i.test(p) ? `<path d="M4 0 V8" stroke="${fg}"/>` : /dn|down|wd/i.test(p) ? `<path d="M0 0 L8 8" stroke="${fg}"/>` : /cross/i.test(p) ? `<path d="M0 4 H8 M4 0 V8" stroke="${fg}"/>` : /up/i.test(p) ? `<path d="M0 8 L8 0" stroke="${fg}"/>` : `<rect x="3" y="3" width="2" height="2" fill="${fg}"/>`;
    ctx.defs.push(`<pattern id="${id}" patternUnits="userSpaceOnUse" width="8" height="8"><rect width="8" height="8" fill="${bg}"/>${mark}</pattern>`);
    return `url(#${id})`;
  }
  return 'none';
}

const DASH: Record<string, (w: number) => string> = {
  dash: (w) => `${4 * w} ${3 * w}`, dot: (w) => `${w} ${2 * w}`, dashDot: (w) => `${4 * w} ${2 * w} ${w} ${2 * w}`,
  longDash: (w) => `${8 * w} ${3 * w}`, longDashDot: (w) => `${8 * w} ${3 * w} ${w} ${3 * w}`, sysDash: (w) => `${3 * w} ${w}`, sysDot: (w) => `${w} ${w}`,
};

function strokeAttrs(ctx: Ctx, line: Line | undefined): string {
  if (!line || !line.fill || line.fill.type === 'none') return ' stroke="none"';
  const color = line.fill.type === 'solid' ? esc(cssColor(line.fill.color, ctx.cc)) : fillPaint(ctx, line.fill, 1, 1);
  const w = line.width == null ? 0.75 : n(line.width);
  let a = ` stroke="${color}" stroke-width="${n(w)}"`;
  if (line.dash && line.dash !== 'solid' && Object.prototype.hasOwnProperty.call(DASH, line.dash)) a += ` stroke-dasharray="${DASH[line.dash](Math.max(n(w), 1))}"`;
  if (line.cap && CAPS[line.cap]) a += ` stroke-linecap="${CAPS[line.cap]}"`;
  if (line.join && JOINS[line.join]) a += ` stroke-linejoin="${JOINS[line.join]}"`;
  for (const end of ['head', 'tail'] as const) {
    const kind = line[end];
    if (!kind || kind === 'none') continue;
    const id = `${ctx.prefix}m${ctx.defs.length}`;
    const shape = kind === 'oval' ? '<circle cx="5" cy="5" r="4"/>' : kind === 'diamond' ? '<path d="M5 0 L10 5 L5 10 L0 5 Z"/>' : kind === 'arrow' ? `<path d="M0 0 L10 5 L0 10" fill="none" stroke="${color}" stroke-width="1.5"/>` : kind === 'stealth' ? '<path d="M0 0 L10 5 L0 10 L3 5 Z"/>' : '<path d="M0 0 L10 5 L0 10 Z"/>';
    ctx.defs.push(`<marker id="${id}" viewBox="0 0 10 10" refX="${end === 'tail' ? 8 : 2}" refY="5" markerWidth="${n(Math.max(3, 3 + w))}" markerHeight="${n(Math.max(3, 3 + w))}" orient="auto-start-reverse" fill="${color}">${shape}</marker>`);
    a += end === 'head' ? ` marker-start="url(#${id})"` : ` marker-end="url(#${id})"`;
  }
  return a;
}

// ------------------------------------------------------------------------------------------
// Shapes and text

function defaultFillLine(el: ShapeElement): { fill: Fill; line: Line } {
  // Ordinary shapes default to the theme's accent fill and a darker outline; text boxes and
  // placeholders to no fill and no line.
  if (el.textbox || el.ph) return { fill: { type: 'none' }, line: {} };
  if (/^(line|straightConnector1|bentConnector\d|curvedConnector\d|arc|bracketPair|bracePair)$/.test(el.geom)) return { fill: { type: 'none' }, line: { fill: { type: 'solid', color: 'accent1' }, width: 1 } };
  return { fill: { type: 'solid', color: 'accent1' }, line: { fill: { type: 'solid', color: { s: 'accent1', lum: -0.5 } }, width: 1 } };
}

function shapeSvg(ctx: Ctx, el: ShapeElement, owner: Owner, w: number, h: number, flipH: boolean, flipV: boolean): string {
  const fl = resolveFillLine(ctx.deck, owner, el);
  const def = defaultFillLine(el);
  const fill = fl.fill ?? def.fill;
  const line = fl.line ?? def.line;
  const geom = chain(ctx.deck, owner, el).map((e) => (e as ShapeElement).geom).find((g) => g && g !== 'rect') || el.geom || 'rect';
  const { d, open } = geometryPath(geom, w, h, el.adj, el.path);
  let out = '';
  const paint = open ? 'none' : fillPaint(ctx, fill, w, h);
  const stroke = strokeAttrs(ctx, line);
  if (paint !== 'none' || !stroke.includes('stroke="none"')) out += `<path d="${esc(d)}" fill="${paint}"${stroke} fill-rule="evenodd"/>`;
  else if (ctx.opts.mode === 'edit' && el.ph) out += `<rect width="${n(w)}" height="${n(h)}" fill="none" stroke="#9aa0a6" stroke-width="0.75" stroke-dasharray="3 2" class="qs-ph-outline"/>`;
  else out += `<rect width="${n(w)}" height="${n(h)}" fill="transparent" stroke="none"/>`;
  // Text is not mirrored with the shape.
  const text = textSvg(ctx, el, owner, geom, w, h);
  if (text) out += flipH || flipV ? `<g transform="translate(${flipH ? n(w) : 0} ${flipV ? n(h) : 0}) scale(${flipH ? -1 : 1} ${flipV ? -1 : 1})">${text}</g>` : text;
  return out;
}

/** Lays out an element's text with its inherited styles (used by the renderer and the editor). */
export function layoutElementText(deck: Deck, owner: Owner, el: ShapeElement | { id: string; kind: 'shape'; ph?: any; text?: TextBody }, w: number, h: number, paras?: Paragraph[], number?: number): { lay: LayoutResult; body: Omit<TextBody, 'paras' | 'levels'>; rect: [number, number, number, number]; theme: ReturnType<Deck['theme']> } {
  const body = resolveBody(deck, owner, el as Element);
  const master = masterOfOwner(deck, owner);
  const theme = deck.theme(master.theme);
  const ins = body.insets || [7.2, 3.6, 7.2, 3.6];
  const geom = (el as ShapeElement).geom || 'rect';
  const [tx, ty, tw, th] = textRect(geom, w, h);
  const rect: [number, number, number, number] = [tx + ins[0], ty + ins[1], Math.max(1, tw - ins[0] - ins[2]), Math.max(1, th - ins[1] - ins[3])];
  const vertical = body.vert === 'vert' || body.vert === 'vert270';
  const styles = new Map<number, LevelStyle>();
  const lay = layoutText(paras || (el as ShapeElement).text?.paras || [], {
    width: vertical ? rect[3] : rect[2], height: vertical ? rect[2] : rect[3],
    styleFor: (lv) => { let s = styles.get(lv); if (!s) { s = levelStyle(deck, owner, el as Element, lv); styles.set(lv, s); } return s; },
    font: (f) => themeFont(f, theme) || theme.fonts.minor,
    autofit: body.autofit, fontScale: body.fontScale, lineReduction: body.lineReduction, wrap: body.wrap,
    fields: { slidenum: number != null ? String(number) : isSlide(owner) ? String(deck.slideIndex(owner.id) + (deck.data.firstNumber ?? 1)) : '#', date: new Date().toLocaleDateString() },
  });
  return { lay, body, rect, theme };
}

function textSvg(ctx: Ctx, el: ShapeElement, owner: Owner, geom: string, w: number, h: number): string {
  let paras = el.text?.paras;
  let prompt = false;
  if (isEmptyPlaceholder(el)) {
    if (!ctx.opts.prompts || ctx.opts.mode !== 'edit') return '';
    paras = promptText(ctx.deck, owner, el).split('\n').map((t) => ({ level: 0, runs: [{ text: t }] }));
    prompt = true;
  }
  if (!paras || !paras.some((p) => p.runs.some((r) => r.text))) return '';
  const visible = ctx.opts.paraVisible?.get(el.id);
  const { lay, body, rect } = layoutElementText(ctx.deck, owner, { ...el, geom } as ShapeElement, w, h, paras, ctx.opts.number);
  return linesSvg(ctx, lay, body, rect, prompt, visible);
}

function linesSvg(ctx: Ctx, lay: LayoutResult, body: Omit<TextBody, 'paras' | 'levels'>, rect: [number, number, number, number], prompt: boolean, visible?: Set<number>): string {
  const [rx, ry, rw, rh] = rect;
  const vertical = body.vert === 'vert' || body.vert === 'vert270';
  const boxW = vertical ? rh : rw, boxH = vertical ? rw : rh;
  const anchor = body.anchor || 't';
  const total = lay.height;
  const top = anchor === 'ctr' ? (boxH - total) / 2 : anchor === 'b' ? boxH - total : 0;
  const out: string[] = [];
  for (const ln of lay.lines) {
    if (visible && !visible.has(ln.para)) continue;
    const y = top + ln.y;
    const free = ln.avail - ln.width;
    const dx = ln.align === 'ctr' ? free / 2 : ln.align === 'r' ? free : 0;
    if (ln.bullet) {
      const bc = esc(cssColor(ln.bullet.color, ctx.cc));
      out.push(`<text x="${n(ln.bullet.x)}" y="${n(y)}" font-family="${esc(fontFamilyCss(ln.bullet.font))}" font-size="${n(ln.bullet.size)}" fill="${bc}">${esc(ln.bullet.text)}</text>`);
    }
    if (!ln.segs.length) continue;
    const spans: string[] = [];
    const deco: string[] = [];
    for (const s of ln.segs) {
      const st = s.style;
      const x = ln.left + dx + s.x;
      const fill = prompt ? '#80868b' : esc(cssColor(st.color, ctx.cc));
      if (st.highlight) deco.push(`<rect x="${n(x)}" y="${n(y - s.size * 0.85)}" width="${n(s.w)}" height="${n(s.size * 1.1)}" fill="${esc(cssColor(st.highlight, ctx.cc))}"/>`);
      const dec = [st.u ? 'underline' : '', st.strike ? 'line-through' : ''].filter(Boolean).join(' ');
      const shift = st.baseline ? ` dy="${n(-(st.baseline / 100) * s.size * 1.4)}"` : '';
      spans.push(`<tspan x="${n(x)}" y="${n(y)}"${shift} font-family="${esc(fontFamilyCss(s.font))}" font-size="${n(s.size)}"${st.b ? ' font-weight="bold"' : ''}${st.i ? ' font-style="italic"' : ''}${dec ? ` text-decoration="${dec}"` : ''}${st.spc ? ` letter-spacing="${n(st.spc)}"` : ''}${st.caps === 'small' ? ' font-variant="small-caps"' : ''} fill="${fill}">${esc(s.text)}</tspan>`);
    }
    out.push(...deco, `<text xml:space="preserve">${spans.join('')}</text>`);
  }
  const rot = body.vert === 'vert' ? ` rotate(90) translate(0 ${n(-rw)})` : body.vert === 'vert270' ? ` rotate(-90) translate(${n(-rh)} 0)` : '';
  const clip = '';
  return `<g transform="translate(${n(rx)} ${n(ry)})${rot}"${clip} class="qs-text">${out.join('')}</g>`;
}

// ------------------------------------------------------------------------------------------
// Pictures, tables, media

function pictureSvg(ctx: Ctx, el: PictureElement, w: number, h: number): string {
  const href = esc(ctx.deck.mediaUrl(el.media));
  const [cl, ct, cr, cb] = (Array.isArray(el.crop) ? el.crop : [0, 0, 0, 0]).map((v) => n(v));
  const vw = 1 - cl - cr, vh = 1 - ct - cb;
  const iw = w / (vw || 1), ih = h / (vh || 1);
  const id = `${ctx.prefix}c${ctx.defs.length}`;
  const geom = esc(el.geom && el.geom !== 'rect' ? geometryPath(el.geom, w, h).d : `M0 0 H${n(w)} V${n(h)} H0 Z`);
  ctx.defs.push(`<clipPath id="${id}"><path d="${geom}"/></clipPath>`);
  let filter = '';
  const a = el.adjust;
  if (a && (a.brightness || a.contrast || a.saturation != null || a.grayscale || a.transparency)) {
    const fid = `${ctx.prefix}pf${ctx.defs.length}`;
    const b = a.brightness || 0, c = 1 + (a.contrast || 0);
    const parts = [`<feComponentTransfer><feFuncR type="linear" slope="${n(c)}" intercept="${n(b + (1 - c) / 2)}"/><feFuncG type="linear" slope="${n(c)}" intercept="${n(b + (1 - c) / 2)}"/><feFuncB type="linear" slope="${n(c)}" intercept="${n(b + (1 - c) / 2)}"/></feComponentTransfer>`];
    if (a.grayscale || a.saturation != null) parts.push(`<feColorMatrix type="saturate" values="${a.grayscale ? 0 : n(a.saturation ?? 1)}"/>`);
    ctx.defs.push(`<filter id="${fid}">${parts.join('')}</filter>`);
    filter = ` filter="url(#${fid})"`;
  }
  const opacity = a?.transparency ? ` opacity="${n(1 - a.transparency)}"` : '';
  const img = href ? `<image href="${href}" x="${n(-cl * iw)}" y="${n(-ct * ih)}" width="${n(iw)}" height="${n(ih)}" preserveAspectRatio="none"${filter}${opacity}/>` : `<rect width="${n(w)}" height="${n(h)}" fill="#ddd"/><path d="M0 0 L${n(w)} ${n(h)} M${n(w)} 0 L0 ${n(h)}" stroke="#999"/>`;
  const outline = el.line ? `<path d="${geom}" fill="none"${strokeAttrs(ctx, el.line)}/>` : '';
  return `<g clip-path="url(#${id})">${img}</g>${outline}`;
}

function tableSvg(ctx: Ctx, t: TableElement, owner: Owner, w: number, h: number): string {
  const out: string[] = [];
  const colX: number[] = [0];
  for (const c of t.cols) colX.push(colX[colX.length - 1] + c);
  const sx = colX[colX.length - 1] ? w / colX[colX.length - 1] : 1;
  let y = 0;
  const totalH = t.rows.reduce((a, r) => a + (Number(r.h) > 0 ? Number(r.h) : 0), 0);
  // Rows are stretched or squeezed to the table frame (row heights are proportions of it).
  const sy = totalH > 0 && h > 0 ? h / totalH : 1;
  const st = t.style || {};
  const accent: Color = st.accent || 'accent1';
  t.rows.forEach((row, ri) => {
    const rh = row.h * sy;
    row.cells.forEach((cell, ci) => {
      if (cell.merged) return;
      const cw = (colX[Math.min(ci + (cell.colSpan || 1), t.cols.length)] - colX[ci]) * sx;
      let chH = 0;
      for (let k = ri; k < Math.min(t.rows.length, ri + (cell.rowSpan || 1)); k++) chH += t.rows[k].h * sy;
      const x = colX[ci] * sx;
      // Table style: header row in the accent color, banded rows in a tint.
      let fill: Fill | undefined = cell.fill;
      let headerText = false;
      if (!fill) {
        if (st.firstRow && ri === 0) { fill = { type: 'solid', color: accent }; headerText = true; }
        else if (st.lastRow && ri === t.rows.length - 1) fill = { type: 'solid', color: typeof accent === 'string' ? { s: accent, lum: 0.6 } : accent };
        else if (st.bandRow && (ri - (st.firstRow ? 1 : 0)) % 2 === 0) fill = { type: 'solid', color: typeof accent === 'string' ? { s: accent, lum: 0.8 } : accent };
        else if (st.bandRow) fill = { type: 'solid', color: typeof accent === 'string' ? { s: accent, lum: 0.9 } : accent };
      }
      out.push(`<rect x="${n(x)}" y="${n(y)}" width="${n(cw)}" height="${n(chH)}" fill="${fillPaint(ctx, fill, cw, chH)}"/>`);
      const b = cell.borders || [];
      const edges: [number, number, number, number][] = [[x, y, x, y + chH], [x, y, x + cw, y], [x + cw, y, x + cw, y + chH], [x, y + chH, x + cw, y + chH]];
      edges.forEach((e, k) => {
        const ln = b[k] ?? { fill: { type: 'solid', color: 'bg1' }, width: 1 };
        out.push(`<path d="M${n(e[0])} ${n(e[1])} L${n(e[2])} ${n(e[3])}"${strokeAttrs(ctx, ln)}/>`);
      });
      if (cell.text?.paras.some((p) => p.runs.some((r) => r.text))) {
        const el = { id: `${t.id}:${ri}:${ci}`, kind: 'shape' as const, geom: 'rect', text: { ...cell.text, anchor: cell.anchor || cell.text.anchor || 't', insets: cell.text.insets || [7.2, 3.6, 7.2, 3.6] as [number, number, number, number] } };
        const paras = headerText ? cell.text.paras.map((p) => ({ ...p, runs: p.runs.map((r) => ({ b: true, color: 'bg1', ...r })) })) : cell.text.paras;
        const { lay, body, rect } = layoutElementText(ctx.deck, owner, el as ShapeElement, cw, chH, paras.map((p) => ({ ...p, runs: p.runs.map((r) => ({ size: 18, ...r })) })));
        out.push(`<g transform="translate(${n(x)} ${n(y)})">${linesSvg(ctx, lay, body, rect, false)}</g>`);
      }
    });
    y += rh;
  });
  return out.join('');
}

function mediaSvg(ctx: Ctx, el: MediaElement, w: number, h: number): string {
  if (el.poster) return `<image href="${esc(ctx.deck.mediaUrl(el.poster))}" width="${n(w)}" height="${n(h)}" preserveAspectRatio="xMidYMid slice"/>`;
  const r = Math.min(w, h) * 0.18;
  const icon = el.mediaKind === 'audio'
    ? `<path d="M${n(w / 2 - r)} ${n(h / 2 - r / 2)} h${n(r * 0.6)} l${n(r * 0.8)} ${n(-r * 0.6)} v${n(r * 2.2)} l${n(-r * 0.8)} ${n(-r * 0.6)} h${n(-r * 0.6)} Z" fill="#fff"/>`
    : `<path d="M${n(w / 2 - r * 0.5)} ${n(h / 2 - r * 0.7)} L${n(w / 2 + r * 0.7)} ${n(h / 2)} L${n(w / 2 - r * 0.5)} ${n(h / 2 + r * 0.7)} Z" fill="#fff"/>`;
  return `<rect width="${n(w)}" height="${n(h)}" fill="#222" rx="4"/><circle cx="${n(w / 2)}" cy="${n(h / 2)}" r="${n(r * 1.2)}" fill="#0006"/>${icon}`;
}

/** Parses the markup into an element (for DOM use). */
export function svgElement(markup: string): SVGSVGElement {
  const t = document.createElement('template');
  t.innerHTML = markup;
  return t.content.firstElementChild as SVGSVGElement;
}

/** Plain text of a slide's title placeholder, for thumbnails, outline and navigation. */
export function slideTitle(slide: Slide): string {
  const t = slide.elements.find((e) => e.ph && (e.ph.type === 'title' || e.ph.type === 'ctrTitle')) as ShapeElement | undefined;
  return t?.text?.paras.map((p) => p.runs.map((r) => r.text).join('')).join(' ').trim() || '';
}

export type { Master };
