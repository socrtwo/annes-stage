/** Edit commands: clipboard (objects, slides, text, pictures), undo/redo, find and replace, selection, format painter. */
import { def } from './registry';
import type { App } from '../app';
import type { Deck } from '../model/deck';
import type { Element, Layout, Paragraph, ShapeElement, Slide, Fill, Line, Effects, RunProps, ParaProps } from '../model/types';
import { clone, newId } from '../model/deck';
import { resolveBox } from '../model/inherit';
import { edit, selection, deleteSelection, duplicateSelection, reId, forEachText, shapeText, textTargets, insertElement, newTextBox } from '../edit/ops';
import { activeTextEditor } from '../edit/textEdit';
import { openDialog, toast } from '../ui/dialog';
import { readClipboardText, writeClipboardText } from '../platform/native';
import { registerPane, canEdit } from '../ui/panes';
import { h, clear, icon } from '../ui/dom';

export interface ClipItem { kind: 'elements' | 'slides'; data: any; media: Record<string, any>; text: string; time: number; design?: { layouts: Layout[]; masters: any[]; themes: any[] } }

/** Clipboard history shown in the Clipboard pane (newest first). */
export const clipHistory: ClipItem[] = [];

function collectMedia(deck: Deck, json: string): Record<string, any> {
  const out: Record<string, any> = {};
  for (const id of Object.keys(deck.media)) if (json.includes(`"${id}"`)) out[id] = deck.media[id];
  return out;
}

function putClip(app: App, item: ClipItem): void {
  app.clip = item;
  clipHistory.unshift(item);
  if (clipHistory.length > 24) clipHistory.pop();
  void writeClipboardText(item.text);
  if (app.ui.paneOpen('clipboard')) app.refresh();
}

function copySelection(app: App): boolean {
  const deck = app.deck;
  const o = app.owner;
  // Slides: when the thumbnail rail or sorter has focus, or nothing is selected on the canvas.
  const railFocus = !!document.activeElement?.closest?.('.qs-rail, .qs-sorter');
  const els = selection(app);
  if ((railFocus || !els.length || app.tab.view === 'sorter') && app.tab.view !== 'master') {
    const slides = app.targetSlides();
    if (!slides.length) return false;
    const data = clone(slides);
    const json = JSON.stringify(data);
    const layouts = [...new Set(slides.map((s) => s.layout))].map((id) => clone(deck.layout(id)));
    const masters = [...new Set(layouts.map((l) => l.master))].map((id) => clone(deck.master(id)));
    const themes = [...new Set(masters.map((m) => m.theme))].map((id) => clone(deck.theme(id)));
    putClip(app, { kind: 'slides', data, media: collectMedia(deck, json + JSON.stringify(layouts) + JSON.stringify(masters)), text: slides.map((s) => s.elements.map(shapeText).filter(Boolean).join('\n')).join('\n\n'), time: Date.now(), design: { layouts, masters, themes } });
    toast(`${slides.length} slide${slides.length > 1 ? 's' : ''} copied`);
    return true;
  }
  if (!o || !els.length) return false;
  // Store resolved geometry so pasted placeholders keep their place on other layouts.
  const data = els.map((e) => { const c = clone(e); const b = resolveBox(deck, o, e); Object.assign(c, { x: b.x, y: b.y, w: b.w, h: b.h }); return c; });
  const json = JSON.stringify(data);
  putClip(app, { kind: 'elements', data, media: collectMedia(deck, json), text: els.map(shapeText).filter(Boolean).join('\n'), time: Date.now() });
  return true;
}

