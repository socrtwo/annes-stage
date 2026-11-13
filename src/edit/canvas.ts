/**
 * Editing surface for one slide (or layout or master): renders the slide, draws selection handles,
 * and handles selection, moving, resizing, rotating, smart guides, snapping, inserting shapes by
 * dragging, ink, and starting in-place text editing. Touch gestures: drag to move, pinch to zoom,
 * long-press for the context menu.
 */
import type { App } from '../app';
import type { Element, ShapeElement } from '../model/types';
import { clone } from '../model/deck';
import { resolveBox, isSlide, type Box } from '../model/inherit';
import { slideSvg } from '../render/slide';
import { edit, setBox, boxOf, deleteSelection, nudge, type Owner } from './ops';
import { TextEditor, activeTextEditor } from './textEdit';
import { h } from '../ui/dom';
import { keyName } from '../util/keys';

export type InsertTool = { kind: 'shape'; make: (box: { x: number; y: number; w: number; h: number }) => Element; label: string; line?: boolean } | { kind: 'ink'; mode: 'pen' | 'highlighter' | 'eraser'; color: string; width: number } | { kind: 'lasso' };

type Drag =
  | { kind: 'move'; start: { x: number; y: number }; boxes: Map<string, Box>; moved: boolean }
  | { kind: 'resize'; handle: string; start: { x: number; y: number }; id: string; box: Box }
  | { kind: 'rotate'; id: string; box: Box; center: { x: number; y: number } }
  | { kind: 'marquee'; start: { x: number; y: number }; cur: { x: number; y: number }; add: boolean }
  | { kind: 'insert'; start: { x: number; y: number }; cur: { x: number; y: number } }
  | { kind: 'ink'; pts: [number, number][] };

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export class Canvas {
  el: HTMLElement;
  stage: HTMLElement;
  private slideHost: HTMLElement;
  private overlay: HTMLElement;
  private guidesEl: SVGSVGElement;
  selection: string[] = [];
  zoom = 1;
  fit = true;
  private drag: Drag | null = null;
  private preview: Map<string, Partial<Box>> | null = null;
  editor: TextEditor | null = null;
  tool: InsertTool | null = null;
  private renderedKey = '';
  private pointers = new Map<number, { x: number; y: number }>();
  private pinch: { d: number; zoom: number } | null = null;
  private longPress: any = null;
  onSelect: (() => void) | null = null;

  constructor(public app: App, private ownerFn: () => Owner | undefined) {
    this.slideHost = h('div', { class: 'qs-slide-host' });
    this.overlay = h('div', { class: 'qs-edit-overlay' });
    this.guidesEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.guidesEl.setAttribute('class', 'qs-guides');
    this.stage = h('div', { class: 'qs-edit-stage' }, this.slideHost, this.guidesEl as any, this.overlay);
    this.el = h('div', { class: 'qs-canvas', tabindex: '0', 'aria-label': 'Slide editing area' }, this.stage);
    this.el.addEventListener('pointerdown', (e) => this.down(e));
    this.el.addEventListener('pointermove', (e) => this.move(e));
    this.el.addEventListener('pointerup', (e) => this.up(e));
    this.el.addEventListener('pointercancel', (e) => this.up(e));
    this.el.addEventListener('dblclick', (e) => this.dbl(e));
    this.el.addEventListener('contextmenu', (e) => { e.preventDefault(); this.contextMenu(e.clientX, e.clientY, e.target); });
    this.el.addEventListener('keydown', (e) => this.key(e));
    this.el.addEventListener('wheel', (e) => { if (e.ctrlKey) { e.preventDefault(); this.setZoom(this.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)); } }, { passive: false });
    this.el.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
    this.el.addEventListener('drop', (e) => {
      const files = [...(e.dataTransfer?.files || [])];
      if (!files.length) return;
      e.preventDefault();
      this.app.exec('insert.pictureFiles', files);
    });
  }

  get owner(): Owner | undefined { return this.ownerFn(); }

  // ------------------------------------------------------------------------------------------
  // Rendering

  layout(): void {
    const { w, h: hh } = this.app.deck.size;
    if (this.fit) {
      const pw = this.el.clientWidth - 32, ph = this.el.clientHeight - 32;
      if (pw > 20 && ph > 20) this.zoom = Math.max(0.05, Math.min(pw / w, ph / hh));
    }
    this.stage.style.width = `${w * this.zoom}px`;
    this.stage.style.height = `${hh * this.zoom}px`;
    this.slideHost.style.width = this.overlay.style.width = `${w}px`;
    this.slideHost.style.height = this.overlay.style.height = `${hh}px`;
    this.slideHost.style.transform = this.overlay.style.transform = `scale(${this.zoom})`;
    this.guidesEl.setAttribute('viewBox', `0 0 ${w} ${hh}`);
    this.renderedKey = '';
    this.render();
  }

  setZoom(z: number | 'fit'): void {
    if (z === 'fit') { this.fit = true; this.layout(); return; }
    this.fit = false;
    this.zoom = Math.max(0.1, Math.min(4, z));
    this.layout();
    this.app.refresh();
  }

  render(): void {
    const o = this.owner;
    if (!o) { this.slideHost.innerHTML = ''; this.overlay.textContent = ''; return; }
    let target: Owner = o;
    if (this.preview) {
      target = clone(o);
      for (const [id, b] of this.preview) {
        const e = this.app.deck.findElement(target, id);
        if (e) applyBoxShallow(e, resolveBox(this.app.deck, o, this.app.deck.findElement(o, id)!), b);
      }
    }
    const hide = new Set<string>();
    if (this.editor) hide.add(this.editor.el.id);
    const p = this.app.prefs;
    const mode = (this.app.tab as any).colorMode as string | undefined;
    const inkOff = !!(this.app.tab as any).hideInk;
    const key = `${this.app.deck.version}:${o.id}:${JSON.stringify([...(this.preview || [])])}:${[...hide]}:${p.showGrid}:${this.app.tab.view}:${mode}:${inkOff}`;
    if (key !== this.renderedKey) {
      this.renderedKey = key;
      const num = isSlide(o) ? this.app.deck.slideIndex(o.id) + (this.app.deck.data.firstNumber ?? 1) : undefined;
      this.slideHost.innerHTML = slideSvg(this.app.deck, target, { mode: 'edit', prompts: true, ids: true, hide, number: num, grid: p.showGrid ? p.gridSize : 0, grayscale: mode === 'grayscale', blackWhite: mode === 'blackWhite', ink: !inkOff });
    }
    this.drawSelection(target);
  }

  invalidate(): void { this.renderedKey = ''; this.render(); }

  private drawSelection(o: Owner): void {
    // Keep the text editor; rebuild handles.
    for (const c of [...this.overlay.children]) if (!c.classList.contains('qs-textedit')) c.remove();
    this.selection = this.selection.filter((id) => o.elements.some((e) => e.id === id));
    const single = this.selection.length === 1;
    for (const id of this.selection) {
      const e = o.elements.find((x) => x.id === id)!;
      const b = resolveBox(this.app.deck, o, e);
      const frame = h('div', { class: 'qs-sel' + (this.editor?.el.id === id ? ' qs-sel-editing' : '') + (e.locked ? ' qs-sel-locked' : ''), 'data-sel': id });
      Object.assign(frame.style, { left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px`, transform: b.rot ? `rotate(${b.rot}deg)` : '' });
      frame.style.setProperty('--qs-inv', String(1 / this.zoom));
      if (single && !e.locked && !this.editor) {
        const isLine = e.kind === 'shape' && /^(line|straightConnector1|bentConnector\d|curvedConnector\d)$/.test((e as ShapeElement).geom);
        for (const hd of isLine ? ['nw', 'se'] : HANDLES) frame.appendChild(h('div', { class: `qs-handle qs-h-${hd}`, 'data-handle': hd }));
        if (!isLine) frame.appendChild(h('div', { class: 'qs-handle qs-rot', 'data-handle': 'rot', title: 'Rotate' }));
      }
      this.overlay.appendChild(frame);
    }
    this.onSelect?.();
  }

  select(ids: string[]): void {
    if (this.editor && !ids.includes(this.editor.el.id)) this.commitText();
    this.selection = [...new Set(ids)];
    this.render();
    this.app.refresh();
  }

  // ------------------------------------------------------------------------------------------
  // Pointer

  private pt(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.stage.getBoundingClientRect();
    return { x: (e.clientX - r.left) / this.zoom, y: (e.clientY - r.top) / this.zoom };
  }

  private hit(target: EventTarget | null, p?: { x: number; y: number }): Element | undefined {
    const o = this.owner;
    if (!o) return undefined;
    let n = target as HTMLElement | null;
    // Selected frames are hit first (so a selected shape under another can still be dragged).
    const frame = n?.closest?.('[data-sel]') as HTMLElement | null;
    if (frame) return o.elements.find((e) => e.id === frame.dataset.sel);
    while (n && n !== this.el) {
      const id = n.getAttribute?.('data-id');
      if (id) {
        const top = o.elements.find((e) => e.id === id) || o.elements.find((e) => e.kind === 'group' && this.app.deck.findElement(e as any, id));
        if (top) return top;
      }
      n = n.parentElement || (n.parentNode as HTMLElement | null);
    }
    // Empty placeholders and text boxes are transparent; hit-test their boxes.
    if (p) for (let i = o.elements.length - 1; i >= 0; i--) {
      const e = o.elements[i];
      const b = resolveBox(this.app.deck, o, e);
      if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return e;
    }
    return undefined;
  }

  private down(e: PointerEvent): void {
    if (this.editor && this.editor.root.contains(e.target as Node)) return;
    this.el.focus({ preventScroll: true });
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom: this.zoom };
      this.drag = null; this.preview = null;
      return;
    }
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const p = this.pt(e);
    const o = this.owner;
    if (!o) return;
    if (this.editor) this.commitText();
    // Tools
    if (this.tool?.kind === 'ink') { this.drag = { kind: 'ink', pts: [[p.x, p.y]] }; this.el.setPointerCapture(e.pointerId); return; }
    if (this.tool?.kind === 'shape') { this.drag = { kind: 'insert', start: p, cur: p }; this.el.setPointerCapture(e.pointerId); return; }
    const handle = (e.target as HTMLElement).dataset?.handle;
    if (handle && this.selection.length === 1) {
      const el = o.elements.find((x) => x.id === this.selection[0])!;
      const box = resolveBox(this.app.deck, o, el);
      if (handle === 'rot') this.drag = { kind: 'rotate', id: el.id, box, center: { x: box.x + box.w / 2, y: box.y + box.h / 2 } };
      else this.drag = { kind: 'resize', handle, start: p, id: el.id, box };
      this.el.setPointerCapture(e.pointerId);
      return;
    }
    const hit = this.hit(e.target, p);
    if (hit) {
      if (e.shiftKey || e.ctrlKey || e.metaKey) this.select(this.selection.includes(hit.id) ? this.selection.filter((x) => x !== hit.id) : [...this.selection, hit.id]);
      else if (!this.selection.includes(hit.id)) this.select([hit.id]);
      const boxes = new Map<string, Box>();
      for (const id of this.selection) { const x = o.elements.find((q) => q.id === id); if (x && !x.locked) boxes.set(id, resolveBox(this.app.deck, o, x)); }
      this.drag = { kind: 'move', start: p, boxes, moved: false };
      if (e.pointerType === 'touch') this.longPress = setTimeout(() => { this.drag = null; this.contextMenu(e.clientX, e.clientY, e.target as any); }, 600);
    } else {
      if (!e.shiftKey) this.select([]);
      this.drag = { kind: 'marquee', start: p, cur: p, add: e.shiftKey };
      if (e.pointerType === 'touch') this.longPress = setTimeout(() => { this.drag = null; this.contextMenu(e.clientX, e.clientY, e.target as any); }, 600);
    }
    this.el.setPointerCapture(e.pointerId);
  }

  private move(e: PointerEvent): void {
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pinch && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.setZoom(this.pinch.zoom * Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, this.pinch.d));
      return;
    }
    const d = this.drag;
    if (!d) return;
    const p = this.pt(e);
    if (this.longPress && d.kind === 'move' && Math.hypot(p.x - d.start.x, p.y - d.start.y) * this.zoom > 6) { clearTimeout(this.longPress); this.longPress = null; }
    if (this.longPress && d.kind === 'marquee' && Math.hypot(p.x - d.start.x, p.y - d.start.y) * this.zoom > 6) { clearTimeout(this.longPress); this.longPress = null; }
    const snap = (v: number) => (this.app.prefs.snapToGrid && !e.altKey ? Math.round(v / this.app.prefs.gridSize) * this.app.prefs.gridSize : v);
    if (d.kind === 'move') {
      let dx = p.x - d.start.x, dy = p.y - d.start.y;
      if (!d.moved && Math.hypot(dx, dy) * this.zoom < 3) return;
      d.moved = true;
      if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      // Smart guides on the first selected box's edges and center.
      const first = [...d.boxes.values()][0];
      const guides: string[] = [];
      if (first && this.app.prefs.smartGuides && !e.altKey) {
        const g = this.smartSnap({ ...first, x: first.x + dx, y: first.y + dy }, new Set(d.boxes.keys()));
        dx += g.dx; dy += g.dy; guides.push(...g.lines);
      } else if (first && this.app.prefs.snapToGrid && !e.altKey) { dx = snap(first.x + dx) - first.x; dy = snap(first.y + dy) - first.y; }
      this.preview = new Map([...d.boxes].map(([id, b]) => [id, { x: b.x + dx, y: b.y + dy }]));
      this.showGuides(guides);
      this.render();
    } else if (d.kind === 'resize') {
      const b = d.box;
      // Work in the box's unrotated frame.
      const rad = (-(b.rot || 0) * Math.PI) / 180;
      const vx = p.x - d.start.x, vy = p.y - d.start.y;
      const dx = vx * Math.cos(rad) - vy * Math.sin(rad), dy = vx * Math.sin(rad) + vy * Math.cos(rad);
      let { x, y, w, h: hh } = b;
      const hd = d.handle;
      if (hd.includes('e')) w = b.w + dx;
      if (hd.includes('s')) hh = b.h + dy;
      if (hd.includes('w')) { w = b.w - dx; x = b.x + dx; }
      if (hd.includes('n')) { hh = b.h - dy; y = b.y + dy; }
      const el = this.owner?.elements.find((q) => q.id === d.id);
      const keepRatio = e.shiftKey || (el?.kind === 'picture' && !e.altKey && hd.length === 2);
      if (keepRatio && b.w && b.h && hd.length === 2) {
        const r = b.w / b.h;
        if (Math.abs(w / r) > Math.abs(hh)) hh = w / r; else w = hh * r;
        if (hd.includes('w')) x = b.x + b.w - w;
        if (hd.includes('n')) y = b.y + b.h - hh;
      }
      if (e.ctrlKey) { x = b.x - (w - b.w) / 2; y = b.y - (hh - b.h) / 2; }
      const isLine = el?.kind === 'shape' && LINE_GEOM.test((el as ShapeElement).geom);
      let flipH = b.flipH, flipV = b.flipV;
      if (isLine) {
        // Dragging an end past the other one mirrors the line instead of collapsing it.
        if (w < 0) { x += w; w = -w; flipH = !flipH; }
        if (hh < 0) { y += hh; hh = -hh; flipV = !flipV; }
      } else {
        // Keep the edge opposite the dragged handle where it was.
        if (w < 1) { if (hd.includes('w') && !e.ctrlKey) x = b.x + b.w - 1; w = 1; }
        if (hh < 1) { if (hd.includes('n') && !e.ctrlKey) y = b.y + b.h - 1; hh = 1; }
      }
      // Snap only the edges being dragged.
      if (!isLine && !b.rot && !keepRatio) {
        if (hd.includes('w')) { const nx = snap(x); w += x - nx; x = nx; }
        if (hd.includes('e')) w = Math.max(1, snap(x + w) - x);
        if (hd.includes('n')) { const ny = snap(y); hh += y - ny; y = ny; }
        if (hd.includes('s')) hh = Math.max(1, snap(y + hh) - y);
      }
      if (b.rot) {
        // The box is resized in its own frame; it rotates about its centre, so move the centre by the
        // rotated shift of the local centre to keep the anchored edge fixed on the page.
        ({ x, y } = rotatedResizeOrigin(b, { x, y, w, h: hh }));
      }
      this.preview = new Map([[d.id, isLine ? { x, y, w, h: hh, flipH, flipV } : { x, y, w, h: hh }]]);
      this.render();
    } else if (d.kind === 'rotate') {
      let ang = (Math.atan2(p.y - d.center.y, p.x - d.center.x) * 180) / Math.PI + 90;
      if (e.shiftKey) ang = Math.round(ang / 15) * 15;
      this.preview = new Map([[d.id, { rot: ((ang % 360) + 360) % 360 }]]);
      this.render();
    } else if (d.kind === 'marquee' || d.kind === 'insert') {
      d.cur = p;
      const x = Math.min(d.start.x, p.x), y = Math.min(d.start.y, p.y), w = Math.abs(p.x - d.start.x), hh = Math.abs(p.y - d.start.y);
      this.guidesEl.innerHTML = `<rect x="${x}" y="${y}" width="${w}" height="${hh}" fill="rgba(66,133,244,0.08)" stroke="#4285f4" stroke-width="${1 / this.zoom}" stroke-dasharray="${4 / this.zoom}"/>`;
    } else if (d.kind === 'ink') {
      d.pts.push([p.x, p.y]);
      const t = this.tool as Extract<InsertTool, { kind: 'ink' }>;
      this.guidesEl.innerHTML = `<path d="${inkPath(d.pts)}" fill="none" stroke="${t.mode === 'eraser' ? '#999' : t.color}" stroke-width="${t.width}" stroke-linecap="round" stroke-linejoin="round" opacity="${t.mode === 'highlighter' ? 0.4 : 1}"/>`;
    }
  }

  private up(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    clearTimeout(this.longPress); this.longPress = null;
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    const o = this.owner;
    if (!o) return;
    if ((d.kind === 'move' || d.kind === 'resize' || d.kind === 'rotate') && this.preview) {
      const pv = this.preview;
      this.preview = null;
      this.showGuides([]);
      edit(this.app, d.kind === 'move' ? 'Move' : d.kind === 'resize' ? 'Resize' : 'Rotate', (own) => {
        for (const [id, b] of pv) { const el = own.elements.find((q) => q.id === id); if (el) setBox(this.app, el, b); }
        // Text boxes that auto-fit their height keep it when only the width changes.
      });
      return;
    }
    if (d.kind === 'marquee') {
      this.guidesEl.innerHTML = '';
      const x1 = Math.min(d.start.x, d.cur.x), y1 = Math.min(d.start.y, d.cur.y), x2 = Math.max(d.start.x, d.cur.x), y2 = Math.max(d.start.y, d.cur.y);
      if (x2 - x1 < 2 && y2 - y1 < 2) return;
      const ids = o.elements.filter((el) => { const b = resolveBox(this.app.deck, o, el); return b.x >= x1 && b.y >= y1 && b.x + b.w <= x2 && b.y + b.h <= y2; }).map((el) => el.id);
      this.select(d.add ? [...this.selection, ...ids] : ids);
      return;
    }
    if (d.kind === 'insert' && this.tool?.kind === 'shape') {
      this.guidesEl.innerHTML = '';
      const t = this.tool;
      let x = Math.min(d.start.x, d.cur.x), y = Math.min(d.start.y, d.cur.y), w = Math.abs(d.cur.x - d.start.x), hh = Math.abs(d.cur.y - d.start.y);
      let flipH = false, flipV = false;
      if (t.line) { flipH = d.cur.x < d.start.x; flipV = d.cur.y < d.start.y; }
      if (w < 4 && hh < 4) { w = t.line ? 200 : 144; hh = t.line ? 0 : 108; x = d.start.x - w / 2; y = d.start.y - hh / 2; }
      const el = t.make({ x, y, w, h: hh });
      if (flipH) el.flipH = true;
      if (flipV) el.flipV = true;
      this.tool = null;
      this.el.classList.remove('qs-tool-active');
      edit(this.app, `Insert ${t.label}`, (own) => { own.elements.push(el); });
      this.select([el.id]);
      if (el.kind === 'shape' && (el as ShapeElement).textbox) this.editText(el.id);
      return;
    }
    if (d.kind === 'ink' && this.tool?.kind === 'ink' && isSlide(o)) {
      this.guidesEl.innerHTML = '';
      const t = this.tool;
      if (t.mode === 'eraser') {
        const pts = d.pts;
        edit(this.app, 'Erase Ink', (own) => {
          if (!isSlide(own) || !own.ink) return;
          own.ink = own.ink.filter((s) => !strokeHit(s.d, pts, 6));
        });
      } else if (d.pts.length > 1) {
        edit(this.app, 'Ink', (own) => { if (isSlide(own)) (own.ink ||= []).push({ d: inkPath(d.pts), color: t.color, width: t.width, ...(t.mode === 'highlighter' ? { highlighter: true } : {}) }); });
      }
    }
  }

  private smartSnap(b: Box, skip: Set<string>): { dx: number; dy: number; lines: string[] } {
    const o = this.owner!;
    const { w: SW, h: SH } = this.app.deck.size;
    const tol = 5 / this.zoom;
    const xs: number[] = [0, SW / 2, SW], ys: number[] = [0, SH / 2, SH];
    for (const e of o.elements) {
      if (skip.has(e.id)) continue;
      const r = resolveBox(this.app.deck, o, e);
      xs.push(r.x, r.x + r.w / 2, r.x + r.w); ys.push(r.y, r.y + r.h / 2, r.y + r.h);
    }
    let dx = 0, dy = 0, bestX = tol, bestY = tol, gx: number | null = null, gy: number | null = null;
    for (const mine of [b.x, b.x + b.w / 2, b.x + b.w]) for (const t of xs) { const dd = t - mine; if (Math.abs(dd) < bestX) { bestX = Math.abs(dd); dx = dd; gx = t; } }
    for (const mine of [b.y, b.y + b.h / 2, b.y + b.h]) for (const t of ys) { const dd = t - mine; if (Math.abs(dd) < bestY) { bestY = Math.abs(dd); dy = dd; gy = t; } }
    const lines: string[] = [];
    if (gx != null) lines.push(`M${gx} 0 V${SH}`);
    if (gy != null) lines.push(`M0 ${gy} H${SW}`);
    return { dx, dy, lines };
  }

  private showGuides(lines: string[]): void {
    this.guidesEl.innerHTML = lines.length ? `<path d="${lines.join(' ')}" stroke="#e8710a" stroke-width="${1 / this.zoom}" stroke-dasharray="${4 / this.zoom} ${3 / this.zoom}" fill="none"/>` : '';
  }

  private dbl(e: MouseEvent): void {
    const hit = this.hit(e.target, this.pt(e));
    if (!hit) return;
    if (hit.kind === 'shape') this.editText(hit.id);
    else if (hit.kind === 'table') this.app.exec('table.editCells');
    else if (hit.kind === 'chart') this.app.exec('chart.editData');
    else if (hit.kind === 'picture') this.app.exec('picture.crop');
    else if (hit.kind === 'group') this.app.exec('arrange.ungroup');
  }

  // ------------------------------------------------------------------------------------------
  // Text editing

  editText(id: string, selectAll = false): void {
    const o = this.owner;
    if (!o) return;
    const el = o.elements.find((e) => e.id === id);
    if (!el || el.kind !== 'shape' || this.app.isReadOnly()) return;
    if (this.editor) this.commitText();
    const b = resolveBox(this.app.deck, o, el);
    this.selection = [id];
    this.editor = new TextEditor(this.app, o, el, this.overlay, b, selectAll);
    this.editor.onDone = (commit) => { if (commit) this.commitText(); else this.cancelText(); this.el.focus(); };
    this.renderedKey = '';
    this.render();
    this.app.refresh();
  }

  get editingText(): boolean { return !!this.editor; }

  commitText(): void {
    const ed = this.editor;
    if (!ed) return;
    this.editor = null;
    const paras = ed.read();
    ed.destroy();
    const o = this.owner;
    const el = o?.elements.find((e) => e.id === ed.el.id) as ShapeElement | undefined;
    // Only a session that changed something becomes an undo step (re-reading the DOM can differ
    // from the stored paragraphs in harmless ways, e.g. a missing text body).
    if (el && ed.changed && JSON.stringify(paras) !== JSON.stringify(el.text?.paras || [])) {
      edit(this.app, 'Typing', (own) => {
        const t = own.elements.find((e) => e.id === el.id) as ShapeElement;
        t.text = { ...(t.text || {}), paras };
        // Text boxes without a height grow with their text.
      });
    } else { this.renderedKey = ''; this.render(); }
    this.app.refresh();
  }

  cancelText(): void {
    const ed = this.editor;
    if (!ed) return;
    this.editor = null;
    ed.destroy();
    this.renderedKey = '';
    this.render();
  }

  // ------------------------------------------------------------------------------------------
  // Keyboard

  private key(e: KeyboardEvent): void {
    if (this.editor) return; // the editor stops propagation of its own keys
    const app = this.app;
    const k = e.key;
    if (k === 'Escape') { if (this.tool) { this.setTool(null); return; } if (this.selection.length) { this.select([]); return; } }
    if (this.selection.length && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const step = e.shiftKey ? 12 : 2;
      if (k === 'ArrowLeft') { e.preventDefault(); nudge(app, -step, 0); return; }
      if (k === 'ArrowRight') { e.preventDefault(); nudge(app, step, 0); return; }
      if (k === 'ArrowUp') { e.preventDefault(); nudge(app, 0, -step); return; }
      if (k === 'ArrowDown') { e.preventDefault(); nudge(app, 0, step); return; }
      if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); deleteSelection(app); return; }
      if (k === 'Enter' || k === 'F2') { e.preventDefault(); const el = app.selected[0]; if (el?.kind === 'shape') this.editText(el.id, true); return; }
      if (k === 'Tab') { e.preventDefault(); this.cycle(e.shiftKey ? -1 : 1); return; }
      if (k.length === 1 && this.selection.length === 1) {
        const el = app.selected[0];
        if (el?.kind === 'shape') { e.preventDefault(); this.editText(el.id); if (this.editor) document.execCommand('insertText', false, k); return; }
      }
    } else if (!this.selection.length && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (k === 'Tab') { e.preventDefault(); this.cycle(e.shiftKey ? -1 : 1); return; }
      if (k === 'PageDown' || k === 'ArrowDown' || k === 'ArrowRight') { e.preventDefault(); app.exec('slide.next'); return; }
      if (k === 'PageUp' || k === 'ArrowUp' || k === 'ArrowLeft') { e.preventDefault(); app.exec('slide.prev'); return; }
      if (k === 'Home') { e.preventDefault(); app.exec('slide.first'); return; }
      if (k === 'End') { e.preventDefault(); app.exec('slide.last'); return; }
      if (k === 'Delete' || k === 'Backspace') { /* nothing selected */ }
    }
    const kn = keyName(e);
    if (kn && app.handleKey(kn)) e.preventDefault();
  }

  private cycle(dir: number): void {
    const o = this.owner;
    if (!o || !o.elements.length) return;
    const i = this.selection.length ? o.elements.findIndex((e) => e.id === this.selection[0]) : -1;
    const n = o.elements.length;
    this.select([o.elements[(i + dir + n) % n].id]);
  }

  setTool(t: InsertTool | null): void {
    this.tool = t;
    this.el.classList.toggle('qs-tool-active', !!t);
    this.el.classList.toggle('qs-tool-ink', t?.kind === 'ink');
    if (t) this.select([]);
    this.app.refresh();
  }

  private contextMenu(x: number, y: number, target: EventTarget | null): void {
    const hit = this.hit(target, this.pt({ clientX: x, clientY: y }));
    if (hit && !this.selection.includes(hit.id)) this.select([hit.id]);
    if (!hit) this.select([]);
    this.app.ui.canvasContextMenu(x, y, hit);
  }

  focus(): void { if (this.editor) this.editor.root.focus(); else this.el.focus({ preventScroll: true }); }
  destroy(): void { this.editor?.destroy(); this.el.remove(); }
}

const LINE_GEOM = /^(line|straightConnector1|bentConnector\d|curvedConnector\d)$/;

/**
 * Page origin of a rotated box resized in its local (unrotated) frame: `nb` is the new box expressed
 * in the old box's unrotated coordinates. The new centre is the old centre plus the local centre
 * shift rotated by the box's rotation.
 */
export function rotatedResizeOrigin(old: { x: number; y: number; w: number; h: number; rot?: number }, nb: { x: number; y: number; w: number; h: number }): { x: number; y: number } {
  const a = ((old.rot || 0) * Math.PI) / 180;
  const cx = old.x + old.w / 2, cy = old.y + old.h / 2;
  const lx = nb.x + nb.w / 2 - cx, ly = nb.y + nb.h / 2 - cy;
  const px = cx + lx * Math.cos(a) - ly * Math.sin(a), py = cy + lx * Math.sin(a) + ly * Math.cos(a);
  return { x: px - nb.w / 2, y: py - nb.h / 2 };
}

function applyBoxShallow(e: Element, cur: Box, b: Partial<Box>): void {
  const nb = { ...cur, ...b };
  if (e.kind === 'group') {
    const sx = cur.w ? nb.w / cur.w : 1, sy = cur.h ? nb.h / cur.h : 1;
    const walk = (els: Element[]) => { for (const c of els) { c.x = nb.x + ((c.x ?? 0) - cur.x) * sx; c.y = nb.y + ((c.y ?? 0) - cur.y) * sy; c.w = (c.w ?? 0) * sx; c.h = (c.h ?? 0) * sy; if (c.kind === 'group') walk(c.children); } };
    walk(e.children);
  }
  e.x = nb.x; e.y = nb.y; e.w = nb.w; e.h = nb.h; e.rot = nb.rot;
  if (b.flipH != null) e.flipH = b.flipH || undefined;
  if (b.flipV != null) e.flipV = b.flipV || undefined;
}

export function inkPath(pts: [number, number][]): string {
  if (!pts.length) return '';
  let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
    d += ` Q${pts[i][0].toFixed(1)} ${pts[i][1].toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`;
  }
  const l = pts[pts.length - 1];
  d += ` L${l[0].toFixed(1)} ${l[1].toFixed(1)}`;
  return d;
}

/** True when an ink stroke's path passes within tol of any point of the eraser path. */
function strokeHit(d: string, pts: [number, number][], tol: number): boolean {
  const nums = (d.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
  for (let i = 0; i + 1 < nums.length; i += 2) for (const [x, y] of pts) if (Math.hypot(nums[i] - x, nums[i + 1] - y) < tol) return true;
  return false;
}

export { activeTextEditor, boxOf };
