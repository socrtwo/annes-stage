/**
 * Animation timeline: compiles a slide's animation list into build steps, gives the static state
 * after any number of steps (thumbnails, presenter "next build", PDF per build step, HTML show), and
 * plays a step with the Web Animations API on a slide rendered by slideSvg(…, { ids: true }).
 *
 * Steps: steps[0] is the automatic group that starts when the slide appears (animations set to start
 * "with" or "after previous" before the first click); steps[1…] are one per click. stateAt(slide, n)
 * is the state after the first n steps have played, so stateAt(slide, 0) is the slide as it first
 * appears and stateAt(slide, steps.length) the fully built slide.
 */
import type { Animation, AnimClass, AnimEffect, Element as ModelElement, ShapeElement, Slide } from '../model/types';
import type { Deck } from '../model/deck';
import { slideSvg, type RenderOptions } from './slide';

export interface StepEffect {
  anim: Animation;
  /** Start offset in ms from the beginning of the step. */
  start: number;
  dur: number;
  /** For by-paragraph effects: the paragraph this effect animates. */
  para?: number;
}

export interface BuildStep { effects: StepEffect[]; /** Total length in ms. */ length: number }

export interface BuildState { hide: Set<string>; paraVisible: Map<string, Set<number>> }

export const EFFECTS: { cls: AnimClass; effect: AnimEffect; label: string; icon: string }[] = [
  { cls: 'entr', effect: 'appear', label: 'Appear', icon: 'visibility' },
  { cls: 'entr', effect: 'fade', label: 'Fade', icon: 'gradient' },
  { cls: 'entr', effect: 'fly', label: 'Fly In', icon: 'flight_land' },
  { cls: 'entr', effect: 'float', label: 'Float In', icon: 'air' },
  { cls: 'entr', effect: 'split', label: 'Split', icon: 'vertical_split' },
  { cls: 'entr', effect: 'wipe', label: 'Wipe', icon: 'swipe_right' },
  { cls: 'entr', effect: 'shape', label: 'Shape', icon: 'circle' },
  { cls: 'entr', effect: 'wheel', label: 'Wheel', icon: 'motion_photos_on' },
  { cls: 'entr', effect: 'randomBars', label: 'Random Bars', icon: 'view_week' },
  { cls: 'entr', effect: 'grow', label: 'Grow & Turn', icon: 'open_in_full' },
  { cls: 'entr', effect: 'zoom', label: 'Zoom', icon: 'zoom_in' },
  { cls: 'entr', effect: 'swivel', label: 'Swivel', icon: '360' },
  { cls: 'entr', effect: 'bounce', label: 'Bounce', icon: 'sports_basketball' },
  { cls: 'entr', effect: 'peek', label: 'Peek In', icon: 'north' },
  { cls: 'emph', effect: 'pulse', label: 'Pulse', icon: 'favorite' },
  { cls: 'emph', effect: 'colorPulse', label: 'Color Pulse', icon: 'palette' },
  { cls: 'emph', effect: 'teeter', label: 'Teeter', icon: 'swap_horiz' },
  { cls: 'emph', effect: 'spin', label: 'Spin', icon: 'rotate_right' },
  { cls: 'emph', effect: 'growShrink', label: 'Grow/Shrink', icon: 'zoom_out_map' },
  { cls: 'emph', effect: 'desaturate', label: 'Desaturate', icon: 'filter_b_and_w' },
  { cls: 'emph', effect: 'transparency', label: 'Transparency', icon: 'opacity' },
  { cls: 'emph', effect: 'boldFlash', label: 'Bold Flash', icon: 'format_bold' },
  { cls: 'exit', effect: 'appear', label: 'Disappear', icon: 'visibility_off' },
  { cls: 'exit', effect: 'fade', label: 'Fade Out', icon: 'gradient' },
  { cls: 'exit', effect: 'fly', label: 'Fly Out', icon: 'flight_takeoff' },
  { cls: 'exit', effect: 'float', label: 'Float Out', icon: 'air' },
  { cls: 'exit', effect: 'split', label: 'Split', icon: 'vertical_split' },
  { cls: 'exit', effect: 'wipe', label: 'Wipe', icon: 'swipe_left' },
  { cls: 'exit', effect: 'shape', label: 'Shape', icon: 'circle' },
  { cls: 'exit', effect: 'wheel', label: 'Wheel', icon: 'motion_photos_off' },
  { cls: 'exit', effect: 'randomBars', label: 'Random Bars', icon: 'view_week' },
  { cls: 'exit', effect: 'grow', label: 'Shrink & Turn', icon: 'close_fullscreen' },
  { cls: 'exit', effect: 'zoom', label: 'Zoom', icon: 'zoom_out' },
  { cls: 'exit', effect: 'swivel', label: 'Swivel', icon: '360' },
  { cls: 'exit', effect: 'bounce', label: 'Bounce', icon: 'sports_basketball' },
  { cls: 'exit', effect: 'peek', label: 'Peek Out', icon: 'south' },
  { cls: 'path', effect: 'line', label: 'Lines', icon: 'trending_flat' },
  { cls: 'path', effect: 'arc', label: 'Arcs', icon: 'redo' },
  { cls: 'path', effect: 'circle', label: 'Shapes (Circle)', icon: 'radio_button_unchecked' },
];