/** Pastes slides from the clipboard after the current slide; mode decides their design. */
export function pasteSlides(app: App, item: ClipItem, mode: 'dest' | 'keep' = 'dest'): void {
  const deck = app.deck;
  const slides: Slide[] = clone(item.data);
  for (const [k, v] of Object.entries(item.media)) if (!deck.media[k]) deck.media[k] = v;
  const at = Math.max(0, deck.slideIndex(app.tab.current)) + 1;
  deck.transact('Paste Slides', () => {
    const layoutMap = new Map<string, string>();
    if (mode === 'keep' && item.design) {
      // Bring the source design along (new ids so it never collides).
      const themeMap = new Map<string, string>(), masterMap = new Map<string, string>();
      for (const t of item.design.themes) { if (deck.data.themes.some((x) => x.id === t.id && JSON.stringify(x) === JSON.stringify(t))) { themeMap.set(t.id, t.id); continue; } const nt = { ...clone(t), id: newId('th') }; themeMap.set(t.id, nt.id); deck.data.themes.push(nt); }
      for (const m of item.design.masters) { if (deck.data.masters.some((x) => x.id === m.id)) { masterMap.set(m.id, m.id); continue; } const nm = { ...clone(m), id: newId('mst'), theme: themeMap.get(m.theme) || m.theme }; masterMap.set(m.id, nm.id); deck.data.masters.push(nm); }
      for (const l of item.design.layouts) { if (deck.data.layouts.some((x) => x.id === l.id)) { layoutMap.set(l.id, l.id); continue; } const nl = { ...clone(l), id: newId('lay'), master: masterMap.get(l.master) || l.master }; layoutMap.set(l.id, nl.id); deck.data.layouts.push(nl); }
    } else {
      // Use the destination theme: the layout of the same type (or name) in the current master.
      const cur = deck.slide(app.tab.current);
      const master = cur ? deck.layout(cur.layout).master : deck.data.masters[0].id;
      for (const s of slides) {
        if (layoutMap.has(s.layout)) continue;
        if (deck.data.layouts.some((l) => l.id === s.layout)) { layoutMap.set(s.layout, s.layout); continue; }
        const src = item.design?.layouts.find((l) => l.id === s.layout);
        const match = deck.layoutsOf(master).find((l) => src && l.type && l.type === src.type) || deck.layoutsOf(master).find((l) => src && l.name === src.name) || deck.layoutsOf(master)[1] || deck.data.layouts[0];
        layoutMap.set(s.layout, match.id);
      }
    }
    const ids: string[] = [];
    slides.forEach((s, i) => {
      s.id = newId('sld');
      s.layout = layoutMap.get(s.layout) || s.layout;
      s.elements = s.elements.map((e) => reId(e));
      s.anims = [];
      deck.data.slides.splice(at + i, 0, s);
      ids.push(s.id);
    });
    app.tab.current = ids[0];
    app.tab.slideSel = ids;
  });
}

function pasteElements(app: App, item: ClipItem, asText = false): void {
  const deck = app.deck;
  for (const [k, v] of Object.entries(item.media)) if (!deck.media[k]) deck.media[k] = v;
  if (asText) { if (item.text) insertElement(app, newTextBox(app, item.text), 'Paste'); return; }
  const els: Element[] = clone(item.data).map((e: Element) => reId(e));
  const o = app.owner;
  // Pasting onto the same slide offsets the copies so they are visible.
  const same = o && els.some((e) => o.elements.some((x) => x.x === e.x && x.y === e.y));
  edit(app, 'Paste', (own) => {
    for (const e of els) {
      if (same) { e.x = (e.x || 0) + 12; e.y = (e.y || 0) + 12; if (e.kind === 'group') for (const c of e.children) { c.x = (c.x || 0) + 12; c.y = (c.y || 0) + 12; } }
      // A placeholder pasted onto a slide that already has one of its type becomes an ordinary shape.
      if (e.ph && own.elements.some((x) => x.ph?.type === e.ph!.type && (x.ph.idx ?? 0) === (e.ph!.idx ?? 0))) delete e.ph;
      own.elements.push(e);
    }
  });
  app.tab.ui.select(els.map((e) => e.id));
}

async function pasteFromSystem(app: App, mode: 'auto' | 'text' | 'picture' = 'auto'): Promise<void> {
  // Pictures on the system clipboard
  try {
    if (mode !== 'text' && (navigator.clipboard as any)?.read) {
      const items = await (navigator.clipboard as any).read();
      for (const it of items) {
        const type = it.types.find((t: string) => t.startsWith('image/'));
        if (type) {
          const blob = await it.getType(type);
          const buf = new Uint8Array(await blob.arrayBuffer());
          app.exec('insert.pictureFiles', [new File([buf], 'Pasted picture', { type })]);
          return;
        }
      }
    }
  } catch { /* permission denied or unsupported */ }
  const text = await readClipboardText();
  if (app.clip && (text == null || text === app.clip.text || !text)) {
    if (app.clip.kind === 'slides') pasteSlides(app, app.clip);
    else pasteElements(app, app.clip, mode === 'text');
    return;
  }
  if (!text) { toast('The clipboard is empty, or this browser does not allow reading it here. Use Ctrl+V.'); return; }
  // Text: into the selected shape when one is selected, otherwise a new text box.
  const targets = textTargets(app);
  if (targets.length === 1 && targets[0].kind === 'shape') {
    app.tab.ui.editText(targets[0].id);
    requestAnimationFrame(() => document.execCommand('insertText', false, text));
    return;
  }
  insertElement(app, newTextBox(app, text.replace(/\r\n?/g, '\n')), 'Paste');
}

