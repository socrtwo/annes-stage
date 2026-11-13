import { describe, it, expect } from 'vitest';
import { Deck } from '../../src/model/deck';
import * as ops from '../../src/edit/ops';
import { levelStyle, resolveBody } from '../../src/model/inherit';
import { TextEditor, cleanPastedText } from '../../src/edit/textEdit';
import { rotatedResizeOrigin } from '../../src/edit/canvas';
import type { Element, GroupElement, ShapeElement } from '../../src/model/types';

function mk() {
  const d = Deck.blank();
  const ui: any = { selection: [] as string[], select(ids: string[]) { this.selection = ids; }, editingText: false };
  const app: any = {
    deck: d, tab: { ui },
    get owner() { return d.slides[0]; },
    get selected() { return ui.selection.map((id: string) => d.findElement(d.slides[0], id)).filter(Boolean); },
  };
  return { d, ui, app, s: () => d.slides[0] };
}

/** Page position of a local point of an element (as the renderer transforms it), through groups. */
function toPage(e: Element, p: [number, number]): [number, number] {
  const x = e.x ?? 0, y = e.y ?? 0, w = e.w ?? 0, h = e.h ?? 0;
  let [px, py] = p;
  if (e.flipH) px = w - px;
  if (e.flipV) py = h - py;
  const a = ((e.rot || 0) * Math.PI) / 180, cx = w / 2, cy = h / 2;
  const vx = px - cx, vy = py - cy;
  return [x + cx + vx * Math.cos(a) - vy * Math.sin(a), y + cy + vx * Math.sin(a) + vy * Math.cos(a)];
}
function groupToPage(g: Element, q: [number, number]): [number, number] {
  return toPage(g, [q[0] - (g.x ?? 0), q[1] - (g.y ?? 0)]);
}
const close = (a: [number, number], b: [number, number]) => { expect(a[0]).toBeCloseTo(b[0], 1); expect(a[1]).toBeCloseTo(b[1], 1); };

describe('ungroup keeps the group transform (2)', () => {
  for (const [label, xf] of [['rot 90', { rot: 90 }], ['flipH', { flipH: true }], ['flipV + rot 30', { flipV: true, rot: 30 }], ['flipH + flipV + rot 45', { flipH: true, flipV: true, rot: 45 }]] as const) {
    it(label, () => {
      const { ui, app, s } = mk();
      const a = ops.newShape(app, 'rect', { x: 100, y: 100, w: 100, h: 50 }, { rot: 20 });
      const b = ops.newShape(app, 'rect', { x: 300, y: 160, w: 80, h: 40 });
      ops.insertElement(app, a); ops.insertElement(app, b);
      ui.select([a.id, b.id]); ops.group(app);
      const g = s().elements.find((x) => x.kind === 'group') as GroupElement;
      Object.assign(g, xf);
      // Corners as drawn inside the transformed group.
      const before = g.children.map((c) => [[0, 0], [c.w!, 0], [0, c.h!]].map((p) => groupToPage(g, toPage(c, p as [number, number]))));
      const ids = g.children.map((c) => c.id);
      ops.ungroup(app);
      ids.forEach((id, i) => {
        const c = s().elements.find((x) => x.id === id)!;
        const after = [[0, 0], [c.w!, 0], [0, c.h!]].map((p) => toPage(c, p as [number, number]));
        after.forEach((pt, k) => close(pt, before[i][k] as [number, number]));
      });
    });
  }
});