export function effectLabel(cls: AnimClass, effect: AnimEffect): string {
  return EFFECTS.find((e) => e.cls === cls && e.effect === effect)?.label || effect;
}

const CLS_LABEL: Record<AnimClass, string> = { entr: 'Entrance', exit: 'Exit', emph: 'Emphasis', path: 'Motion path' };
const TRIGGER_LABEL = { click: 'On Click', with: 'With Previous', after: 'After Previous' } as const;

/** One-line description for animation lists: "Fly In (Entrance) · On Click · 0.5 s". */
export function animationSummary(a: Animation, targetName?: string): string {
  const parts = [`${effectLabel(a.cls, a.effect)} (${CLS_LABEL[a.cls]})`];
  if (targetName) parts.unshift(targetName);
  parts.push(a.onShape ? 'Triggered by a shape' : TRIGGER_LABEL[a.trigger]);
  parts.push(`${((a.dur ?? defaultDur(a)) / 1000).toFixed(2).replace(/\.?0+$/, '')} s`);
  if (a.delay) parts.push(`delay ${(a.delay / 1000).toFixed(2).replace(/\.?0+$/, '')} s`);
  if (a.byPara) parts.push('by paragraph');
  if (a.dir) parts.push(`from ${({ l: 'left', r: 'right', u: 'top', d: 'bottom', in: 'inside', out: 'outside' } as const)[a.dir]}`);
  return parts.join(' · ');
}

export function defaultDur(a: Pick<Animation, 'effect' | 'cls'>): number {
  if (a.effect === 'appear') return 1;
  if (a.cls === 'path') return 2000;
  if (a.cls === 'emph') return a.effect === 'spin' ? 2000 : 1000;
  return 500;
}

function findEl(els: ModelElement[], id: string): ModelElement | undefined {
  for (const e of els) {
    if (e.id === id) return e;
    if (e.kind === 'group') { const f = findEl(e.children, id); if (f) return f; }
  }
  return undefined;
}

function paraCount(slide: Slide, id: string): number {
  const e = findEl(slide.elements, id) as ShapeElement | undefined;
  return e?.kind === 'shape' && e.text ? e.text.paras.length : 0;
}

/** Compiles the slide's animations into build steps (interactive-trigger animations are left out). */
export function buildSteps(slide: Slide): BuildStep[] {
  const steps: BuildStep[] = [{ effects: [], length: 0 }];
  let cur = steps[0];
  // End time of the previous effect and start time of the previous effect, within the current step.
  let prevStart = 0, prevEnd = 0;
  const anims = (slide.anims || []).filter((a) => !a.onShape && findEl(slide.elements, a.target));
  for (const a of anims) {
    const dur = a.dur ?? defaultDur(a);
    const delay = a.delay || 0;
    const n = a.byPara ? paraCount(slide, a.target) : 0;
    const units = a.byPara && n > 0 ? [...Array(n).keys()] : [undefined];
    units.forEach((para, k) => {
      let trigger = a.trigger;
      // By paragraph: on click each paragraph takes its own click; otherwise they play one after another.
      if (k > 0 && a.trigger !== 'click') trigger = 'after';
      if (trigger === 'click') {
        cur = { effects: [], length: 0 };
        steps.push(cur);
        prevStart = 0; prevEnd = 0;
      }
      const start = (trigger === 'after' ? prevEnd : trigger === 'with' ? prevStart : 0) + delay;
      cur.effects.push({ anim: a, start, dur, ...(para != null ? { para } : {}) });
      prevStart = start;
      prevEnd = start + dur;
      cur.length = Math.max(cur.length, prevEnd);
    });
  }
  return steps;
}