// ------------------------------------------------------------------------------------------
// Format painter

interface CopiedFormat { fill?: Fill; line?: Line; effects?: Effects; run?: RunProps; para?: ParaProps; geom?: string }

function copyFormat(app: App): CopiedFormat | null {
  const ed = activeTextEditor();
  if (ed) return { run: ed.caretRun(), para: stripPara(ed.caretPara()) };
  const e = selection(app)[0];
  if (!e) return null;
  const f: CopiedFormat = {};
  if (e.kind === 'shape') {
    f.fill = e.fill; f.line = e.line; f.effects = e.effects;
    const p = e.text?.paras[0];
    if (p) { f.run = { ...(p.runs[0] || p.end || {}) }; delete (f.run as any).text; f.para = stripPara(p); }
  } else if (e.kind === 'picture') { f.line = e.line; f.effects = e.effects; }
  return f;
}

function stripPara(p: Partial<Paragraph>): ParaProps {
  const { runs: _r, level: _l, end: _e, ...rest } = p as any;
  return rest;
}

function pasteFormat(app: App, f: CopiedFormat): void {
  const ed = activeTextEditor();
  if (ed) { if (f.run) ed.applyRun(f.run); return; }
  const els = selection(app);
  if (!els.length) return;
  edit(app, 'Paste Formatting', () => {
    for (const e of els) {
      if (e.kind === 'shape') {
        if (f.fill !== undefined) e.fill = clone(f.fill);
        if (f.line !== undefined) e.line = clone(f.line);
        if (f.effects !== undefined) e.effects = clone(f.effects);
        if (f.run || f.para) for (const p of e.text?.paras || []) { if (f.para) Object.assign(p, f.para); if (f.run) for (const r of p.runs) Object.assign(r, f.run); }
      } else if (e.kind === 'picture') { if (f.line !== undefined) e.line = clone(f.line); if (f.effects !== undefined) e.effects = clone(f.effects); }
    }
  });
}

let painterWatch: (() => void) | null = null;

function startPainter(app: App, sticky: boolean): void {
  const f = copyFormat(app);
  if (!f) { toast('Select a shape or text whose formatting you want to copy.'); return; }
  painterWatch?.();
  app.painter = { fmt: f, sticky };
  const source = new Set(app.tab.ui.selection);
  let last = [...source].join(',');
  document.body.classList.add('qs-painting');
  toast(sticky ? 'Format Painter is on: click objects to apply. Press Esc or click Format Painter again to stop.' : 'Click an object to apply the formatting.');
  const stop = () => { painterWatch?.(); painterWatch = null; app.painter = null; document.body.classList.remove('qs-painting'); document.removeEventListener('keydown', esc, true); app.refresh(); };
  const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') stop(); };
  document.addEventListener('keydown', esc, true);
  painterWatch = app.onRefresh(() => {
    const cur = app.tab.ui.selection.join(',');
    if (cur === last || !cur) return;
    last = cur;
    if (app.tab.ui.selection.every((id) => source.has(id))) return;
    const p = app.painter;
    if (!p) return;
    pasteFormat(app, p.fmt);
    if (!p.sticky) stop();
  });
  const off = painterWatch;
  painterWatch = () => { off(); };
}

// ------------------------------------------------------------------------------------------
// Find and replace

/** A match: slide, element (null for notes), text-body index within the slide (one per shape, table cell or notes), paragraph and offset. */
export interface Hit { slide: string; el: string | null; body: number; para: number; off: number; len: number }
export interface FindOpts { matchCase: boolean; whole: boolean; notes: boolean }

/** The regular expression Find uses; whole words use Unicode-aware boundaries so "C++" and "café" work. */
export function findRegExp(needle: string, opts: { matchCase: boolean; whole: boolean }): RegExp {
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(opts.whole ? `(?<![\\p{L}\\p{N}_])${esc}(?![\\p{L}\\p{N}_])` : esc, opts.matchCase ? 'gu' : 'giu');
}