describe('AutoCorrect ignores inherited object keys (4)', () => {
  it('does not replace "constructor"', () => {
    const d = Deck.blank();
    const s = d.slides[0];
    const el = s.elements[0] as ShapeElement;
    const app: any = { deck: d, prefs: { spellcheck: false, autoCorrect: true, autoCapitalize: false, autoLists: false, replacements: { teh: 'the' } } };
    const ed = new TextEditor(app, s, el, document.body, { x: 0, y: 0, w: 300, h: 80, rot: 0 });
    const type = (word: string) => {
      const div = ed.root.firstElementChild!;
      div.textContent = '';
      const tn = document.createTextNode(word + ' ');
      div.appendChild(tn);
      const r = document.createRange(); r.setStart(tn, tn.length); r.collapse(true);
      const sel = window.getSelection()!; sel.removeAllRanges(); sel.addRange(r);
      ed.root.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: ' ', bubbles: true }));
      return ed.read()[0].runs.map((x) => x.text).join('');
    };
    expect(type('constructor')).toBe('constructor ');
    expect(type('toString')).toBe('toString ');
    expect(type('teh')).toBe('the ');
    ed.destroy();
  });
  it('focuses the editor synchronously (1)', () => {
    const d = Deck.blank();
    const s = d.slides[0];
    const app: any = { deck: d, prefs: { spellcheck: false, autoCorrect: false, replacements: {} } };
    // jsdom does not focus contenteditable elements, so watch the call instead.
    const focused: globalThis.Element[] = [];
    const orig = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (this: HTMLElement) { focused.push(this); };
    let ed: TextEditor;
    try { ed = new TextEditor(app, s, s.elements[0] as ShapeElement, document.body, { x: 0, y: 0, w: 300, h: 80, rot: 0 }); } finally { HTMLElement.prototype.focus = orig; }
    expect(focused).toContain(ed.root);
    expect(ed.root.contains(window.getSelection()!.anchorNode)).toBe(true);
    ed.destroy();
  });
  it('strips control characters from pasted text (10)', () => {
    expect(cleanPastedText('a\x00b\x07c\r\nd\x0Be\x1Ff\tg')).toBe('abc\nd\nef\tg');
  });
});

describe('lines keep a zero extent (5)', () => {
  it('nudging a horizontal line keeps h = 0', () => {
    const { ui, app, s } = mk();
    const ln = ops.newShape(app, 'line', { x: 100, y: 100, w: 200, h: 0 });
    ops.insertElement(app, ln); ui.select([ln.id]);
    ops.nudge(app, 2, 0);
    const e = s().elements.find((x) => x.id === ln.id)!;
    expect([e.x, e.y, e.w, e.h]).toEqual([102, 100, 200, 0]);
  });
  it('a negative extent mirrors a line', () => {
    const { app, s } = mk();
    const ln = ops.newShape(app, 'straightConnector1', { x: 100, y: 100, w: 200, h: 50 });
    ops.insertElement(app, ln);
    const e = s().elements.find((x) => x.id === ln.id)!;
    ops.edit(app, 'Resize', () => ops.setBox(app, e, { w: -60, h: -20 }));
    expect([e.x, e.y, e.w, e.h, e.flipH, e.flipV]).toEqual([40, 80, 60, 20, true, true]);
  });
  it('ordinary shapes still get at least 1pt', () => {
    const { app, s } = mk();
    const r = ops.newShape(app, 'rect', { x: 0, y: 0, w: 10, h: 10 });
    ops.insertElement(app, r);
    const e = s().elements.find((x) => x.id === r.id)!;
    ops.setBox(app, e, { w: 0, h: -5 });
    expect([e.w, e.h]).toEqual([1, 1]);
  });
});