/** Number of clicks needed to build the slide fully. */
export function clickCount(slide: Slide): number { return buildSteps(slide).length - 1; }

/** Visibility of elements and paragraphs after the first n steps have played. */
export function stateAt(slide: Slide, n: number, steps = buildSteps(slide), o: { live?: boolean } = {}): BuildState {
  const hide = new Set<string>();
  const paraVisible = new Map<string, Set<number>>();
  const all = steps.flatMap((s) => s.effects);
  // Initial state: the first visibility-changing effect of each target decides.
  const seen = new Set<string>();
  for (const e of all) {
    const a = e.anim;
    if (a.cls !== 'entr' && a.cls !== 'exit') continue;
    if (a.byPara && e.para != null) {
      if (!paraVisible.has(a.target)) {
        const cnt = paraCount(slide, a.target);
        paraVisible.set(a.target, new Set(a.cls === 'entr' ? [] : [...Array(cnt).keys()]));
      }
      continue;
    }
    if (seen.has(a.target)) continue;
    seen.add(a.target);
    if (a.cls === 'entr') hide.add(a.target);
  }
  // Entrances started by clicking a shape (not part of the build steps) start hidden too: always in
  // a live show, and in static renders until the slide is fully built (print shows every object).
  if (o.live || n < steps.length) for (const a of slide.anims || []) {
    if (!a.onShape || seen.has(a.target)) continue;
    if (a.cls !== 'entr' && a.cls !== 'exit') continue;
    seen.add(a.target);
    if (a.cls === 'entr' && !paraVisible.has(a.target)) hide.add(a.target);
  }
  for (let i = 0; i < Math.min(n, steps.length); i++) {
    for (const e of [...steps[i].effects].sort((x, y) => x.start + x.dur - (y.start + y.dur))) applyEffect(e, hide, paraVisible);
  }
  return { hide, paraVisible };
}

function applyEffect(e: StepEffect, hide: Set<string>, paraVisible: Map<string, Set<number>>): void {
  const a = e.anim;
  if (a.cls !== 'entr' && a.cls !== 'exit') return;
  if (e.para != null && paraVisible.has(a.target)) {
    const set = paraVisible.get(a.target)!;
    if (a.cls === 'entr') set.add(e.para); else set.delete(e.para);
    return;
  }
  if (a.cls === 'entr') hide.delete(a.target); else hide.add(a.target);
}

/** Render options for a slide after n steps. */
export function renderStateOptions(slide: Slide, n: number): Pick<RenderOptions, 'hide' | 'paraVisible'> {
  const st = stateAt(slide, n);
  return { hide: st.hide, paraVisible: st.paraVisible };
}

// ------------------------------------------------------------------------------------------
// Live rendering and playback

const SVGNS = 'http://www.w3.org/2000/svg';

function parseSvg(markup: string): SVGSVGElement {
  const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
  // An XML error yields a <parsererror> document (a blank slide); fall back to the forgiving HTML parser.
  if (doc.documentElement.nodeName !== 'svg' || doc.getElementsByTagName('parsererror').length) {
    const t = document.createElement('template');
    t.innerHTML = markup;
    const el = t.content.querySelector('svg');
    if (el) return document.importNode(el, true) as unknown as SVGSVGElement;
  }
  return document.importNode(doc.documentElement, true) as unknown as SVGSVGElement;
}

/**
 * Ids of the slide's elements to hide so only `id` is drawn: top-level elements that neither are nor
 * contain it, plus the siblings of `id` (and of its ancestors) inside the groups that contain it.
 */
export function idsExcept(els: ModelElement[], id: string): Set<string> {
  const out = new Set<string>();
  const contains = (e: ModelElement): boolean => e.id === id || (e.kind === 'group' && e.children.some(contains));
  const walk = (list: ModelElement[]) => {
    for (const e of list) {
      if (e.id === id) continue;
      if (e.kind === 'group' && contains(e)) walk(e.children);
      else out.add(e.id);
    }
  };
  walk(els);
  return out;
}

/**
 * Renders a slide for animation: every element is drawn (each wrapped in a <g class="qs-anim">
 * whose CSS transform the effects animate), by-paragraph targets get one layer per paragraph, and
 * the visibility of the state after n steps is applied with CSS.
 */
