/**
 * Presenter view: the audience sees the show in a second window (placed full screen on another
 * display when the browser's Window Management API allows it); the presenter sees the current slide,
 * the next slide or build, speaker notes, timer, clock and tools in the main window. Pen, highlighter
 * and laser used on the presenter's slide appear on the audience screen.
 *
 * The show also announces each frame on BroadcastChannel('quillstage-show'), so any Anne's Stage page
 * opened with ?audience can follow it (a second browser tab on another screen, or a cast receiver).
 */
import type { App } from '../app';
import type { Slide } from '../model/types';
import { slideSvg } from '../render/slide';
import { stateAt } from '../render/animate';
import { startShow, type ShowController, type Tool, type InkStroke } from './player';
import { toast } from '../ui/dialog';
import showCss from '../styles/show.css?inline';

export interface PresenterOptions {
  from?: number;
  slideId?: string;
  customShow?: string;
  /** Presenter view on this screen only (practice); no audience window. */
  singleScreen?: boolean;
}

export const SHOW_CHANNEL = 'quillstage-show';

const isPhone = () => typeof matchMedia === 'function' && matchMedia('(max-width: 600px)').matches;

function ensureCss(doc: Document): void {
  if (doc.getElementById('qs-show-css')) return;
  const st = doc.createElement('style');
  st.id = 'qs-show-css';
  st.textContent = showCss;
  doc.head.appendChild(st);
}

/** Opens the audience window and writes an empty document into it, or returns null when blocked. */
function openAudienceWindow(): Window | null {
  let w: Window | null = null;
  try { w = window.open('', 'quillstage-audience', 'popup,width=1280,height=720'); } catch { w = null; }
  if (!w || w.closed) return null;
  const d = w.document;
  d.open();
  d.write(`<!doctype html><html><head><meta charset="utf-8"><base href="${location.href.replace(/"/g, '&quot;')}"><title>Anne\'s Stage – Audience</title></head><body style="margin:0;background:#000;overflow:hidden"></body></html>`);
  d.close();
  // Carry over the app's fonts and icon font so text and toolbar icons match.
  for (const node of document.head.querySelectorAll('style, link[rel="stylesheet"]')) d.head.appendChild(d.importNode(node, true));
  ensureCss(d);
  void placeOnOtherScreen(w);
  return w;
}

/** Moves the window to another display when the Window Management API is available and permitted. */
async function placeOnOtherScreen(w: Window): Promise<void> {
  try {
    const perm = await (navigator as any).permissions?.query({ name: 'window-management' as any }).catch(() => null);
    if (!('getScreenDetails' in window) || (perm && perm.state === 'denied')) return;
    const sd = await (window as any).getScreenDetails();
    const other = sd.screens.find((s: any) => s !== sd.currentScreen);
    if (!other) return;
    w.moveTo(other.availLeft, other.availTop);
    w.resizeTo(other.availWidth, other.availHeight);
  } catch { /* not supported or refused: the window stays where the browser put it */ }
}

/** Starts the presenter view. Falls back to an ordinary show on one screen when no second window opens. */
export function startPresenter(app: App, opts: PresenterOptions = {}): ShowController {
  let audience: Window | null = null;
  if (!opts.singleScreen) {
    if (!isPhone()) audience = openAudienceWindow();
    if (!audience) {
      toast('Presenter view needs a second window, which was blocked or is not available here. Showing the slide show on this screen; use Rehearse for the presenter view alone.', { ms: 7000 });
      return startShow(app, { from: opts.from, slideId: opts.slideId, customShow: opts.customShow });
    }
  }
  const show = startShow(app, {
    from: opts.from, slideId: opts.slideId, customShow: opts.customShow,
    window: audience || window, noFullscreen: !audience, keyWindows: [window],
  });
  new PresenterView(app, show, audience);
  return show;
}

