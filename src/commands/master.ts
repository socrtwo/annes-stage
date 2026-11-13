/** Slide Master view: masters, layouts and their placeholders. */
import { def } from './registry';
import type { App } from '../app';
import type { Element, Layout, Master, PlaceholderType, ShapeElement } from '../model/types';
import { clone, defaultLayouts, defaultMaster, newId } from '../model/deck';
import { openDialog, toast, promptDialog } from '../ui/dialog';
import { isLayout, isMaster } from '../model/inherit';
import { esc } from '../ui/dom';

const inMaster = (app: App) => app.tab?.view === 'master';
const target = (app: App): Layout | Master | undefined => (inMaster(app) ? (app.owner as Layout | Master | undefined) : undefined);
const layoutTarget = (app: App): Layout | undefined => { const t = target(app); return t && isLayout(t) ? t : undefined; };
const masterOfTarget = (app: App): Master | undefined => { const t = target(app); return t ? (isMaster(t) ? t : app.deck.master(t.master)) : undefined; };

const PH_KINDS: { type: PlaceholderType; label: string; prompt: string }[] = [
  { type: 'obj', label: 'Content', prompt: 'Click to add text' },
  { type: 'body', label: 'Text', prompt: 'Click to add text' },
  { type: 'pic', label: 'Picture', prompt: 'Click to add picture' },
  { type: 'chart', label: 'Chart', prompt: 'Click to add chart' },
  { type: 'tbl', label: 'Table', prompt: 'Click to add table' },
  { type: 'media', label: 'Media', prompt: 'Click to add media' },
];

function nextIdx(l: Layout): number {
  return Math.max(0, ...l.elements.map((e) => e.ph?.idx ?? 0).filter((i) => i < 10)) + 1;
}

function newPlaceholder(app: App, type: PlaceholderType, idx: number | undefined, box: { x: number; y: number; w: number; h: number }, prompt = ''): ShapeElement {
  return { id: newId('ph'), kind: 'shape', geom: 'rect', name: `${type} ${idx ?? ''}`.trim(), ph: { type, ...(idx != null ? { idx } : {}) }, ...box, text: { paras: [{ level: 0, runs: prompt ? [{ text: prompt }] : [] }], autofit: type === 'body' || type === 'obj' ? 'shrink' : 'none' } };
}

function footerBoxes(app: App): Record<'dt' | 'ftr' | 'sldNum', { x: number; y: number; w: number; h: number; idx: number }> {
  const m = masterOfTarget(app) || app.deck.data.masters[0];
  const find = (t: string) => m.elements.find((e) => e.ph?.type === t);
  const { w, h } = app.deck.size;
  const sx = w / 960, sy = h / 540;
  const b = (t: string, x: number, ww: number, idx: number) => { const e = find(t); return { x: e?.x ?? x * sx, y: e?.y ?? 500.5 * sy, w: e?.w ?? ww * sx, h: e?.h ?? 28.75 * sy, idx }; };
  return { dt: b('dt', 66, 216, 10), ftr: b('ftr', 318, 324, 11), sldNum: b('sldNum', 678, 216, 12) };
}