export function renderAnimatedSlide(deck: Deck, slide: Slide, n: number, opts: RenderOptions = {}): SVGSVGElement {
  const steps = buildSteps(slide);
  const byPara = new Set(steps.flatMap((s) => s.effects).filter((e) => e.para != null).map((e) => e.anim.target));
  const blankParas = new Map<string, Set<number>>();
  for (const id of byPara) blankParas.set(id, new Set());
  const svg = parseSvg(slideSvg(deck, slide, { ...opts, mode: 'show', ids: true, paraVisible: blankParas }));
  const defs = svg.querySelector('defs')!;
  // Paragraph layers: render the slide with only that paragraph of that element and lift it out.
  for (const id of byPara) {
    const el = svg.querySelector(`g[data-id="${cssEsc(id)}"]`);
    if (!el) continue;
    const count = paraCount(slide, id);
    let after: Element | ChildNode = el;
    for (let p = 0; p < count; p++) {
      const others = idsExcept(slide.elements, id);
      const layerSvg = parseSvg(slideSvg(deck, slide, { ...opts, mode: 'show', ids: true, hide: others, paraVisible: new Map([[id, new Set([p])]]), ink: false }));
      const g = layerSvg.querySelector(`g[data-id="${cssEsc(id)}"]`);
      if (!g) continue;
      // Keep only the text of the layer (the shape itself is drawn by the element).
      for (const child of [...g.children]) if (!child.classList.contains('qs-text')) child.remove();
      for (const d of [...layerSvg.querySelector('defs')!.children]) defs.appendChild(d);
      g.setAttribute('data-para', String(p));
      (after as Element).after(g);
      after = g;
    }
  }
  wrapAnimatable(svg);
  applyState(svg, stateAt(slide, n, steps, { live: true }));
  return svg;
}

/** Wraps each element group in a <g class="qs-anim"> so CSS transforms do not replace its transform. */
export function wrapAnimatable(svg: SVGSVGElement): void {
  for (const g of [...svg.querySelectorAll('g[data-id]')]) {
    if ((g.parentNode as Element)?.classList?.contains('qs-anim')) continue;
    const w = document.createElementNS(SVGNS, 'g');
    w.setAttribute('class', 'qs-anim');
    w.setAttribute('data-for', g.getAttribute('data-id')! + (g.hasAttribute('data-para') ? `#${g.getAttribute('data-para')}` : ''));
    (w as SVGGElement).style.transformBox = 'fill-box';
    (w as SVGGElement).style.transformOrigin = 'center';
    g.replaceWith(w);
    w.appendChild(g);
  }
}

