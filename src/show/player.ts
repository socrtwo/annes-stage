/**
 * Slide show player: full screen over the app (or in an audience window), with builds, transitions,
 * timings, links, media, ink, laser pointer, overview grid, zoom, black/white screens, live
 * subtitles (where the platform offers speech recognition) and rehearsal timings.
 */
import type { App } from '../app';
import type { Deck } from '../model/deck';
import type { Element as ModelElement, MediaElement, Slide } from '../model/types';
import { resolveBox } from '../model/inherit';
import { slideSvg } from '../render/slide';
import { buildSteps, playStep, renderAnimatedSlide, reducedMotion, type BuildStep } from '../render/animate';
import { runTransition } from '../render/transitions';
import { keepAwake } from '../platform/native';
import { confirmDialog, toast } from '../ui/dialog';
import showCss from '../styles/show.css?inline';

export interface ShowOptions {
  /** Index into the deck's slides to start from. */
  from?: number;
  slideId?: string;
  customShow?: string;
  rehearse?: boolean;
  presenter?: boolean;
  kiosk?: boolean;
  loop?: boolean;
  /** Window that shows the audience view (default: this window). */
  window?: Window;
  /** Do not take the browser full screen (audience windows place themselves). */
  noFullscreen?: boolean;
  /** Keyboard events also come from these windows (the presenter's). */
  keyWindows?: Window[];
}

export type ShowEvent = 'slide' | 'step' | 'end' | 'ink' | 'screen' | 'tool' | 'laser';
export type Tool = 'none' | 'pen' | 'highlighter' | 'laser' | 'eraser';
export interface InkStroke { d: string; color: string; width: number; highlighter?: boolean }

export interface ShowController {
  next(): void;
  prev(): void;
  goto(index: number): void;
  /** Goes to a position in the show's order (custom shows can play a slide more than once). */
  gotoPos(pos: number): void;
  end(): void;
  black(): void;
  white(): void;
  /** Index (into the deck's slides) of the slide on screen. */
  readonly index: number;
  /** Build steps played on the current slide, and how many there are. */
  readonly step: number;
  readonly stepCount: number;
  /** The slides this show plays, in order (deck indexes). */
  readonly order: number[];
  /** Position of the current slide in order. */
  readonly pos: number;
  readonly screen: 'normal' | 'black' | 'white';
  readonly tool: Tool;
  setTool(t: Tool): void;
  addInk(slideId: string, s: InkStroke): void;
  clearInk(): void;
  laser(x: number | null, y?: number): void;
  inkFor(slideId: string): InkStroke[];
  on(ev: ShowEvent, fn: (...args: any[]) => void): () => void;
  readonly ended: boolean;
}

let active: Show | null = null;

/** The running show, if any. */
export function currentShow(): ShowController | null { return active; }

export function startShow(app: App, opts: ShowOptions = {}): ShowController {
  if (active) active.end();
  if (app.tab.ui?.editingText) app.tab.ui.commitText();
  active = new Show(app, opts);
  return active;
}

const KEYS_HELP: [string, string][] = [
  ['N, Space, Right, Down, Enter, Page Down, click', 'Next animation or slide'],
  ['P, Backspace, Left, Up, Page Up', 'Previous animation or slide'],
  ['Number + Enter', 'Go to that slide'],
  ['Home / End', 'First / last slide'],
  ['B or .', 'Black screen (again to return)'],
  ['W or ,', 'White screen (again to return)'],
  ['G, Ctrl+S, -', 'See all slides'],
  ['Z', 'Zoom: click a point to zoom in, Z or Esc to zoom out'],
  ['Ctrl+P / Ctrl+I', 'Pen / highlighter'],
  ['Ctrl+L', 'Laser pointer'],
  ['Ctrl+A', 'Arrow (stop drawing)'],
  ['E', 'Erase the ink on this slide'],
  ['Ctrl+M', 'Show or hide ink'],
  ['S', 'Stop or resume automatic advance'],
  ['J', 'Live subtitles on/off (where supported)'],
  ['? or F1', 'This help'],
  ['Esc', 'End the show'],
];

class Show implements ShowController {
  readonly app: App;
  readonly deck: Deck;
  readonly win: Window;
  readonly doc: Document;
  order: number[] = [];
  pos = 0;
  step = 0;
  steps: BuildStep[] = [];
  screen: 'normal' | 'black' | 'white' = 'normal';
  tool: Tool = 'none';
  ended = false;
  private root!: HTMLElement;
  private stage!: HTMLElement;
  private layer: HTMLElement | null = null;
  private inkSvg!: SVGSVGElement;
  private laserDot!: HTMLElement;
  private screenEl!: HTMLElement;
  private toolbar!: HTMLElement;
  private subtitleEl!: HTMLElement;
  private busy = false;
  private atEnd = false;
  private numBuf = '';
  /** Detaches the listeners of a pen stroke in progress. */
  private drawCleanup: (() => void) | null = null;
  private autoTimer: any = null;
  private paused = false;
  private inkVisible = true;
  private ink = new Map<string, InkStroke[]>();
  private listeners = new Map<ShowEvent, Set<(...a: any[]) => void>>();
  private cleanups: (() => void)[] = [];
  private media: HTMLMediaElement[] = [];
  private zoomed = false;
  private zoomMode = false;
  private rehearse: { slideStart: number; times: Map<string, number> } | null = null;
  private recog: any = null;
  private hideTimer: any = null;
  private overlay: HTMLElement | null = null;
  private opts: ShowOptions;