def([
  {
    id: 'master.insertMaster', label: 'Insert Slide Master', icon: 'add_to_photos', tab: 'Slide Master', group: 'Edit Master', edits: true, isEnabled: inMaster,
    tip: 'Add another slide master with the standard layouts, using the current theme',
    run: (app) => {
      const d = app.deck;
      let id = '';
      d.transact('Insert Slide Master', () => {
        const theme = d.theme(masterOfTarget(app)?.theme);
        const m = defaultMaster(theme, d.size.w, d.size.h);
        m.name = `Custom Design ${d.data.masters.length + 1}`;
        d.data.masters.push(m);
        d.data.layouts.push(...defaultLayouts(m.id, d.size.w, d.size.h));
        id = m.id;
      });
      app.tab.masterTarget = id;
    },
  },
  {
    id: 'master.insertLayout', label: 'Insert Layout', icon: 'note_add', tab: 'Slide Master', group: 'Edit Master', edits: true,
    tip: 'Add a layout with a title (add more placeholders with Insert Placeholder)',
    run: (app) => {
      const d = app.deck;
      const m = masterOfTarget(app) || d.data.masters[0];
      const lay: Layout = { id: newId('lay'), name: 'Custom Layout', master: m.id, type: 'cust', elements: [] };
      const mt = m.elements.find((e) => e.ph?.type === 'title');
      if (mt) lay.elements.push({ ...clone(mt), id: newId('ph') } as Element);
      const fb = footerBoxes(app);
      for (const t of ['dt', 'ftr', 'sldNum'] as const) lay.elements.push(newPlaceholder(app, t, fb[t].idx, fb[t]));
      d.transact('Insert Layout', () => { const after = d.data.layouts.map((l) => l.id).lastIndexOf(d.layoutsOf(m.id).slice(-1)[0]?.id ?? ''); d.data.layouts.splice(after + 1, 0, lay); });
      app.tab.masterTarget = lay.id;
    },
  },
  {
    id: 'master.duplicateLayout', label: 'Duplicate Layout', icon: 'content_copy', tab: 'Slide Master', group: 'Edit Master', edits: true, isEnabled: (app) => !!layoutTarget(app),
    run: (app) => { const l = layoutTarget(app)!; const d = app.deck; const c: Layout = { ...clone(l), id: newId('lay'), name: `1_${l.name}` }; c.elements.forEach((e) => (e.id = newId('ph'))); d.transact('Duplicate Layout', () => d.data.layouts.splice(d.data.layouts.indexOf(l) + 1, 0, c)); app.tab.masterTarget = c.id; },
  },
  {
    id: 'master.renameLayout', label: 'Rename Layout', icon: 'edit', tab: 'Slide Master', group: 'Edit Master', edits: true, isEnabled: (app) => !!layoutTarget(app),
    run: async (app) => { const l = layoutTarget(app)!; const n = await promptDialog('Rename Layout', 'Layout name', l.name); if (n) app.deck.transact('Rename Layout', () => { l.name = n; }); },
  },
  {
    id: 'master.deleteLayout', label: 'Delete Layout', icon: 'delete', tab: 'Slide Master', group: 'Edit Master', edits: true, isEnabled: (app) => !!layoutTarget(app),
    tip: 'Delete the layout; slides that use it move to another layout you choose',
    run: async (app) => {
      const d = app.deck;
      const l = layoutTarget(app)!;
      const siblings = d.layoutsOf(l.master).filter((x) => x.id !== l.id);
      if (!siblings.length) { toast('A slide master needs at least one layout.'); return; }
      const users = d.slides.filter((s) => s.layout === l.id);
      let to = (siblings.find((x) => x.type === l.type) || siblings.find((x) => x.type === 'obj') || siblings[0]).id;
      if (users.length) {
        const r = await openDialog({ title: 'Delete Layout', fields: [{ key: 'i', type: 'info', html: `<p>${users.length} slide(s) use "${esc(l.name || '')}". Move them to:</p>` }, { key: 'to', label: 'Layout', type: 'select', options: siblings.map((x) => ({ value: x.id, label: x.name })), value: to }] });
        if (!r) return;
        to = r.to;
      }
      d.transact('Delete Layout', () => { for (const s of users) s.layout = to; d.data.layouts = d.data.layouts.filter((x) => x.id !== l.id); });
      app.tab.masterTarget = to;
    },
  },
  {
    id: 'master.delete', label: 'Delete', icon: 'delete', tab: 'Slide Master', group: 'Edit Master', edits: true, isEnabled: inMaster,
    tip: 'Delete the selected layout, or the selected slide master and its layouts (when no slides use them)',
    run: async (app) => {
      const t = target(app);
      if (!t) return;
      if (isLayout(t)) { await app.exec('master.deleteLayout'); return; }
      const d = app.deck;
      if (d.data.masters.length < 2) { toast('A presentation needs at least one slide master.'); return; }
      if ((t.keep as any)?.preserve) { toast('This master is preserved. Turn off Preserve to delete it.'); return; }
      const lays = new Set(d.layoutsOf(t.id).map((l) => l.id));
      const used = d.slides.filter((s) => lays.has(s.layout));
      const other = d.data.masters.find((m) => m.id !== t.id)!;
      d.transact('Delete Slide Master', () => {
        for (const s of used) { const old = d.layout(s.layout); s.layout = (d.layoutsOf(other.id).find((l) => l.type === old.type) || d.layoutsOf(other.id)[0]).id; }
        d.data.layouts = d.data.layouts.filter((l) => !lays.has(l.id));
        d.data.masters = d.data.masters.filter((m) => m.id !== t.id);
      });
      app.tab.masterTarget = other.id;
    },
  },
  {
    id: 'master.rename', label: 'Rename', icon: 'drive_file_rename_outline', tab: 'Slide Master', group: 'Edit Master', edits: true, isEnabled: inMaster,
    run: async (app) => { const t = target(app)!; const n = await promptDialog(isLayout(t) ? 'Rename Layout' : 'Rename Master', 'Name', t.name); if (n) app.deck.transact('Rename', () => { t.name = n; }); },
  },
  {
    id: 'master.preserve', label: 'Preserve', icon: 'push_pin', tab: 'Slide Master', group: 'Edit Master', kind: 'toggle', edits: true, isEnabled: (app) => !!target(app) && isMaster(target(app)!),
    tip: 'Keep this master even when no slides use it (Tools ▸ Remove Unused Masters and Layouts skips it)',
    isActive: (app) => { const t = target(app); return !!t && isMaster(t) && !!(t.keep as any)?.preserve; },
    run: (app) => { const t = target(app) as Master; app.deck.transact('Preserve Master', () => { t.keep = { ...(t.keep || {}) }; if (t.keep.preserve) delete t.keep.preserve; else t.keep.preserve = '1'; }); },
  },
  {
    id: 'master.insertPlaceholder', label: 'Insert Placeholder', icon: 'add_box', tab: 'Slide Master', group: 'Master Layout', kind: 'menu', edits: true, isEnabled: (app) => !!layoutTarget(app),
    tip: 'Add a placeholder to the layout',
    run: (app, type?: PlaceholderType) => {
      const l = layoutTarget(app);
      if (!l || !type) return;
      const k = PH_KINDS.find((x) => x.type === type) || PH_KINDS[0];
      const { w, h } = app.deck.size;
      const n = l.elements.filter((e) => e.ph && !['dt', 'ftr', 'sldNum', 'title'].includes(e.ph.type)).length;
      const el = newPlaceholder(app, k.type, nextIdx(l), { x: w * 0.25 + n * 14, y: h * 0.3 + n * 14, w: w * 0.5, h: h * 0.4 }, k.prompt);
      app.deck.transact('Insert Placeholder', () => l.elements.push(el));
      app.tab.ui.select([el.id]);
    },
    menu: () => PH_KINDS.map((k) => ({ id: 'master.insertPlaceholder', arg: k.type, label: k.label })),
  },
  {
    id: 'master.showTitle', label: 'Title', icon: 'title', tab: 'Slide Master', group: 'Master Layout', kind: 'toggle', edits: true, isEnabled: (app) => !!layoutTarget(app),
    tip: 'Show or remove the title placeholder on this layout',
    isActive: (app) => !!layoutTarget(app)?.elements.some((e) => e.ph?.type === 'title' || e.ph?.type === 'ctrTitle'),
    run: (app) => {
      const l = layoutTarget(app)!;
      const has = l.elements.some((e) => e.ph?.type === 'title' || e.ph?.type === 'ctrTitle');
      app.deck.transact(has ? 'Hide Title' : 'Show Title', () => {
        if (has) l.elements = l.elements.filter((e) => !(e.ph?.type === 'title' || e.ph?.type === 'ctrTitle'));
        else { const mt = app.deck.master(l.master).elements.find((e) => e.ph?.type === 'title'); l.elements.unshift(mt ? { ...clone(mt), id: newId('ph') } as Element : newPlaceholder(app, 'title', undefined, { x: 66, y: 28.8, w: app.deck.size.w - 132, h: 104.5 }, 'Click to edit title style')); }
      });
    },
  },
  {
    id: 'master.showFooters', label: 'Footers', icon: 'call_to_action', tab: 'Slide Master', group: 'Master Layout', kind: 'toggle', edits: true, isEnabled: (app) => !!layoutTarget(app),
    tip: 'Show or remove the date, footer and slide number placeholders on this layout',
    isActive: (app) => !!layoutTarget(app)?.elements.some((e) => e.ph && ['dt', 'ftr', 'sldNum'].includes(e.ph.type)),
    run: (app) => {
      const l = layoutTarget(app)!;
      const has = l.elements.some((e) => e.ph && ['dt', 'ftr', 'sldNum'].includes(e.ph.type));
      const fb = footerBoxes(app);
      app.deck.transact(has ? 'Hide Footers' : 'Show Footers', () => {
        if (has) l.elements = l.elements.filter((e) => !(e.ph && ['dt', 'ftr', 'sldNum'].includes(e.ph.type)));
        else for (const t of ['dt', 'ftr', 'sldNum'] as const) l.elements.push(newPlaceholder(app, t, fb[t].idx, fb[t]));
      });
    },
  },
  {
    id: 'master.hideBackgroundGraphics', label: 'Hide Background Graphics', icon: 'hide_image', tab: 'Slide Master', group: 'Background', kind: 'toggle', edits: true, isEnabled: (app) => !!layoutTarget(app),
    isActive: (app) => !!layoutTarget(app)?.hideMasterShapes,
    run: (app) => { const l = layoutTarget(app)!; app.deck.transact('Hide Background Graphics', () => { l.hideMasterShapes = !l.hideMasterShapes || undefined; }); },
  },
  {
    id: 'master.close', label: 'Close Master View', icon: 'close', tab: 'Slide Master', group: 'Close', edits: false, noRecord: true, isEnabled: inMaster,
    run: (app) => { if (app.tab.ui.editingText) app.tab.ui.commitText(); app.tab.view = 'normal'; app.tab.ui.select([]); app.tab.ui.layout(); app.ui.refresh(); },
  },
]);