class PresenterView {
  private root: HTMLElement;
  private cur: HTMLElement;
  private nextEl: HTMLElement;
  private notes: HTMLElement;
  private timerEl: HTMLElement;
  private clockEl: HTMLElement;
  private countEl: HTMLElement;
  private inkSvg: SVGSVGElement;
  private notesSize = 18;
  private started = performance.now();
  private pausedAt: number | null = null;
  private tick: any;
  private channel: BroadcastChannel | null = null;
  private offs: (() => void)[] = [];
  private toolBtns = new Map<Tool, HTMLElement>();

  constructor(private app: App, private show: ShowController, private audience: Window | null) {
    ensureCss(document);
    const { w, h } = app.deck.size;
    const el = <K extends keyof HTMLElementTagNameMap>(t: K, cls = '', text = '') => { const e = document.createElement(t); if (cls) e.className = cls; if (text) e.textContent = text; return e; };
    this.root = el('div', 'qs-presenter');
    this.root.tabIndex = -1;
    this.root.setAttribute('role', 'application');
    this.root.setAttribute('aria-label', 'Presenter view');
    this.root.style.setProperty('--qs-ratio', String(w / h));
    const top = el('div', 'qs-pv-top');
    this.timerEl = el('span', 'qs-pv-timer', '0:00:00');
    this.clockEl = el('span', 'qs-pv-clock');
    this.countEl = el('span', 'qs-pv-count');
    const btn = (icon: string, label: string, fn: () => void, cls = '') => {
      const b = el('button', 'qs-pv-btn ' + cls);
      b.type = 'button';
      b.title = label;
      b.setAttribute('aria-label', label);
      b.append(el('span', 'material-symbols-outlined', icon), el('span', '', label));
      b.addEventListener('click', () => { fn(); this.root.focus(); });
      return b;
    };
    top.append(this.timerEl,
      btn('pause', 'Pause timer', () => this.toggleTimer()),
      btn('restart_alt', 'Reset timer', () => { this.started = performance.now(); if (this.pausedAt) this.pausedAt = this.started; this.drawTimer(); }),
      this.clockEl, this.countEl);
    const main = el('div', 'qs-pv-main');
    this.cur = el('div', 'qs-pv-slide');
    this.inkSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg') as SVGSVGElement;
    this.inkSvg.setAttribute('class', 'qs-pv-ink');
    this.inkSvg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    this.inkSvg.setAttribute('preserveAspectRatio', 'none');
    main.appendChild(this.cur);
    const side = el('div', 'qs-pv-side');
    this.nextEl = el('div', 'qs-pv-slide qs-pv-next');
    this.notes = el('div', 'qs-pv-notes');
    this.notes.setAttribute('aria-label', 'Speaker notes');
    this.notes.style.fontSize = `${this.notesSize}px`;
    side.append(el('div', 'qs-pv-next-label', 'Next'), this.nextEl, this.notes);
    const bar = el('div', 'qs-pv-bar');
    bar.append(
      btn('arrow_back', 'Previous', () => show.prev()),
      btn('arrow_forward', 'Next', () => show.next()),
    );
    for (const [t, icon, label] of [['pen', 'edit', 'Pen'], ['highlighter', 'ink_highlighter', 'Highlighter'], ['laser', 'flare', 'Laser'], ['eraser', 'ink_eraser', 'Eraser']] as [Tool, string, string][]) {
      const b = btn(icon, label, () => show.setTool(show.tool === t ? 'none' : t));
      this.toolBtns.set(t, b);
      bar.appendChild(b);
    }
    bar.append(
      btn('delete_sweep', 'Erase ink', () => show.clearInk()),
      btn('grid_view', 'See all slides', () => this.grid()),
      btn('dark_mode', 'Black screen', () => show.black()),
      btn('light_mode', 'White screen', () => show.white()),
      btn('text_increase', 'Larger notes', () => this.setNotesSize(this.notesSize + 2)),
      btn('text_decrease', 'Smaller notes', () => this.setNotesSize(this.notesSize - 2)),
    );
    if (audience) bar.append(btn('swap_horiz', 'Swap displays', () => this.swap()));
    bar.append(btn('close', 'End show', () => show.end()));
    this.root.append(top, main, side, bar);
    document.body.appendChild(this.root);
    this.root.focus();
    // Drawing on the presenter's slide is mirrored to the audience.
    this.inkSvg.addEventListener('pointerdown', (e) => this.pointer(e));
    this.inkSvg.addEventListener('pointermove', (e) => { if (show.tool === 'laser') { const p = this.toSlide(e); show.laser(p.x, p.y); } });
    this.inkSvg.addEventListener('pointerleave', () => { if (show.tool === 'laser') show.laser(null); });
    try { this.channel = new BroadcastChannel(SHOW_CHANNEL); } catch { this.channel = null; }
    this.offs.push(show.on('slide', () => this.render()), show.on('step', () => this.render()), show.on('ink', () => { this.drawInk(); this.broadcast(); }),
      show.on('tool', (t: Tool) => this.syncTool(t)), show.on('screen', () => this.render()), show.on('end', () => this.close()));
    this.tick = setInterval(() => this.drawTimer(), 500);
    if (audience) {
      const watch = setInterval(() => { if (audience.closed) { clearInterval(watch); if (!show.ended) show.end(); } }, 1000);
      this.offs.push(() => clearInterval(watch));
      audience.addEventListener('beforeunload', () => { if (!show.ended) show.end(); });
    }
    this.render();
  }