function cssEsc(s: string): string { return s.replace(/["\\]/g, '\\$&'); }

function wrapperFor(svg: SVGSVGElement, id: string, para?: number): SVGGElement | null {
  return svg.querySelector(`g.qs-anim[data-for="${cssEsc(id + (para != null ? `#${para}` : ''))}"]`);
}

export function applyState(svg: SVGSVGElement, st: BuildState): void {
  for (const w of svg.querySelectorAll<SVGGElement>('g.qs-anim')) {
    const key = w.getAttribute('data-for')!;
    const [id, para] = key.split('#');
    let visible = !st.hide.has(id);
    if (para != null) visible = visible && !!st.paraVisible.get(id)?.has(+para);
    w.style.visibility = visible ? '' : 'hidden';
  }
}

export function reducedMotion(): boolean {
  try { return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

type KF = Keyframe[];

function entranceFrames(a: Animation, W: number, H: number): KF {
  const d = a.dir || (a.effect === 'fly' ? 'd' : a.effect === 'float' ? 'd' : 'l');
  const off = (k: number) => (d === 'l' ? `translate(${-W * k}px,0)` : d === 'r' ? `translate(${W * k}px,0)` : d === 'u' ? `translate(0,${-H * k}px)` : `translate(0,${H * k}px)`);
  switch (a.effect) {
    case 'appear': return [{ opacity: 1 }, { opacity: 1 }];
    case 'fade': return [{ opacity: 0 }, { opacity: 1 }];
    case 'fly': return [{ transform: off(1), opacity: 1 }, { transform: 'none', opacity: 1 }];
    case 'float': return [{ transform: off(0.08), opacity: 0 }, { transform: 'none', opacity: 1 }];
    case 'peek': return [{ transform: off(0.15), clipPath: 'inset(0 0 100% 0)' }, { transform: 'none', clipPath: 'inset(0 0 0 0)' }];
    case 'wipe': {
      const from = d === 'l' ? 'inset(0 100% 0 0)' : d === 'r' ? 'inset(0 0 0 100%)' : d === 'u' ? 'inset(0 0 100% 0)' : 'inset(100% 0 0 0)';
      return [{ clipPath: from }, { clipPath: 'inset(0 0 0 0)' }];
    }
    case 'split': return [{ clipPath: a.dir === 'u' || a.dir === 'd' ? 'inset(50% 0 50% 0)' : 'inset(0 50% 0 50%)' }, { clipPath: 'inset(0 0 0 0)' }];
    case 'shape': return [{ clipPath: 'circle(0% at 50% 50%)' }, { clipPath: 'circle(75% at 50% 50%)' }];
    case 'wheel': return [{ clipPath: 'polygon(50% 50%, 50% 0, 50% 0, 50% 0, 50% 0, 50% 0)' }, { clipPath: 'polygon(50% 50%, 50% 0, 100% 0, 100% 100%, 0 100%, 0 0)' }];
    case 'randomBars': return [{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 0.3, offset: 0.4 }, { opacity: 1, offset: 0.6 }, { opacity: 1 }];
    case 'grow': return [{ transform: 'scale(0.1) rotate(-90deg)', opacity: 0 }, { transform: 'none', opacity: 1 }];
    case 'zoom': return [{ transform: 'scale(0)', opacity: 0 }, { transform: 'none', opacity: 1 }];
    case 'swivel': return [{ transform: 'perspective(800px) rotateY(90deg)', opacity: 0 }, { transform: 'perspective(800px) rotateY(0deg)', opacity: 1 }];
    case 'bounce': return [{ transform: `translate(0,${-H * 0.6}px)`, opacity: 0, easing: 'ease-in' }, { transform: 'none', opacity: 1, offset: 0.5, easing: 'ease-out' }, { transform: `translate(0,${-H * 0.08}px)`, offset: 0.7, easing: 'ease-in' }, { transform: 'none', offset: 0.85, easing: 'ease-out' }, { transform: `translate(0,${-H * 0.02}px)`, offset: 0.93 }, { transform: 'none' }];
    default: return [{ opacity: 0 }, { opacity: 1 }];
  }
}

function emphasisFrames(a: Animation): KF {
  const amt = a.amount;
  switch (a.effect) {
    case 'pulse': return [{ transform: 'scale(1)' }, { transform: 'scale(1.08)' }, { transform: 'scale(1)' }];
    case 'spin': return [{ transform: 'rotate(0deg)' }, { transform: `rotate(${amt ?? 360}deg)` }];
    case 'growShrink': return [{ transform: 'scale(1)' }, { transform: `scale(${(amt ?? 150) / 100})` }];
    case 'teeter': return [{ transform: 'rotate(0)' }, { transform: 'rotate(4deg)' }, { transform: 'rotate(-4deg)' }, { transform: 'rotate(4deg)' }, { transform: 'rotate(-4deg)' }, { transform: 'rotate(0)' }];
    case 'transparency': return [{ opacity: 1 }, { opacity: (amt ?? 50) / 100 }];
    case 'colorPulse': return [{ filter: 'none' }, { filter: 'hue-rotate(90deg) saturate(2)' }, { filter: 'none' }];
    case 'boldFlash': return [{ filter: 'none' }, { filter: 'drop-shadow(0 0 2px currentColor) brightness(1.3)' }, { filter: 'none' }];
    case 'desaturate': return [{ filter: 'saturate(1)' }, { filter: 'saturate(0)' }];
    default: return [{ transform: 'scale(1)' }, { transform: 'scale(1.05)' }, { transform: 'scale(1)' }];
  }
}

/** Points of a motion path in slide points, relative to the element's starting position. */
export function motionPoints(a: Animation, W: number, H: number, samples = 24): [number, number][] {
  const pts: [number, number][] = [];
  if (a.path && typeof document !== 'undefined') {
    try {
      const p = document.createElementNS(SVGNS, 'path') as SVGPathElement;
      p.setAttribute('d', a.path);
      const len = p.getTotalLength();
      for (let i = 0; i <= samples; i++) { const q = p.getPointAtLength((len * i) / samples); pts.push([q.x * W, q.y * H]); }
      if (pts.length) { const [x0, y0] = pts[0]; return pts.map(([x, y]) => [x - x0, y - y0]); }
    } catch { /* fall through to presets */ }
  }
  const dx = a.dir === 'l' ? -1 : a.dir === 'u' || a.dir === 'd' ? 0 : 1;
  const dy = a.dir === 'u' ? -1 : a.dir === 'd' ? 1 : 0;
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    if (a.effect === 'circle') { const ang = t * Math.PI * 2; pts.push([Math.sin(ang) * W * 0.1, (1 - Math.cos(ang)) * H * -0.1]); }
    else if (a.effect === 'arc') pts.push([t * W * 0.25 * (dx || 1), -Math.sin(t * Math.PI) * H * 0.15 + t * dy * H * 0.25]);
    else pts.push([t * W * 0.25 * dx, t * H * 0.25 * dy]);
  }
  return pts;
}

export interface PlayOptions {
  /** Slide size in points (for fly distances). */
  size?: { w: number; h: number };
  /** Speed factor (2 = twice as fast). */
  speed?: number;
  reduced?: boolean;
}

/** Plays one build step on a slide rendered by renderAnimatedSlide. Resolves when it ends. */
export async function playStep(svg: SVGSVGElement, step: BuildStep, opts: PlayOptions = {}): Promise<void> {
  const W = opts.size?.w ?? svg.viewBox.baseVal?.width ?? 960;
  const H = opts.size?.h ?? svg.viewBox.baseVal?.height ?? 540;
  const speed = opts.speed || 1;
  const instant = opts.reduced ?? reducedMotion();
  const running: Promise<void>[] = [];
  for (const e of step.effects) {
    const a = e.anim;
    const w = wrapperFor(svg, a.target, e.para);
    const targets = w ? [w] : e.para == null ? [...svg.querySelectorAll<SVGGElement>(`g.qs-anim[data-for^="${cssEsc(a.target)}#"]`)] : [];
    if (!targets.length) continue;
    const delay = e.start / speed, dur = Math.max(1, e.dur / speed);
    for (const t of targets) running.push(playOne(t, a, delay, dur, W, H, instant));
  }
  await Promise.all(running);
}

function playOne(t: SVGGElement, a: Animation, delay: number, dur: number, W: number, H: number, instant: boolean): Promise<void> {
  const finish = () => {
    if (a.cls === 'entr') t.style.visibility = '';
    if (a.cls === 'exit') t.style.visibility = 'hidden';
    if (a.cls === 'path') {
      const pts = motionPoints(a, W, H);
      const [x, y] = pts[pts.length - 1];
      t.style.transform = `translate(${x}px,${y}px)`;
    }
  };
  if (instant || typeof t.animate !== 'function' || (a.effect === 'appear' && a.cls !== 'path')) {
    return new Promise((res) => setTimeout(() => { finish(); res(); }, instant ? 0 : delay));
  }
  let frames: KF;
  if (a.cls === 'entr') frames = entranceFrames(a, W, H);
  else if (a.cls === 'exit') frames = entranceFrames(a, W, H).reverse().map((f, i, arr) => ({ ...f, offset: arr.length > 1 ? i / (arr.length - 1) : undefined }));
  else if (a.cls === 'path') {
    const pts = motionPoints(a, W, H);
    frames = pts.map(([x, y]) => ({ transform: `translate(${x}px,${y}px)` }));
  } else frames = emphasisFrames(a);
  if (a.cls === 'entr') t.style.visibility = '';
  const anim = t.animate(frames, { duration: dur, delay, fill: 'both', easing: a.cls === 'path' ? 'ease-in-out' : 'ease-out', iterations: Math.max(1, a.repeat || 1) });
  return anim.finished.then(() => {
    finish();
    // Emphasis returns to the resting state except lasting changes (transparency, desaturate).
    if (a.cls === 'emph' && (a.effect === 'transparency' || a.effect === 'desaturate' || a.effect === 'growShrink' || a.effect === 'spin')) {
      const last = frames[frames.length - 1] as any;
      if (last.opacity != null) t.style.opacity = String(last.opacity);
      if (last.filter) t.style.filter = last.filter;
      if (last.transform && a.effect !== 'spin') t.style.transform = last.transform;
    }
    anim.cancel();
  }, () => { finish(); });
}