  constructor(app: App, opts: ShowOptions) {
    this.app = app;
    this.deck = app.deck;
    this.opts = opts;
    this.win = opts.window || window;
    this.doc = this.win.document;
    const settings = this.deck.data.show || {};
    const slides = this.deck.slides;
    const custom = this.deck.data.customShows.find((c) => c.id === (opts.customShow || settings.customShow));
    if (custom) this.order = custom.slides.map((id) => this.deck.slideIndex(id)).filter((i) => i >= 0);
    else {
      const from = Math.max(1, settings.from || 1) - 1, to = Math.min(slides.length, settings.to || slides.length) - 1;
      for (let i = from; i <= to; i++) this.order.push(i);
    }
    if (!this.order.length) this.order = slides.map((_, i) => i);
    if (opts.rehearse) this.rehearse = { slideStart: performance.now(), times: new Map() };
    this.build();
    let startIdx = opts.slideId ? this.deck.slideIndex(opts.slideId) : opts.from ?? 0;
    let p = this.order.indexOf(startIdx);
    if (p < 0) p = this.order.findIndex((i) => i >= startIdx);
    if (p < 0) p = 0;
    // Start on the first visible slide unless the start was chosen explicitly.
    if (opts.slideId == null) while (p < this.order.length - 1 && this.isHidden(p)) p++;
    void keepAwake(true);
    void this.show(p, { transition: false });
  }

  get index(): number { return this.order[this.pos] ?? 0; }
  get stepCount(): number { return this.steps.length; }
  get slide(): Slide | undefined { return this.deck.slides[this.index]; }
  private get loop(): boolean { return !!(this.opts.loop ?? this.deck.data.show?.loop ?? this.opts.kiosk ?? this.deck.data.show?.kiosk); }
  private get kiosk(): boolean { return !!(this.opts.kiosk ?? this.deck.data.show?.kiosk); }
  private isHidden(p: number): boolean { return !!this.deck.slides[this.order[p]]?.hidden; }

  on(ev: ShowEvent, fn: (...args: any[]) => void): () => void {
    if (!this.listeners.has(ev)) this.listeners.set(ev, new Set());
    this.listeners.get(ev)!.add(fn);
    return () => this.listeners.get(ev)?.delete(fn);
  }
  private emit(ev: ShowEvent, ...args: any[]): void { for (const fn of this.listeners.get(ev) || []) { try { fn(...args); } catch (e) { console.error(e); } } }

  // ------------------------------------------------------------------------------------------
  // DOM