export function findAll(deck: Deck, needle: string, opts: FindOpts): Hit[] {
  if (!needle) return [];
  const re = findRegExp(needle, opts);
  const hits: Hit[] = [];
  for (const s of deck.slides) {
    let body = -1;
    forEachText([s], (paras, el) => {
      body++;
      paras.forEach((p, pi) => {
        const t = p.runs.map((r) => (r.br ? '\n' : r.text)).join('');
        for (const m of t.matchAll(re)) if (m[0].length) hits.push({ slide: s.id, el: el ? el.id : null, body, para: pi, off: m.index!, len: m[0].length });
      });
    }, opts.notes);
  }
  return hits;
}

/** The paragraph a hit points into (the same table cell, not just the same table). */
function hitPara(deck: Deck, h2: Hit, notes: boolean): Paragraph | undefined {
  const s = deck.slide(h2.slide);
  if (!s) return undefined;
  let body = -1, out: Paragraph | undefined;
  forEachText([s], (paras, el) => { if (++body === h2.body && (el?.id ?? null) === h2.el) out = paras[h2.para]; }, notes);
  return out;
}

/** Compares hit positions in document order. */
function cmpPos(a: Hit, b: { slide: string; body: number; para: number; off: number }, deck: Deck): number {
  return deck.slideIndex(a.slide) - deck.slideIndex(b.slide) || a.body - b.body || a.para - b.para || a.off - b.off;
}

/**
 * Replaces hit `at` (or the first match) and returns the index of the next match after the inserted text,
 * so the replacement is never matched again; -1 when there are no more matches after it.
 */
export function replaceOne(deck: Deck, needle: string, repl: string, opts: FindOpts, at: number): { replaced: boolean; next: number; hits: Hit[] } {
  let hits = findAll(deck, needle, opts);
  if (!hits.length || at >= hits.length) return { replaced: false, next: -1, hits };
  const h2 = hits[Math.max(0, at)];
  deck.transact('Replace', () => { const p = hitPara(deck, h2, opts.notes); if (p) replaceInPara(p, h2.off, h2.len, repl); }, [h2.slide]);
  hits = findAll(deck, needle, opts);
  const after = { slide: h2.slide, body: h2.body, para: h2.para, off: h2.off + repl.length };
  const next = hits.findIndex((x) => cmpPos(x, after, deck) >= 0);
  return { replaced: true, next, hits };
}

/** Replaces every match; returns how many. */
export function replaceAll(deck: Deck, needle: string, repl: string, opts: FindOpts): number {
  const all = findAll(deck, needle, opts);
  if (!all.length) return 0;
  deck.transact('Replace All', () => {
    // Resolve each paragraph first, then replace from the end so earlier offsets stay valid.
    const targets = all.map((h2) => ({ h2, p: hitPara(deck, h2, opts.notes) }));
    targets.sort((a, b) => b.h2.off - a.h2.off);
    for (const { h2, p } of targets) if (p) replaceInPara(p, h2.off, h2.len, repl);
  });
  return all.length;
}

/** Replaces [off, off+len) of a paragraph's text, keeping the formatting of the first affected run. */
export function replaceInPara(p: Paragraph, off: number, len: number, text: string): void {
  let pos = 0;
  const out: typeof p.runs = [];
  let inserted = false;
  for (const r of p.runs) {
    const rl = r.br ? 1 : r.text.length;
    const s = pos, e = pos + rl;
    pos = e;
    if (r.br || e <= off || s >= off + len) { if (s >= off + len && !inserted && len === 0 && s === off) { out.push({ ...r, text }); inserted = true; } out.push(r); continue; }
    const a = Math.max(off, s) - s, b = Math.min(off + len, e) - s;
    const keep = r.text.slice(0, a) + (inserted ? '' : text) + r.text.slice(b);
    inserted = true;
    if (keep) out.push({ ...r, text: keep });
  }
  p.runs = out;
}