  private toSlide(e: PointerEvent): { x: number; y: number } {
    const r = this.inkSvg.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / (r.width || 1)) * this.app.deck.size.w, y: ((e.clientY - r.top) / (r.height || 1)) * this.app.deck.size.h };
  }

  private pointer(e: PointerEvent): void {
    const show = this.show;
    if (show.tool !== 'pen' && show.tool !== 'highlighter') { if (show.tool === 'none') show.next(); return; }
    const slide = this.app.deck.slides[show.index];
    if (!slide) return;
    const hl = show.tool === 'highlighter';
    const color = hl ? '#FFEB3B' : this.app.deck.data.show?.penColor || this.app.prefs.penColor || '#E53935';
    const pts = [this.toSlide(e)];
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('fill', 'none'); path.setAttribute('stroke', color); path.setAttribute('stroke-width', hl ? '14' : '3'); path.setAttribute('stroke-linecap', 'round');
    if (hl) path.setAttribute('opacity', '0.4');
    this.inkSvg.appendChild(path);
    const d = () => 'M' + pts.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' L');
    const move = (ev: PointerEvent) => { pts.push(this.toSlide(ev)); path.setAttribute('d', d()); };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      path.remove();
      if (pts.length > 1) show.addInk(slide.id, { d: d(), color, width: hl ? 14 : 3, highlighter: hl });
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }

  private syncTool(t: Tool): void {
    for (const [k, b] of this.toolBtns) b.classList.toggle('qs-on', k === t);
    this.cur.classList.toggle('qs-drawing', t === 'pen' || t === 'highlighter' || t === 'eraser');
    this.cur.classList.toggle('qs-lasering', t === 'laser');
  }

  private render(): void {
    const deck = this.app.deck;
    const show = this.show;
    const slide = deck.slides[show.index];
    if (!slide) return;
    const num = (i: number) => i + (deck.data.firstNumber ?? 1);
    const st = stateAt(slide, show.step, undefined, { live: true });
    this.cur.innerHTML = slideSvg(deck, slide, { mode: 'show', hide: st.hide, paraVisible: st.paraVisible, number: num(show.index), ink: false });
    this.cur.appendChild(this.inkSvg);
    this.drawInk();
    // Next: the next build of this slide, or the next slide as it first appears.
    let next: { slide: Slide; step: number; label: string } | null = null;
    if (show.step < show.stepCount) next = { slide, step: show.step + 1, label: 'Next animation' };
    else {
      const p = show.pos;
      for (let q = p + 1; q < show.order.length; q++) { const s = deck.slides[show.order[q]]; if (s && !s.hidden) { next = { slide: s, step: 1, label: 'Next slide' }; break; } }
    }
    const label = this.root.querySelector('.qs-pv-next-label');
    if (next) {
      const ns = stateAt(next.slide, next.step, undefined, { live: true });
      this.nextEl.innerHTML = slideSvg(deck, next.slide, { mode: 'show', hide: ns.hide, paraVisible: ns.paraVisible, number: num(deck.slideIndex(next.slide.id)) });
      if (label) label.textContent = next.label;
    } else {
      this.nextEl.innerHTML = '';
      if (label) label.textContent = 'End of slide show';
    }
    this.notes.replaceChildren();
    const notes = slide.notes.map((p) => p.runs.map((r) => r.text).join(''));
    if (!notes.join('').trim()) this.notes.appendChild(Object.assign(document.createElement('p'), { textContent: 'No notes.' }));
    else for (const t of notes) { const p = document.createElement('p'); p.textContent = t || ' '; this.notes.appendChild(p); }
    const pos = show.pos;
    this.countEl.textContent = `Slide ${pos + 1} of ${show.order.length}${show.screen !== 'normal' ? ` · ${show.screen} screen` : ''}`;
    this.broadcast();
  }

  private drawInk(): void {
    const slide = this.app.deck.slides[this.show.index];
    this.inkSvg.replaceChildren();
    if (!slide) return;
    for (const s of [...(slide.ink || []), ...this.show.inkFor(slide.id)]) {
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', s.d); p.setAttribute('fill', 'none'); p.setAttribute('stroke', s.color); p.setAttribute('stroke-width', String(s.width)); p.setAttribute('stroke-linecap', 'round');
      if (s.highlighter) p.setAttribute('opacity', '0.4');
      this.inkSvg.appendChild(p);
    }
  }

  private broadcast(): void {
    if (!this.channel) return;
    const deck = this.app.deck;
    const slide = deck.slides[this.show.index];
    if (!slide) return;
    const st = stateAt(slide, this.show.step, undefined, { live: true });
    const ink: InkStroke[] = this.show.inkFor(slide.id);
    try {
      this.channel.postMessage({ type: 'frame', ratio: deck.size.w / deck.size.h, screen: this.show.screen, svg: slideSvg(deck, slide, { mode: 'show', hide: st.hide, paraVisible: st.paraVisible, number: this.show.index + (deck.data.firstNumber ?? 1) }), ink });
    } catch { /* data too large to clone: followers keep the previous frame */ }
  }

  private setNotesSize(px: number): void {
    this.notesSize = Math.max(10, Math.min(48, px));
    this.notes.style.fontSize = `${this.notesSize}px`;
  }

  private toggleTimer(): void {
    if (this.pausedAt != null) { this.started += performance.now() - this.pausedAt; this.pausedAt = null; }
    else this.pausedAt = performance.now();
    this.drawTimer();
  }

  private drawTimer(): void {
    const now = this.pausedAt ?? performance.now();
    const s = Math.floor((now - this.started) / 1000);
    this.timerEl.textContent = `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}${this.pausedAt != null ? ' ⏸' : ''}`;
    this.clockEl.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  private grid(): void {
    const deck = this.app.deck;
    const wrap = document.createElement('div');
    wrap.className = 'qs-overlay qs-grid qs-pv-grid';
    wrap.style.setProperty('--qs-ratio', String(deck.size.w / deck.size.h));
    deck.slides.forEach((s, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'qs-grid-item' + (i === this.show.index ? ' qs-current' : '') + (s.hidden ? ' qs-hidden-slide' : '');
      b.innerHTML = slideSvg(deck, s, { mode: 'thumb', number: i + (deck.data.firstNumber ?? 1) });
      const n = document.createElement('span'); n.className = 'qs-grid-num'; n.textContent = String(i + 1); b.appendChild(n);
      b.addEventListener('click', () => { wrap.remove(); window.removeEventListener('keydown', close, true); this.show.goto(i); this.root.focus(); });
      wrap.appendChild(b);
    });
    const close = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); wrap.remove(); window.removeEventListener('keydown', close, true); } };
    // On the window, so it runs before the show's own Esc (end show) handler on the document.
    window.addEventListener('keydown', close, true);
    document.body.appendChild(wrap);
  }

  /** Swaps the audience and presenter displays by exchanging the two windows' positions. */
  private swap(): void {
    const a = this.audience;
    if (!a || a.closed) return;
    try {
      const ax = a.screenX, ay = a.screenY, aw = a.outerWidth, ah = a.outerHeight;
      const mx = window.screenX, my = window.screenY, mw = window.outerWidth, mh = window.outerHeight;
      a.moveTo(mx, my); a.resizeTo(mw, mh);
      window.moveTo(ax, ay); window.resizeTo(aw, ah);
    } catch { toast('This browser does not let Anne\'s Stage move its windows; drag the audience window to the other display.'); }
  }

  private close(): void {
    clearInterval(this.tick);
    for (const o of this.offs) o();
    this.offs = [];
    this.channel?.close();
    this.root.remove();
    document.querySelector('.qs-pv-grid')?.remove();
    if (this.audience && !this.audience.closed) this.audience.close();
  }
}