  private el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
    const e = this.doc.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  private build(): void {
    const d = this.doc;
    if (!d.getElementById('qs-show-css')) {
      const st = d.createElement('style');
      st.id = 'qs-show-css';
      st.textContent = showCss;
      d.head.appendChild(st);
    }
    const { w, h } = this.deck.size;
    this.root = this.el('div', 'qs-show');
    this.root.tabIndex = -1;
    this.root.setAttribute('role', 'application');
    this.root.setAttribute('aria-label', 'Slide show');
    this.root.style.setProperty('--qs-ratio', String(w / h));
    this.stage = this.el('div', 'qs-stage');
    this.inkSvg = d.createElementNS('http://www.w3.org/2000/svg', 'svg') as SVGSVGElement;
    this.inkSvg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    this.inkSvg.setAttribute('class', 'qs-ink');
    this.inkSvg.setAttribute('preserveAspectRatio', 'none');
    this.laserDot = this.el('div', 'qs-laser');
    this.laserDot.style.background = this.app.prefs.laserColor || '#FF1744';
    this.stage.append(this.inkSvg, this.laserDot);
    this.screenEl = this.el('div', 'qs-screen');
    this.subtitleEl = this.el('div', 'qs-subtitles');
    this.subtitleEl.setAttribute('aria-live', 'polite');
    this.toolbar = this.buildToolbar();
    this.root.append(this.stage, this.screenEl, this.subtitleEl, this.toolbar);
    d.body.appendChild(this.root);
    if (!this.opts.noFullscreen) {
      try { const p = this.root.requestFullscreen?.(); if (p) p.catch(() => undefined); } catch { /* not allowed */ }
    }
    // Leaving full screen with the browser's own Esc (which never reaches onKey) ends the show.
    let wasFull = false;
    this.listen(this.doc, 'fullscreenchange', () => {
      if (this.doc.fullscreenElement) { wasFull = true; return; }
      if (wasFull && !this.ended) this.end();
    });
    this.root.focus();
    this.listen(this.doc, 'keydown', (e) => this.onKey(e as KeyboardEvent), true);
    for (const kw of this.opts.keyWindows || []) if (kw !== this.win) this.listen(kw.document, 'keydown', (e) => this.onKey(e as KeyboardEvent), true);
    this.listen(this.stage, 'pointerdown', (e) => this.onPointerDown(e as PointerEvent));
    this.listen(this.root, 'pointermove', (e) => this.onMove(e as PointerEvent));
    this.listen(this.root, 'contextmenu', (e) => { e.preventDefault(); this.menu(); });
    this.listen(this.screenEl, 'click', () => this.setScreen('normal'));
    this.listen(this.win, 'resize', () => this.layoutMedia());
    // Touch swipes.
    let sx = 0, sy = 0, st = 0, lp: any = null;
    this.listen(this.stage, 'touchstart', (e) => { const t = (e as TouchEvent).touches[0]; sx = t.clientX; sy = t.clientY; st = Date.now(); lp = setTimeout(() => { lp = 'fired'; this.menu(); }, 650); }, false);
    this.listen(this.stage, 'touchmove', () => { if (lp !== 'fired') clearTimeout(lp); }, false);
    this.listen(this.stage, 'touchend', (e) => {
      if (lp !== 'fired') clearTimeout(lp);
      if (this.tool !== 'none') return;
      const t = (e as TouchEvent).changedTouches[0];
      const dx = t.clientX - sx, dy = t.clientY - sy;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) && Date.now() - st < 800) { e.preventDefault(); if (dx < 0) this.next(); else this.prev(); }
      else if (Math.abs(dx) < 12 && Math.abs(dy) < 12 && lp !== 'fired') { e.preventDefault(); if (this.zoomMode || this.zoomed) { if (this.zoomMode) this.zoomAt(t.clientX, t.clientY); else this.unzoom(); } else this.tap(e.target as Element); }
    }, false);
    this.showToolbar();
  }

  private listen(t: EventTarget, ev: string, fn: (e: Event) => void, capture: boolean | AddEventListenerOptions = false): void {
    t.addEventListener(ev, fn, capture);
    this.cleanups.push(() => t.removeEventListener(ev, fn, capture));
  }

  private buildToolbar(): HTMLElement {
    const bar = this.el('div', 'qs-toolbar');
    bar.setAttribute('role', 'toolbar');
    const btn = (icon: string, label: string, fn: (b: HTMLElement) => void) => {
      const b = this.el('button', 'qs-tb-btn');
      b.type = 'button';
      b.title = label;
      b.setAttribute('aria-label', label);
      b.appendChild(this.el('span', 'material-symbols-outlined', icon));
      b.addEventListener('click', (e) => { e.stopPropagation(); fn(b); });
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
      bar.appendChild(b);
      return b;
    };
    btn('arrow_back', 'Previous (P)', () => this.prev());
    btn('arrow_forward', 'Next (N)', () => this.next());
    btn('edit', 'Pen (Ctrl+P)', () => this.setTool(this.tool === 'pen' ? 'none' : 'pen'));
    btn('ink_highlighter', 'Highlighter (Ctrl+I)', () => this.setTool(this.tool === 'highlighter' ? 'none' : 'highlighter'));
    btn('flare', 'Laser pointer (Ctrl+L)', () => this.setTool(this.tool === 'laser' ? 'none' : 'laser'));
    btn('ink_eraser', 'Erase ink on this slide (E)', () => this.clearInk());
    btn('grid_view', 'See all slides (G)', () => this.overview());
    btn('zoom_in', 'Zoom into the slide (Z)', () => this.toggleZoomMode());
    btn('closed_caption', 'Live subtitles (J)', () => this.toggleSubtitles());
    btn('more_horiz', 'More', () => this.menu());
    btn('close', 'End show (Esc)', () => this.end());
    const counter = this.el('span', 'qs-tb-count');
    bar.appendChild(counter);
    return bar;
  }

  private showToolbar(): void {
    this.root.classList.add('qs-show-ui');
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => this.root.classList.remove('qs-show-ui'), 2500);
  }

  // ------------------------------------------------------------------------------------------
  // Navigation

  private async show(p: number, o: { transition?: boolean; built?: boolean } = {}): Promise<void> {
    if (this.ended) return;
    this.recordRehearsal();
    this.clearAuto();
    this.stopMedia();
    if (this.atEnd) {
      this.atEnd = false;
      this.screenEl.className = 'qs-screen' + (this.screen === 'normal' ? '' : ` qs-on qs-${this.screen}`);
      this.screenEl.textContent = '';
      this.screenEl.onclick = null;
    }
    const prevSlide = this.slide;
    this.pos = Math.max(0, Math.min(this.order.length - 1, p));
    const slide = this.slide;
    if (!slide) { this.end(); return; }
    this.steps = buildSteps(slide);
    const animate = this.deck.data.show?.showAnimation !== false;
    const startStep = o.built || !animate ? this.steps.length : 0;
    const svg = renderAnimatedSlide(this.deck, slide, startStep, { number: this.index + (this.deck.data.firstNumber ?? 1), ink: false });
    const layer = this.el('div', 'qs-layer');
    layer.appendChild(svg);
    this.stage.insertBefore(layer, this.inkSvg);
    const outgoing = this.layer;
    this.layer = layer;
    this.drawInk();
    this.updateCounter();
    // Listeners read step on 'slide', so it must already describe the new slide.
    this.step = startStep;
    this.emit('slide', this.index, this.pos);
    this.busy = true;
    try {
      if (outgoing && o.transition !== false && animate !== false) {
        await runTransition(this.stage, outgoing, layer, slide.transition, prevSlide ? { deck: this.deck, from: prevSlide, to: slide } : undefined);
      }
    } finally {
      outgoing?.remove();
      this.busy = false;
    }
    if (this.ended || this.layer !== layer) return;
    this.mountMedia(slide);
    this.step = startStep;
    if (this.step === 0) {
      this.step = 1;
      if (this.steps[0].effects.length) await this.play(this.steps[0]);
    }
    this.emit('step', this.step, this.steps.length);
    this.scheduleAuto();
  }

  private async play(step: BuildStep): Promise<void> {
    if (!this.layer) return;
    const svg = this.layer.querySelector('svg') as SVGSVGElement;
    this.busy = true;
    try { await playStep(svg, step, { size: this.deck.size, reduced: reducedMotion() }); }
    finally { this.busy = false; }
  }

  /** Finishes running animations at once (a click during an animation). */
  private finishRunning(): boolean {
    if (!this.busy || !this.layer) return false;
    for (const a of (this.stage as any).getAnimations?.({ subtree: true }) || []) { try { a.finish(); } catch { /* */ } }
    return true;
  }

  next(): void {
    if (this.ended) return;
    if (this.screen !== 'normal') { this.setScreen('normal'); return; }
    if (this.finishRunning()) return;
    if (this.atEnd) { this.end(); return; }
    if (this.step < this.steps.length) {
      const s = this.steps[this.step++];
      void this.play(s).then(() => { this.emit('step', this.step, this.steps.length); this.scheduleAuto(); });
      this.emit('step', this.step, this.steps.length);
      return;
    }
    let p = this.pos + 1;
    while (p < this.order.length && this.isHidden(p)) p++;
    if (p >= this.order.length) {
      if (this.loop) { p = 0; while (p < this.order.length - 1 && this.isHidden(p)) p++; void this.show(p); return; }
      if (this.app.prefs.showEndBlack && !this.kiosk) { this.endScreen(); return; }
      this.end();
      return;
    }
    void this.show(p);
  }

  prev(): void {
    if (this.ended) return;
    if (this.screen !== 'normal') { this.setScreen('normal'); return; }
    if (this.atEnd) { this.atEnd = false; this.screenEl.className = 'qs-screen'; this.screenEl.textContent = ''; return; }
    this.finishRunning();
    if (this.step > 1 && this.slide) {
      // Back one build: redraw the state before the last step.
      this.step--;
      const svg = renderAnimatedSlide(this.deck, this.slide, this.step, { number: this.index + (this.deck.data.firstNumber ?? 1), ink: false });
      this.layer!.replaceChildren(svg);
      this.emit('step', this.step, this.steps.length);
      return;
    }
    let p = this.pos - 1;
    while (p >= 0 && this.isHidden(p)) p--;
    if (p < 0) { if (this.loop) p = this.order.length - 1; else return; }
    void this.show(p, { transition: false, built: true });
  }

  goto(index: number): void {
    // A slide can appear more than once in a custom show: prefer the next occurrence from here.
    let p = -1;
    for (let k = 0; k < this.order.length && p < 0; k++) { const q = (this.pos + 1 + k) % this.order.length; if (this.order[q] === index) p = q; }
    if (this.order[this.pos] === index && p !== this.pos) p = this.pos;
    if (p < 0) {
      // A slide outside the custom show or range: play it anyway (hidden slides are reachable this way).
      if (index < 0 || index >= this.deck.slides.length) return;
      this.order.splice(this.pos + 1, 0, index);
      p = this.pos + 1;
    }
    this.setScreen('normal');
    void this.show(p);
  }

  gotoPos(pos: number): void {
    if (this.ended || pos < 0 || pos >= this.order.length) return;
    this.setScreen('normal');
    void this.show(pos);
  }

  private endScreen(): void {
    this.atEnd = true;
    this.clearAuto();
    this.screenEl.className = 'qs-screen qs-black qs-on qs-endscreen';
    this.screenEl.textContent = 'End of slide show, click to exit.';
    this.screenEl.onclick = () => this.end();
  }

  // The end screen is already black; blanking it would hide the "click to exit" prompt.
  black(): void { if (this.atEnd) return; this.setScreen(this.screen === 'black' ? 'normal' : 'black'); }
  white(): void { if (this.atEnd) return; this.setScreen(this.screen === 'white' ? 'normal' : 'white'); }

  private setScreen(s: 'normal' | 'black' | 'white'): void {
    if (this.atEnd && s === 'normal') return;
    const was = this.screen;
    this.screen = s;
    // A blank screen pauses automatic advance; returning resumes it.
    if (s !== 'normal') this.clearAuto();
    else if (was !== 'normal' && !this.busy) this.scheduleAuto();
    this.screenEl.onclick = null;
    this.screenEl.textContent = '';
    this.screenEl.className = 'qs-screen' + (s === 'normal' ? '' : ` qs-on qs-${s}`);
    this.emit('screen', s);
  }

  // ------------------------------------------------------------------------------------------
  // Timings

  private scheduleAuto(): void {
    this.clearAuto();
    const t = this.slide?.transition;
    if (this.paused || this.rehearse || this.deck.data.show?.useTimings === false) return;
    if (t?.advAfter == null) return;
    if (this.step < this.steps.length) {
      // Timed shows also advance the remaining builds; spread them over the slide time.
      this.autoTimer = setTimeout(() => this.next(), Math.max(50, t.advAfter / (this.steps.length - this.step + 1)));
      return;
    }
    this.autoTimer = setTimeout(() => this.next(), Math.max(0, t.advAfter));
  }

  private clearAuto(): void { clearTimeout(this.autoTimer); this.autoTimer = null; }

  private togglePause(): void {
    this.paused = !this.paused;
    if (this.paused) this.clearAuto(); else this.scheduleAuto();
    toastIn(this.doc, this.paused ? 'Automatic advance paused (S to resume)' : 'Automatic advance resumed');
  }

  private recordRehearsal(): void {
    if (!this.rehearse || !this.slide || this.layer == null) return;
    const now = performance.now();
    const id = this.slide.id;
    this.rehearse.times.set(id, (this.rehearse.times.get(id) || 0) + (now - this.rehearse.slideStart));
    this.rehearse.slideStart = now;
  }

  /** Seconds spent on each slide so far (rehearsal). */
  rehearsalTimes(): Map<string, number> { return this.rehearse?.times || new Map(); }

  // ------------------------------------------------------------------------------------------
  // Input

  private onKey(e: KeyboardEvent): void {
    if (this.ended) return;
    if (this.overlay) {
      if (e.key === 'Escape' || e.key === '?' || e.key === 'F1' || ((e.key === 'g' || e.key === 'G') && this.overlay.classList.contains('qs-grid'))) { e.preventDefault(); e.stopPropagation(); this.closeOverlay(); }
      return;
    }
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && !this.root.contains(t)) return;
    const k = e.key;
    const ctrl = e.ctrlKey || e.metaKey;
    let handled = true;
    // Any other key (but a bare modifier) abandons a slide number being typed.
    if (this.numBuf && !(/^\d$/.test(k) && !ctrl) && k !== 'Enter' && !['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock'].includes(k)) this.numBuf = '';
    if (/^\d$/.test(k) && !ctrl) { this.numBuf += k; toastIn(this.doc, `Go to slide ${this.numBuf}…`); }
    else if (k === 'Enter' && this.numBuf) { const n = parseInt(this.numBuf, 10) - 1; this.numBuf = ''; this.goto(n); }
    else if (ctrl && (k === 'p' || k === 'P')) this.setTool('pen');
    else if (ctrl && (k === 'i' || k === 'I')) this.setTool('highlighter');
    else if (ctrl && (k === 'l' || k === 'L')) this.setTool('laser');
    else if (ctrl && (k === 'a' || k === 'A')) this.setTool('none');
    else if (ctrl && (k === 'm' || k === 'M')) { this.inkVisible = !this.inkVisible; this.drawInk(); }
    else if (ctrl && (k === 's' || k === 'S')) this.overview();
    else if (ctrl && (k === 'h' || k === 'H')) this.root.classList.toggle('qs-nocursor');
    else if (ctrl) handled = false;
    else if (this.kiosk && !['Escape', 'Home', 'End'].includes(k)) handled = false;
    else if (['ArrowRight', 'ArrowDown', ' ', 'n', 'N', 'Enter', 'PageDown'].includes(k)) this.next();
    else if (['ArrowLeft', 'ArrowUp', 'Backspace', 'p', 'P', 'PageUp'].includes(k)) this.prev();
    else if (k === 'Home') this.gotoPos(0);
    else if (k === 'End') this.gotoPos(this.order.length - 1);
    else if (k === 'b' || k === 'B' || k === '.') this.black();
    else if (k === 'w' || k === 'W' || k === ',') this.white();
    else if (k === 'g' || k === 'G' || k === '-') this.overview();
    else if (k === 'z' || k === 'Z') this.toggleZoomMode();
    else if (k === 'e' || k === 'E') this.clearInk();
    else if (k === 's' || k === 'S') this.togglePause();
    else if (k === 'j' || k === 'J') this.toggleSubtitles();
    else if (k === '?' || k === 'F1') this.help();
    else if (k === 'Escape') { if (this.zoomed || this.zoomMode) this.unzoom(); else if (this.tool !== 'none') this.setTool('none'); else this.end(); }
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }

  private onMove(e: PointerEvent): void {
    this.showToolbar();
    if (this.tool === 'laser') {
      const p = this.toSlide(e.clientX, e.clientY);
      this.laser(p.x, p.y);
      this.emit('laser', p.x, p.y);
    }
  }

  private toSlide(cx: number, cy: number): { x: number; y: number } {
    const r = this.stage.getBoundingClientRect();
    return { x: ((cx - r.left) / (r.width || 1)) * this.deck.size.w, y: ((cy - r.top) / (r.height || 1)) * this.deck.size.h };
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button === 2) return;
    if (this.tool === 'pen' || this.tool === 'highlighter') { this.draw(e); return; }
    if (this.tool === 'eraser') { this.eraseAt(e); return; }
    if (this.tool === 'laser') return;
    // Touch taps are handled on touchend, so a swipe does not also advance.
    if (e.pointerType === 'touch') return;
    if (this.zoomMode) { this.zoomAt(e.clientX, e.clientY); return; }
    if (this.zoomed) { this.unzoom(); return; }
    this.tap(e.target as Element);
  }

  /** A click or tap on the slide: a link or trigger on the element under it, otherwise next. */
  private tap(target: Element | null): void {
    const g = target?.closest?.('g[data-id]');
    if (g && this.slide) {
      const el = this.deck.findElement(this.slide, g.getAttribute('data-id')!);
      if (el && this.activate(el)) return;
    }
    if (this.slide?.transition?.advClick === false && !this.busy) return;
    this.next();
  }

  /** Follows an element's link or runs its triggered animations. True when something happened. */
  private activate(el: ModelElement): boolean {
    const slide = this.slide!;
    const triggered = slide.anims.filter((a) => a.onShape === el.id);
    if (triggered.length) {
      const step: BuildStep = { effects: triggered.map((a) => ({ anim: a, start: a.delay || 0, dur: a.dur ?? 500 })), length: 0 };
      void this.play(step);
      return true;
    }
    const l = el.link;
    if (!l) return false;
    if (l.action === 'next') this.next();
    else if (l.action === 'prev') this.prev();
    else if (l.action === 'first') this.gotoPos(0);
    else if (l.action === 'last') this.gotoPos(this.order.length - 1);
    else if (l.action === 'end') this.end();
    else if (l.slide) { const i = this.deck.slideIndex(l.slide); if (i >= 0) this.goto(i); }
    else if (l.url) this.app.followLink(l.url);
    else return false;
    return true;
  }

  // ------------------------------------------------------------------------------------------
  // Ink and laser

  setTool(t: Tool): void {
    this.tool = t;
    this.root.classList.toggle('qs-drawing', t === 'pen' || t === 'highlighter' || t === 'eraser');
    this.root.classList.toggle('qs-lasering', t === 'laser');
    if (t !== 'laser') this.laser(null);
    this.emit('tool', t);
  }

  laser(x: number | null, y = 0): void {
    if (x == null) { this.laserDot.style.display = 'none'; return; }
    this.laserDot.style.display = 'block';
    this.laserDot.style.left = `${(x / this.deck.size.w) * 100}%`;
    this.laserDot.style.top = `${(y / this.deck.size.h) * 100}%`;
  }

  inkFor(slideId: string): InkStroke[] { return this.ink.get(slideId) || []; }

  addInk(slideId: string, s: InkStroke): void {
    if (!this.ink.has(slideId)) this.ink.set(slideId, []);
    this.ink.get(slideId)!.push(s);
    if (slideId === this.slide?.id) this.drawInk();
    this.emit('ink', slideId, s);
  }

  clearInk(): void {
    if (!this.slide) return;
    this.ink.delete(this.slide.id);
    this.drawInk();
    this.emit('ink', this.slide.id, null);
  }

  private drawInk(): void {
    const ns = 'http://www.w3.org/2000/svg';
    this.inkSvg.replaceChildren();
    if (!this.inkVisible || !this.slide) return;
    for (const s of [...(this.slide.ink || []), ...this.inkFor(this.slide.id)]) {
      const p = this.doc.createElementNS(ns, 'path');
      p.setAttribute('d', s.d);
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', s.color);
      p.setAttribute('stroke-width', String(s.width));
      p.setAttribute('stroke-linecap', 'round');
      p.setAttribute('stroke-linejoin', 'round');
      if (s.highlighter) p.setAttribute('opacity', '0.4');
      this.inkSvg.appendChild(p);
    }
  }

  private draw(e: PointerEvent): void {
    if (!this.slide) return;
    const hl = this.tool === 'highlighter';
    const color = hl ? '#FFEB3B' : this.deck.data.show?.penColor || this.app.prefs.penColor || '#E53935';
    const width = hl ? 14 : 3;
    const pts: { x: number; y: number }[] = [this.toSlide(e.clientX, e.clientY)];
    const ns = 'http://www.w3.org/2000/svg';
    const path = this.doc.createElementNS(ns, 'path');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', color);
    path.setAttribute('stroke-width', String(width));
    path.setAttribute('stroke-linecap', 'round');
    if (hl) path.setAttribute('opacity', '0.4');
    this.inkSvg.appendChild(path);
    const d = () => 'M' + pts.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' L');
    const move = (ev: Event) => { const pe = ev as PointerEvent; pts.push(this.toSlide(pe.clientX, pe.clientY)); path.setAttribute('d', d()); };
    const slideId = this.slide.id;
    const detach = () => {
      this.doc.removeEventListener('pointermove', move);
      this.doc.removeEventListener('pointerup', up);
      this.doc.removeEventListener('pointercancel', up);
      if (this.drawCleanup === detach) this.drawCleanup = null;
      path.remove();
    };
    const up = () => {
      detach();
      if (pts.length > 1 && !this.ended) this.addInk(slideId, { d: d(), color, width, highlighter: hl });
    };
    this.drawCleanup?.();
    this.drawCleanup = detach;
    this.doc.addEventListener('pointermove', move);
    this.doc.addEventListener('pointerup', up);
    this.doc.addEventListener('pointercancel', up);
  }

  private eraseAt(e: PointerEvent): void {
    if (!this.slide) return;
    const p = this.toSlide(e.clientX, e.clientY);
    const list = this.inkFor(this.slide.id);
    const i = list.findIndex((s) => (s.d.match(/-?\d+(\.\d+)?/g) || []).map(Number).some((v, k, arr) => k % 2 === 0 && Math.hypot(v - p.x, arr[k + 1] - p.y) < 12));
    if (i >= 0) { list.splice(i, 1); this.drawInk(); this.emit('ink', this.slide.id, null); }
  }

  // ------------------------------------------------------------------------------------------
  // Media

  private mountMedia(slide: Slide): void {
    for (const el of slide.elements) {
      if (el.kind !== 'media') continue;
      const m = el as MediaElement;
      const tag = m.mediaKind === 'audio' ? 'audio' : 'video';
      const v = this.doc.createElement(tag) as HTMLMediaElement;
      v.src = this.deck.mediaUrl(m.media);
      v.controls = this.deck.data.show?.showNarration !== false;
      v.loop = !!m.loop;
      v.className = 'qs-media';
      if (m.volume != null) v.volume = Math.max(0, Math.min(1, m.volume));
      if (m.start) v.currentTime = m.start / 1000;
      if (m.end) v.addEventListener('timeupdate', () => { if (v.currentTime * 1000 >= m.end!) { v.pause(); } });
      if (m.poster) (v as HTMLVideoElement).poster = this.deck.mediaUrl(m.poster);
      v.dataset.id = m.id;
      v.addEventListener('pointerdown', (e) => e.stopPropagation());
      this.stage.insertBefore(v, this.inkSvg);
      this.media.push(v);
      if (m.autoplay) void v.play().catch(() => undefined);
    }
    this.layoutMedia();
  }

  private layoutMedia(): void {
    const slide = this.slide;
    if (!slide) return;
    for (const v of this.media) {
      const el = slide.elements.find((e) => e.id === v.dataset.id);
      if (!el) continue;
      const b = resolveBox(this.deck, slide, el);
      const { w, h } = this.deck.size;
      Object.assign(v.style, { left: `${(b.x / w) * 100}%`, top: `${(b.y / h) * 100}%`, width: `${(b.w / w) * 100}%`, height: `${(b.h / h) * 100}%` });
    }
  }

  private stopMedia(): void {
    for (const v of this.media) { try { v.pause(); } catch { /* */ } v.remove(); }
    this.media = [];
  }

  // ------------------------------------------------------------------------------------------
  // Overlays: grid, help, menu, zoom, subtitles

  private closeOverlay(): void { this.overlay?.remove(); this.overlay = null; this.root.focus(); }

  overview(): void {
    if (this.overlay) { this.closeOverlay(); return; }
    const grid = this.el('div', 'qs-overlay qs-grid');
    grid.setAttribute('role', 'listbox');
    grid.setAttribute('aria-label', 'All slides');
    this.deck.slides.forEach((s, i) => {
      const b = this.el('button', 'qs-grid-item' + (i === this.index ? ' qs-current' : '') + (s.hidden ? ' qs-hidden-slide' : ''));
      b.type = 'button';
      b.innerHTML = slideSvg(this.deck, s, { mode: 'thumb', number: i + (this.deck.data.firstNumber ?? 1) });
      b.appendChild(this.el('span', 'qs-grid-num', String(i + 1)));
      b.addEventListener('click', (e) => { e.stopPropagation(); this.closeOverlay(); this.goto(i); });
      grid.appendChild(b);
    });
    grid.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.overlay = grid;
    this.root.appendChild(grid);
    (grid.querySelector('.qs-current') as HTMLElement | null)?.scrollIntoView?.({ block: 'center' });
  }

  private help(): void {
    if (this.overlay) { this.closeOverlay(); return; }
    const box = this.el('div', 'qs-overlay qs-help');
    box.appendChild(this.el('h2', '', 'Slide show keys'));
    const table = this.el('table');
    for (const [k, v] of KEYS_HELP) { const tr = this.el('tr'); tr.append(this.el('td', '', k), this.el('td', '', v)); table.appendChild(tr); }
    box.appendChild(table);
    box.appendChild(this.el('p', '', 'Press Esc or ? to close.'));
    box.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.closeOverlay(); });
    this.overlay = box;
    this.root.appendChild(box);
  }

  private menu(): void {
    if (this.overlay) { this.closeOverlay(); return; }
    const box = this.el('div', 'qs-overlay qs-menu');
    const item = (label: string, fn: () => void) => { const b = this.el('button', 'qs-menu-item', label); b.type = 'button'; b.addEventListener('click', (e) => { e.stopPropagation(); this.closeOverlay(); fn(); }); box.appendChild(b); };
    item('Next', () => this.next());
    item('Previous', () => this.prev());
    item('See All Slides', () => this.overview());
    item('Zoom Into the Slide', () => this.toggleZoomMode());
    item('Pen', () => this.setTool('pen'));
    item('Highlighter', () => this.setTool('highlighter'));
    item('Laser Pointer', () => this.setTool('laser'));
    item('Eraser', () => this.setTool('eraser'));
    item('Erase All Ink on Slide', () => this.clearInk());
    item('Arrow (stop drawing)', () => this.setTool('none'));
    item(this.inkVisible ? 'Hide Ink' : 'Show Ink', () => { this.inkVisible = !this.inkVisible; this.drawInk(); });
    item('Black Screen', () => this.black());
    item('White Screen', () => this.white());
    item(this.paused ? 'Resume Automatic Advance' : 'Pause Automatic Advance', () => this.togglePause());
    item('Live Subtitles', () => this.toggleSubtitles());
    item('Help', () => this.help());
    item('End Show', () => this.end());
    box.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.overlay = box;
    this.root.appendChild(box);
  }

  private toggleZoomMode(): void {
    if (this.zoomed || this.zoomMode) { this.unzoom(); return; }
    this.zoomMode = true;
    this.root.classList.add('qs-zoom-pick');
    toastIn(this.doc, 'Click where to zoom in (Esc to cancel)');
  }

  private zoomAt(cx: number, cy: number): void {
    const r = this.stage.getBoundingClientRect();
    const ox = ((cx - r.left) / r.width) * 100, oy = ((cy - r.top) / r.height) * 100;
    this.stage.style.transformOrigin = `${ox}% ${oy}%`;
    this.stage.style.transform = 'scale(2.5)';
    this.zoomMode = false;
    this.zoomed = true;
    this.root.classList.remove('qs-zoom-pick');
  }

  private unzoom(): void {
    this.zoomMode = false;
    this.zoomed = false;
    this.root.classList.remove('qs-zoom-pick');
    this.stage.style.transform = '';
  }

  private toggleSubtitles(): void {
    if (this.recog) { try { this.recog.stop(); } catch { /* */ } this.recog = null; this.subtitleEl.textContent = ''; this.subtitleEl.classList.remove('qs-on'); return; }
    const SR = (this.win as any).SpeechRecognition || (this.win as any).webkitSpeechRecognition || (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { toastIn(this.doc, 'Live subtitles need speech recognition, which this browser or device does not offer.'); return; }
    const r = new SR();
    r.continuous = true;
    r.interimResults = true;
    r.lang = this.app.prefs.language || 'en-US';
    r.onresult = (ev: any) => {
      let text = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) text += ev.results[i][0].transcript;
      this.subtitleEl.textContent = text.slice(-160);
    };
    r.onend = () => { if (this.recog === r && !this.ended) { try { r.start(); } catch { /* */ } } };
    r.onerror = (ev: any) => { if (ev.error === 'not-allowed') { toastIn(this.doc, 'Microphone access was refused; subtitles are off.'); this.recog = null; this.subtitleEl.classList.remove('qs-on'); } };
    try { r.start(); this.recog = r; this.subtitleEl.classList.add('qs-on'); } catch { toastIn(this.doc, 'Could not start live subtitles.'); }
  }

  private updateCounter(): void {
    const c = this.toolbar.querySelector('.qs-tb-count');
    if (c) c.textContent = `${this.pos + 1} / ${this.order.length}`;
  }

  // ------------------------------------------------------------------------------------------

  end(): void {
    if (this.ended) return;
    this.recordRehearsal();
    this.ended = true;
    this.clearAuto();
    this.stopMedia();
    clearTimeout(this.hideTimer);
    if (this.recog) { try { this.recog.stop(); } catch { /* */ } this.recog = null; }
    for (const c of this.cleanups) c();
    this.cleanups = [];
    this.drawCleanup?.();
    try { if (this.doc.fullscreenElement) void this.doc.exitFullscreen().catch(() => undefined); } catch { /* */ }
    this.root.remove();
    void keepAwake(false);
    if (active === this) active = null;
    this.emit('end');
    void this.afterEnd();
  }

  private async afterEnd(): Promise<void> {
    const app = this.app;
    const deck = this.deck;
    const inked = [...this.ink.entries()].filter(([id, list]) => list.length && deck.slide(id));
    if (inked.length && await confirmDialog('Slide Show', 'Keep your ink annotations?', 'Keep', 'Discard')) {
      deck.transact('Keep Ink Annotations', () => {
        for (const [id, list] of inked) { const s = deck.slide(id)!; s.ink = [...(s.ink || []), ...list]; }
      }, inked.map(([id]) => id));
    }
    if (this.rehearse && this.rehearse.times.size) {
      const total = [...this.rehearse.times.values()].reduce((a, b) => a + b, 0);
      const fmt = (ms: number) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
      if (await confirmDialog('Rehearse Timings', `The total time for the slide show was ${fmt(total)}. Do you want to keep the new slide timings?`, 'Keep', "Don't Keep")) {
        deck.transact('Rehearse Timings', () => {
          for (const [id, ms] of this.rehearse!.times) {
            const s = deck.slide(id);
            if (s) s.transition = { ...(s.transition || { type: 'none' }), advAfter: Math.round(ms / 100) * 100 };
          }
          deck.data.show = { ...(deck.data.show || {}), useTimings: true };
        });
      }
    }
    if (this.slide && app.deck === deck) app.goToSlide(this.slide.id);
    app.focus();
  }
}

function toastIn(doc: Document, msg: string): void {
  if (doc === document) { toast(msg, { ms: 2000 }); return; }
  const t = doc.createElement('div');
  t.className = 'qs-toast';
  t.textContent = msg;
  doc.body.appendChild(t);
  setTimeout(() => t.remove(), 2000);
}