async function findDialog(app: App, replace: boolean): Promise<void> {
  const sel = activeTextEditor()?.selectedText() || '';
  let hits: Hit[] = [];
  let at = -1;
  const opts = () => ({ matchCase: !!ctlRef?.get('case'), whole: !!ctlRef?.get('whole'), notes: !!ctlRef?.get('notes') });
  let ctlRef: any = null;
  const show = (h2: Hit) => {
    app.goToSlide(h2.slide);
    if (h2.el) app.tab.ui.select([h2.el]);
    app.ui.status(`Match ${at + 1} of ${hits.length}`);
  };
  await openDialog({
    title: replace ? 'Replace' : 'Find', modeless: true,
    fields: [
      { key: 'q', label: 'Find what', type: 'text', value: sel },
      ...(replace ? [{ key: 'r', label: 'Replace with', type: 'text' as const, value: '' }] : []),
      { key: 'case', label: 'Match case', type: 'checkbox', value: false, half: true },
      { key: 'whole', label: 'Find whole words only', type: 'checkbox', value: false, half: true },
      { key: 'notes', label: 'Search speaker notes too', type: 'checkbox', value: true },
    ],
    buttons: [
      { label: 'Find Next', onClick: (v: any, ctl: any) => { ctlRef = ctl; hits = findAll(app.deck, v.q, opts()); if (!hits.length) { toast(`"${v.q}" was not found.`); return; } at = at + 1 >= hits.length ? 0 : at + 1; show(hits[at]); } },
      ...(replace ? [
        { label: 'Replace', onClick: (v: any, ctl: any) => {
          ctlRef = ctl;
          if (app.isReadOnly()) { toast('This presentation is read-only.'); return; }
          if (at >= hits.length && hits.length) { toast('Reached the end of the presentation.'); at = -1; return; }
          const r = replaceOne(app.deck, v.q, v.r ?? '', opts(), at);
          hits = r.hits;
          if (!r.replaced) { toast(`"${v.q}" was not found.`); return; }
          if (r.next < 0) { at = hits.length; app.ui.status('Reached the end of the presentation.'); return; }
          at = r.next;
          show(hits[at]);
        } },
        { label: 'Replace All', onClick: (v: any, ctl: any) => {
          ctlRef = ctl;
          if (app.isReadOnly()) { toast('This presentation is read-only.'); return; }
          const n = replaceAll(app.deck, v.q, v.r ?? '', opts());
          if (!n) { toast(`"${v.q}" was not found.`); return; }
          hits = []; at = -1;
          toast(`Replaced ${n} occurrence${n > 1 ? 's' : ''}.`);
        } },
      ] : []),
    ],
    ok: 'Close', cancel: false,
  } as any);
}

// ------------------------------------------------------------------------------------------