describe('duplicating / grouping placeholders keeps their look (6)', () => {
  it('duplicate of the title keeps the title style', () => {
    const { d, ui, app, s } = mk();
    const t = s().elements[0] as ShapeElement;
    t.text = { paras: [{ level: 0, runs: [{ text: 'Title' }] }] };
    const orig = levelStyle(d, s(), t, 0);
    const origBody = resolveBody(d, s(), t);
    ui.select([t.id]); ops.duplicateSelection(app);
    const c = s().elements[s().elements.length - 1] as ShapeElement;
    expect(c.ph).toBeUndefined();
    const st = levelStyle(d, s(), c, 0);
    expect(st.run?.size).toBe(orig.run?.size);
    expect(st.run?.size).not.toBe(18);
    expect(st.align).toBe(orig.align);
    expect(st.bullet?.kind ?? 'none').toBe(orig.bullet?.kind ?? 'none');
    const body = resolveBody(d, s(), c);
    expect(body.anchor).toBe(origBody.anchor);
    expect(c.fill).toEqual({ type: 'none' });
    expect(c.text!.paras[0].runs[0].text).toBe('Title');
  });
  it('grouped placeholder keeps body bullets and sizes', () => {
    const { d, ui, app, s } = mk();
    const ph = s().elements.find((e) => e.ph && e.ph.type !== 'title' && e.ph.type !== 'ctrTitle') || s().elements[0];
    const other = ops.newShape(app, 'rect', { x: 10, y: 10, w: 20, h: 20 });
    ops.insertElement(app, other);
    const orig = [0, 1].map((lv) => levelStyle(d, s(), ph, lv));
    ui.select([ph.id, other.id]); ops.group(app);
    const g = s().elements.find((x) => x.kind === 'group') as GroupElement;
    const c = g.children.find((x) => x.id === ph.id)!;
    expect(c.ph).toBeUndefined();
    [0, 1].forEach((lv) => {
      const st = levelStyle(d, s(), c, lv);
      expect(st.run?.size).toBe(orig[lv].run?.size);
      expect(st.bullet?.kind ?? 'none').toBe(orig[lv].bullet?.kind ?? 'none');
      expect(st.marL ?? 0).toBe(orig[lv].marL ?? 0);
    });
  });
});

describe('selection order does not change stacking (7)', () => {
  it('group children follow z-order', () => {
    const { ui, app, s } = mk();
    const a = ops.newShape(app, 'rect', { x: 100, y: 100, w: 100, h: 50 });
    const b = ops.newShape(app, 'ellipse', { x: 120, y: 100, w: 100, h: 50 });
    ops.insertElement(app, a); ops.insertElement(app, b);
    ui.select([b.id, a.id]); ops.group(app);
    const g = s().elements.find((x) => x.kind === 'group') as GroupElement;
    expect(g.children.map((c) => c.id)).toEqual([a.id, b.id]);
  });
  it('duplicates follow z-order and groups move with their children', () => {
    const { ui, app, s } = mk();
    const a = ops.newShape(app, 'rect', { x: 100, y: 100, w: 100, h: 50 });
    const b = ops.newShape(app, 'ellipse', { x: 120, y: 100, w: 100, h: 50 });
    ops.insertElement(app, a); ops.insertElement(app, b);
    ui.select([b.id, a.id]); ops.duplicateSelection(app);
    const n = s().elements.length;
    const [ca, cb] = s().elements.slice(n - 2) as ShapeElement[];
    expect([ca.geom, cb.geom]).toEqual(['rect', 'ellipse']);
    ui.select([a.id, b.id]); ops.group(app);
    const g = s().elements.find((x) => x.kind === 'group') as GroupElement;
    ui.select([g.id]); ops.duplicateSelection(app, 10, 20);
    const g2 = s().elements[s().elements.length - 1] as GroupElement;
    expect(g2.x).toBe(g.x! + 10);
    expect(g2.children[0].x).toBe(g.children[0].x! + 10);
    expect(g2.children[0].y).toBe(g.children[0].y! + 20);
  });
});

describe('resizing a rotated box keeps the opposite edge (3)', () => {
  it('east handle on a 90deg box', () => {
    const old = { x: 100, y: 100, w: 100, h: 50, rot: 90 };
    // Widen by 40 in the local frame (west edge anchored).
    const nb = { x: 100, y: 100, w: 140, h: 50 };
    const o = rotatedResizeOrigin(old, nb);
    const westMid = (b: { x: number; y: number; w: number; h: number }) => toPage({ id: '', kind: 'shape', geom: 'rect', ...b, rot: 90 } as any, [0, b.h / 2]);
    close(westMid({ ...nb, ...o }), westMid(old));
  });
});