/**
 * Follows a show running in another tab or window: shows each frame sent on the show channel. Used by
 * an Anne's Stage page opened with ?audience. Returns a function that stops following.
 */
export function followBroadcast(root: HTMLElement): () => void {
  ensureCss(document);
  const wrap = document.createElement('div');
  wrap.className = 'qs-audience';
  const frame = document.createElement('div');
  frame.style.position = 'relative';
  wrap.appendChild(frame);
  frame.innerHTML = '<p style="color:#aaa;font:16px system-ui;text-align:center;margin-top:40vh">Waiting for the slide show to start…</p>';
  root.appendChild(wrap);
  let ch: BroadcastChannel;
  try { ch = new BroadcastChannel(SHOW_CHANNEL); } catch { frame.textContent = 'This browser cannot follow a show from another tab.'; return () => wrap.remove(); }
  ch.onmessage = (ev) => {
    const m = ev.data;
    if (!m || m.type !== 'frame' || typeof m.svg !== 'string') return;
    wrap.style.setProperty('--qs-ratio', String(m.ratio || 16 / 9));
    // The markup comes from Anne's Stage's own renderer in a same-origin window; parse it as SVG
    // (scripts in SVG parsed this way do not run) and drop anything that is not drawing.
    const doc = new DOMParser().parseFromString(m.svg, 'image/svg+xml');
    // A malformed frame (parser error document) keeps the previous frame instead of blanking it.
    if (doc.documentElement.nodeName !== 'svg' || doc.getElementsByTagName('parsererror').length) return;
    doc.querySelectorAll('script, foreignObject').forEach((n) => n.remove());
    const svg = document.importNode(doc.documentElement, true) as unknown as SVGSVGElement;
    // Ink drawn during the show, in slide points like the slide itself.
    if (Array.isArray(m.ink)) {
      for (const s of m.ink as InkStroke[]) {
        if (!s || typeof s.d !== 'string') continue;
        const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        p.setAttribute('d', s.d);
        p.setAttribute('fill', 'none');
        p.setAttribute('stroke', typeof s.color === 'string' ? s.color : '#E53935');
        p.setAttribute('stroke-width', String(Number(s.width) || 3));
        p.setAttribute('stroke-linecap', 'round');
        p.setAttribute('stroke-linejoin', 'round');
        if (s.highlighter) p.setAttribute('opacity', '0.4');
        p.setAttribute('pointer-events', 'none');
        svg.appendChild(p);
      }
    }
    frame.replaceChildren(svg);
    if (m.screen === 'black' || m.screen === 'white') frame.replaceChildren(Object.assign(document.createElement('div'), { style: `position:absolute;inset:0;background:${m.screen === 'black' ? '#000' : '#fff'}` }));
  };
  return () => { ch.close(); wrap.remove(); };
}