def([
  {
    id: 'edit.undo', label: 'Undo', icon: 'undo', tab: 'Home', group: 'Undo', keys: ['Mod-z'], popular: true, noRecord: true,
    tip: 'Undo the last change', isEnabled: (app) => app.tab?.ui?.editingText || !!app.deck?.canUndo,
    kind: 'split', menu: (app) => app.deck.undoLabels().slice(0, 20).map((l, i) => ({ id: 'edit.undo', arg: i + 1, label: l })),
    run: (app, n?: number) => {
      if (app.tab.ui.editingText) { document.execCommand('undo'); return; }
      for (let i = 0; i < (typeof n === 'number' ? n : 1); i++) app.deck.undo();
      app.tab.ui.select(app.tab.ui.selection);
    },
  },
  {
    id: 'edit.redo', label: 'Redo', icon: 'redo', tab: 'Home', group: 'Undo', keys: ['Mod-y', 'Mod-Shift-z', 'F4'], popular: true, noRecord: true,
    tip: 'Redo the last undone change, or repeat the last command',
    run: (app) => {
      if (app.tab.ui.editingText) { document.execCommand('redo'); return; }
      if (app.deck.canRedo) { app.deck.redo(); return; }
      const last = app.lastCommand;
      if (last && last.id !== 'edit.redo') app.exec(last.id, last.arg);
    },
  },
  { id: 'edit.repeat', label: 'Repeat', icon: 'repeat', tab: 'Home', group: 'Undo', noRecord: true, run: (app) => { const l = app.lastCommand; if (l) app.exec(l.id, l.arg); } },
  {
    id: 'edit.cut', label: 'Cut', icon: 'content_cut', tab: 'Home', group: 'Clipboard', keys: ['Mod-x', 'Shift-Delete'], popular: true, edits: true,
    run: (app) => {
      if (app.tab.ui.editingText) { document.execCommand('cut'); return; }
      if (!copySelection(app)) return;
      if (app.clip?.kind === 'slides') app.exec('slide.delete');
      else deleteSelection(app);
    },
  },
  {
    id: 'edit.copy', label: 'Copy', icon: 'content_copy', tab: 'Home', group: 'Clipboard', keys: ['Mod-c', 'Mod-Insert'], popular: true, noRecord: true,
    run: (app) => { if (app.tab.ui.editingText) { document.execCommand('copy'); return; } copySelection(app); },
  },
  {
    id: 'edit.paste', label: 'Paste', icon: 'content_paste', tab: 'Home', group: 'Clipboard', keys: ['Mod-v', 'Shift-Insert'], popular: true, edits: true, kind: 'split',
    menu: () => [
      { id: 'edit.pasteDestTheme', label: 'Use Destination Theme', icon: 'format_paint' }, { id: 'edit.pasteKeepSource', label: 'Keep Source Formatting', icon: 'palette' },
      { id: 'edit.pastePicture', label: 'Picture', icon: 'image' }, { id: 'edit.pasteText', label: 'Keep Text Only', icon: 'text_fields' },
      { separator: true }, { id: 'edit.pasteSpecial', label: 'Paste Special…', icon: 'content_paste_go' },
    ],
    run: async (app) => {
      if (app.tab.ui.editingText) {
        // Inside text: paste as plain text in the current formatting.
        const t = await readClipboardText();
        if (t != null) document.execCommand('insertText', false, t);
        else document.execCommand('paste');
        return;
      }
      await pasteFromSystem(app);
    },
  },
  { id: 'edit.pasteDestTheme', label: 'Paste: Use Destination Theme', icon: 'format_paint', tab: 'Home', group: 'Clipboard', edits: true, run: (app) => { const c = app.clip; if (!c) return pasteFromSystem(app); if (c.kind === 'slides') pasteSlides(app, c, 'dest'); else pasteElements(app, c); } },
  { id: 'edit.pasteKeepSource', label: 'Paste: Keep Source Formatting', icon: 'palette', tab: 'Home', group: 'Clipboard', edits: true, run: (app) => { const c = app.clip; if (!c) return pasteFromSystem(app); if (c.kind === 'slides') pasteSlides(app, c, 'keep'); else pasteElements(app, c); } },
  { id: 'edit.pasteText', label: 'Paste: Keep Text Only', icon: 'text_fields', tab: 'Home', group: 'Clipboard', keys: ['Mod-Alt-Shift-v'], edits: true, run: (app) => pasteFromSystem(app, 'text') },
  {
    id: 'edit.pastePicture', label: 'Paste as Picture', icon: 'image', tab: 'Home', group: 'Clipboard', edits: true,
    tip: 'Paste the copied objects as one picture',
    run: async (app) => {
      const c = app.clip;
      if (!c || c.kind !== 'elements') return pasteFromSystem(app, 'picture');
      // Render the copied objects on an empty slide and crop to their bounds.
      const els: Element[] = c.data;
      const x = Math.min(...els.map((e) => e.x || 0)), y = Math.min(...els.map((e) => e.y || 0));
      const r = Math.max(...els.map((e) => (e.x || 0) + (e.w || 0))), b = Math.max(...els.map((e) => (e.y || 0) + (e.h || 0)));
      const deck = app.deck;
      for (const [k, v] of Object.entries(c.media)) if (!deck.media[k]) deck.media[k] = v;
      const { slideSvg } = await import('../render/slide');
      const tmp: Slide = { id: 'tmp', layout: deck.data.layouts.find((l) => l.type === 'blank')?.id || deck.data.layouts[0].id, elements: clone(els), notes: [], anims: [], bg: { type: 'none' }, hideMasterShapes: true };
      const svg = slideSvg(deck, tmp, { mode: 'show' }).replace(/viewBox="[^"]*"/, `viewBox="${x} ${y} ${r - x} ${b - y}"`).replace(/ width="[^"]*" height="[^"]*"/, ` width="${r - x}" height="${b - y}"`).replace(/<rect x="0" y="0" width="[^"]*" height="[^"]*" fill="[^"]*" class="qs-bg"\/>/, '');
      const b64 = btoa(unescape(encodeURIComponent(svg)));
      const media = deck.addMedia({ mime: 'image/svg+xml', b64, name: 'Pasted picture.svg' });
      insertElement(app, { id: newId('pic'), kind: 'picture', media, name: 'Picture', x: x + 12, y: y + 12, w: r - x, h: b - y }, 'Paste as Picture');
    },
  },
  {
    id: 'edit.pasteSpecial', label: 'Paste Special…', icon: 'content_paste_go', tab: 'Home', group: 'Clipboard', keys: ['Mod-Alt-v'], edits: true,
    run: async (app) => {
      const c = app.clip;
      const opts = [
        ...(c?.kind === 'slides' ? [{ value: 'edit.pasteDestTheme', label: 'Slides using the destination theme' }, { value: 'edit.pasteKeepSource', label: 'Slides keeping their source formatting' }] : []),
        ...(c?.kind === 'elements' ? [{ value: 'edit.pasteDestTheme', label: 'Anne\'s Stage objects' }, { value: 'edit.pastePicture', label: 'Picture (SVG)' }] : []),
        { value: 'edit.pasteText', label: 'Unformatted text' },
      ];
      const r = await openDialog({ title: 'Paste Special', fields: [{ key: 'as', label: 'As', type: 'radio', options: opts, value: opts[0].value }] });
      if (r) app.exec(r.as);
    },
  },
  { id: 'edit.duplicate', label: 'Duplicate', icon: 'control_point_duplicate', tab: 'Home', group: 'Clipboard', keys: ['Mod-d'], edits: true, tip: 'Duplicate the selected objects (or the current slide when nothing is selected)', run: (app) => { if (selection(app).length) duplicateSelection(app); else app.exec('slide.duplicate'); } },
  {
    id: 'edit.formatPainter', label: 'Format Painter', icon: 'format_paint', tab: 'Home', group: 'Clipboard', kind: 'toggle', noRecord: true,
    tip: 'Copy formatting from the selection to the next object you click. Double-click (or long-press ▸ Keep Format Painter On) to apply it to several.',
    isActive: (app) => !!app.painter,
    run: (app, arg) => { if (app.painter) { painterWatch?.(); painterWatch = null; app.painter = null; document.body.classList.remove('qs-painting'); return; } startPainter(app, arg === 'sticky'); },
  },
  { id: 'edit.copyFormat', label: 'Copy Formatting', icon: 'format_paint', tab: 'Home', group: 'Clipboard', keys: ['Mod-Shift-c'], noRecord: true, run: (app) => { const f = copyFormat(app); if (f) { (app as any).copiedFormat = f; toast('Formatting copied'); } } },
  { id: 'edit.pasteFormat', label: 'Paste Formatting', icon: 'format_paint', tab: 'Home', group: 'Clipboard', keys: ['Mod-Shift-v'], edits: true, run: (app) => { const f = (app as any).copiedFormat; if (f) pasteFormat(app, f); else toast('Copy formatting first (Ctrl+Shift+C).'); } },
  { id: 'edit.clipboardPane', label: 'Clipboard', icon: 'content_paste_search', tab: 'Home', group: 'Clipboard', noRecord: true, run: (app) => app.ui.togglePane('clipboard') },
  {
    id: 'edit.selectAll', label: 'Select All', icon: 'select_all', tab: 'Home', group: 'Editing', keys: ['Mod-a'], noRecord: true,
    run: (app) => {
      if (app.tab.ui.editingText) { document.execCommand('selectAll'); return; }
      if (document.activeElement?.closest?.('.qs-rail, .qs-sorter') || app.tab.view === 'sorter') { app.tab.slideSel = app.deck.slides.map((s) => s.id); app.tab.ui.invalidate(); app.refresh(); return; }
      app.tab.ui.select((app.owner?.elements || []).filter((e) => !e.hidden).map((e) => e.id));
    },
  },
  {
    id: 'edit.selectSimilar', label: 'Select Similar', icon: 'select', tab: 'Home', group: 'Editing', noRecord: true, kind: 'menu',
    menu: () => [{ id: 'edit.selectSimilar', arg: 'type', label: 'Same Type' }, { id: 'edit.selectSimilar', arg: 'fill', label: 'Same Fill' }, { id: 'edit.selectSimilar', arg: 'line', label: 'Same Outline' }],
    run: (app, kind = 'type') => {
      const ref = selection(app)[0];
      const o = app.owner;
      if (!ref || !o) { toast('Select an object first.'); return; }
      const key = (e: Element) => kind === 'fill' ? JSON.stringify((e as ShapeElement).fill || null) : kind === 'line' ? JSON.stringify((e as ShapeElement).line || null) : `${e.kind}:${(e as ShapeElement).geom || ''}:${e.ph?.type || ''}`;
      const k = key(ref);
      app.tab.ui.select(o.elements.filter((e) => key(e) === k).map((e) => e.id));
    },
  },
  {
    id: 'edit.selectMenu', label: 'Select', icon: 'arrow_selector_tool', tab: 'Home', group: 'Editing', kind: 'menu', noRecord: true,
    menu: () => [{ id: 'edit.selectAll', label: 'Select All', icon: 'select_all' }, { id: 'edit.selectSimilar', arg: 'type', label: 'Select Same Type' }, { id: 'edit.selectSimilar', arg: 'fill', label: 'Select Same Fill' }, { id: 'edit.selectSimilar', arg: 'line', label: 'Select Same Outline' }, { separator: true }, { id: 'home.selectionPane', label: 'Selection Pane…', icon: 'layers' }],
    run: (app) => app.exec('edit.selectAll'),
  },
  { id: 'edit.find', label: 'Find', icon: 'search', tab: 'Home', group: 'Editing', keys: ['Mod-f'], popular: true, noRecord: true, run: (app) => findDialog(app, false) },
  { id: 'edit.replace', label: 'Replace', icon: 'find_replace', tab: 'Home', group: 'Editing', keys: ['Mod-h'], noRecord: true, edits: true, run: (app) => findDialog(app, true) },
  {
    id: 'edit.replaceFonts', label: 'Replace Fonts…', icon: 'font_download', tab: 'Home', group: 'Editing', edits: true,
    tip: 'Change every use of one font to another, across all slides, layouts and masters',
    run: async (app) => {
      const d = app.deck;
      const used = new Set<string>();
      const scan = (els: Element[]) => forEachText([{ elements: els }], (paras) => { for (const p of paras) for (const r of p.runs) if (r.font) used.add(r.font); }, false);
      for (const s of d.slides) scan(s.elements);
      for (const l of d.data.layouts) scan(l.elements);
      for (const m of d.data.masters) { scan(m.elements); for (const lv of [...m.styles.title, ...m.styles.body, ...m.styles.other]) if (lv.run?.font) used.add(lv.run.font); }
      for (const t of d.data.themes) { used.add(t.fonts.major); used.add(t.fonts.minor); }
      const list = [...used].filter((f) => !f.startsWith('+')).sort();
      if (!list.length) { toast('This presentation uses only its theme fonts.'); return; }
      const r = await openDialog({ title: 'Replace Font', fields: [{ key: 'from', label: 'Replace', type: 'select', options: list, value: list[0] }, { key: 'to', label: 'With', type: 'text', value: 'Carlito' }] });
      if (!r?.to) return;
      d.transact('Replace Fonts', () => {
        const fix = (els: Element[]) => forEachText([{ elements: els }], (paras) => { for (const p of paras) { for (const rr of p.runs) if (rr.font === r.from) rr.font = r.to; if (p.end && p.end.font === r.from) p.end.font = r.to; } }, false);
        for (const s of d.slides) fix(s.elements);
        for (const l of d.data.layouts) fix(l.elements);
        for (const m of d.data.masters) { fix(m.elements); for (const lv of [...m.styles.title, ...m.styles.body, ...m.styles.other]) if (lv.run && lv.run.font === r.from) lv.run.font = r.to; }
        for (const t of d.data.themes) { if (t.fonts.major === r.from) t.fonts.major = r.to; if (t.fonts.minor === r.from) t.fonts.minor = r.to; }
      });
    },
  },
  { id: 'edit.delete', label: 'Delete', icon: 'delete', tab: 'Home', group: 'Editing', edits: true, run: (app) => { if (selection(app).length) deleteSelection(app); else app.exec('slide.delete'); } },
]);

// ------------------------------------------------------------------------------------------
// Panes

registerPane({
  id: 'clipboard', title: 'Clipboard',
  render(app, el) { this.update!(app, el, {}); },
  update(app, el) {
    const sig = String(clipHistory.length) + ':' + (clipHistory[0]?.time || 0);
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    clear(el);
    el.appendChild(h('div', { class: 'ql-row' }, h('button', { class: 'ql-btn', onclick: () => { clipHistory.length = 0; app.clip = null; el.dataset.sig = ''; app.refresh(); } }, 'Clear All')));
    if (!clipHistory.length) el.appendChild(h('p', { class: 'ql-help' }, 'Cut or copy objects, slides or text to collect items here, then click an item to paste it.'));
    for (const it of clipHistory) {
      const label = it.kind === 'slides' ? `${it.data.length} slide(s)` : `${it.data.length} object(s)`;
      el.appendChild(h('button', { class: 'ql-nav-item', onclick: () => { if (!canEdit(app)) return; app.clip = it; if (it.kind === 'slides') pasteSlides(app, it); else pasteElements(app, it); } }, icon(it.kind === 'slides' ? 'slideshow' : 'category'), h('span', null, label), h('span', { class: 'ql-help' }, (it.text || '').slice(0, 80))));
    }
  },
});

