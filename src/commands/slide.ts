/** Slides, sections and outline commands (Home ▸ Slides, thumbnails, Outline view, navigation). */
import { def, getCommand } from './registry';
import type { App } from '../app';
import type { Paragraph, ShapeElement, Slide, Section } from '../model/types';
import { clone, newId, parasFromText } from '../model/deck';
import { reId, shapeText } from '../edit/ops';
import { resolveBox } from '../model/inherit';
import { titleShape, bodyShape, ensurePlaceholder } from '../edit/workspace';
import { openDialog, promptDialog, toast, confirmDialog } from '../ui/dialog';
import { slideTitle } from '../render/slide';
import { openDocument } from '../platform/native';

const hasSlides = (app: App) => !!app.deck?.slides.length;

/** Layouts of the current slide's master (or the first master). */
function layoutsHere(app: App) {
  const s = app.slide;
  const master = s ? app.deck.layout(s.layout).master : app.deck.data.masters[0].id;
  return app.deck.layoutsOf(master);
}

/** The layout for a new slide after `after`: title slides are followed by Title and Content. */
function nextLayout(app: App, after?: Slide): string {
  const lays = layoutsHere(app);
  if (!after) return (lays.find((l) => l.type === 'title') || lays[0]).id;
  const cur = app.deck.layout(after.layout);
  if (cur.type === 'title' || cur.type === 'secHead') return (lays.find((l) => l.type === 'obj') || cur).id;
  return cur.id;
}

export function addSlide(app: App, layoutId?: string, at?: number): Slide {
  const d = app.deck;
  const cur = app.slide;
  const s = d.makeSlide(layoutId || nextLayout(app, cur));
  const i = at ?? (cur ? d.slideIndex(cur.id) + 1 : d.slides.length);
  d.transact('New Slide', () => {
    d.data.slides.splice(i, 0, s);
    const sec = cur && d.sectionOf(cur.id);
    if (sec) sec.slides.splice(sec.slides.indexOf(cur!.id) + 1, 0, s.id);
  });
  app.goToSlide(s.id);
  return s;
}

/** Keeps section membership consistent after slides are added, removed or reordered. */
function fixSections(slides: Slide[], sections: Section[]): void {
  if (!sections.length) return;
  const ids = new Set(slides.map((s) => s.id));
  for (const sec of sections) sec.slides = sec.slides.filter((id) => ids.has(id));
  // Slides not in any section join the section of the slide before them (or the first section).
  let curSec = sections[0];
  for (const s of slides) {
    const own = sections.find((x) => x.slides.includes(s.id));
    if (own) { curSec = own; continue; }
    curSec.slides.push(s.id);
  }
  // Section order follows slide order.
  for (const sec of sections) sec.slides.sort((a, b) => slides.findIndex((s) => s.id === a) - slides.findIndex((s) => s.id === b));
}

function moveSlides(app: App, dir: 'up' | 'down' | 'start' | 'end'): void {
  const d = app.deck;
  const sel = new Set(app.targetSlides().map((s) => s.id));
  if (!sel.size) return;
  d.transact('Move Slides', () => {
    const list = d.data.slides;
    const moving = list.filter((s) => sel.has(s.id));
    const rest = list.filter((s) => !sel.has(s.id));
    if (dir === 'start') d.data.slides = [...moving, ...rest];
    else if (dir === 'end') d.data.slides = [...rest, ...moving];
    else if (dir === 'up') { for (let i = 1; i < list.length; i++) if (sel.has(list[i].id) && !sel.has(list[i - 1].id)) [list[i - 1], list[i]] = [list[i], list[i - 1]]; }
    else for (let i = list.length - 2; i >= 0; i--) if (sel.has(list[i].id) && !sel.has(list[i + 1].id)) [list[i], list[i + 1]] = [list[i + 1], list[i]];
    fixSections(d.data.slides, d.data.sections);
  });
}

/** Plain text of each body paragraph of a slide. */
function bodyParas(s: Slide): Paragraph[] {
  return (bodyShape(s)?.text?.paras || []).filter((p) => p.runs.some((r) => r.text));
}

def([
  {
    id: 'slide.new', label: 'New Slide', icon: 'add_box', tab: 'Home', group: 'Slides', keys: ['Mod-m'], popular: true, edits: true, kind: 'split',
    menu: (app) => layoutsHere(app).map((l) => ({ id: 'slide.newWithLayout', arg: l.id, label: l.name })),
    run: (app, layoutId?: string) => { if (app.tab.view === 'master') { app.exec('master.insertLayout'); return; } addSlide(app, typeof layoutId === 'string' ? layoutId : undefined); },
  },
  {
    id: 'slide.newWithLayout', label: 'New Slide with Layout', icon: 'add_box', tab: 'Home', group: 'Slides', kind: 'menu', edits: true,
    menu: (app) => layoutsHere(app).map((l) => ({ id: 'slide.newWithLayout', arg: l.id, label: l.name })),
    run: (app, layoutId?: string) => addSlide(app, layoutId || undefined),
  },
  {
    id: 'slide.duplicate', label: 'Duplicate Slide', icon: 'library_add', tab: 'Home', group: 'Slides', edits: true, isEnabled: hasSlides,
    run: (app) => {
      const d = app.deck;
      const src = app.targetSlides();
      if (!src.length) return;
      const copies = src.map((s) => { const c = clone(s); c.id = newId('sld'); c.elements = c.elements.map((e) => reId(e)); c.anims = []; c.comments = []; return c; });
      // Re-target the copies' animations to the new element ids.
      src.forEach((s, i) => {
        const map = new Map(s.elements.map((e, k) => [e.id, copies[i].elements[k].id]));
        copies[i].anims = s.anims.filter((a) => map.has(a.target)).map((a) => ({ ...clone(a), id: newId('an'), target: map.get(a.target)! }));
      });
      d.transact('Duplicate Slide', () => {
        const last = Math.max(...src.map((s) => d.slideIndex(s.id)));
        d.data.slides.splice(last + 1, 0, ...copies);
        for (let i = 0; i < src.length; i++) { const sec = d.sectionOf(src[i].id); if (sec) sec.slides.push(copies[i].id); }
        fixSections(d.data.slides, d.data.sections);
      });
      app.goToSlide(copies[0].id);
      app.tab.slideSel = copies.map((c) => c.id);
    },
  },
  {
    id: 'slide.delete', label: 'Delete Slide', icon: 'delete', tab: 'Home', group: 'Slides', edits: true, isEnabled: hasSlides,
    run: (app) => {
      const d = app.deck;
      const del = new Set(app.targetSlides().map((s) => s.id));
      if (!del.size) return;
      const first = Math.min(...[...del].map((id) => d.slideIndex(id)));
      d.transact('Delete Slide', () => {
        d.data.slides = d.data.slides.filter((s) => !del.has(s.id));
        for (const sec of d.data.sections) sec.slides = sec.slides.filter((id) => !del.has(id));
        for (const cs of d.data.customShows) cs.slides = cs.slides.filter((id) => !del.has(id));
      });
      const next = d.slides[Math.min(first, d.slides.length - 1)];
      if (next) app.goToSlide(next.id); else { app.tab.current = ''; app.tab.slideSel = []; app.tab.ui.invalidate(); }
    },
  },
  {
    id: 'slide.layout', label: 'Layout', icon: 'dashboard', tab: 'Home', group: 'Slides', kind: 'menu', edits: true, isEnabled: hasSlides,
    menu: (app) => layoutsHere(app).map((l) => ({ id: 'slide.layout', arg: l.id, label: l.name, checked: app.slide?.layout === l.id })),
    run: (app, layoutId?: string) => {
      if (!layoutId) { app.ui.openCommandMenu(getCommand('slide.layout')!, app.ui.anchorFor('slide.layout')); return; }
      const d = app.deck;
      const lay = d.layout(layoutId);
      const slides = app.targetSlides();
      d.transact('Layout', () => {
        for (const s of slides) {
          const boxes = new Map(s.elements.map((e) => [e.id, resolveBox(d, s, e)]));
          s.layout = lay.id;
          // Keep content: placeholders whose type exists on the new layout stay; others become ordinary shapes with their current box.
          const keep: string[] = [];
          s.elements = s.elements.filter((e) => {
            if (!e.ph) return true;
            const match = lay.elements.find((x) => x.ph && !keep.includes(x.id) && (x.ph.type === e.ph!.type || (['title', 'ctrTitle'].includes(x.ph.type) && ['title', 'ctrTitle'].includes(e.ph!.type)) || (['body', 'obj', 'subTitle'].includes(x.ph.type) && ['body', 'obj', 'subTitle'].includes(e.ph!.type))));
            if (match) { keep.push(match.id); e.ph = { ...match.ph! }; delete e.x; delete e.y; delete e.w; delete e.h; return true; }
            // No matching placeholder: empty ones go; ones with content stay as ordinary shapes.
            if (e.kind === 'shape' && !shapeText(e)) return false;
            const b = boxes.get(e.id)!;
            Object.assign(e, { x: b.x, y: b.y, w: b.w, h: b.h });
            delete e.ph;
            return true;
          });
          // Add empty placeholders the new layout has and the slide lacks.
          for (const lp of lay.elements) {
            if (!lp.ph || ['dt', 'ftr', 'sldNum', 'hdr'].includes(lp.ph.type) || keep.includes(lp.id)) continue;
            s.elements.push({ id: newId('sp'), kind: 'shape', geom: 'rect', name: lp.name, ph: { ...lp.ph }, text: { paras: [{ level: 0, runs: [] }] } });
          }
        }
      }, slides.map((s) => s.id));
    },
  },
  {
    id: 'slide.reset', label: 'Reset', icon: 'restart_alt', tab: 'Home', group: 'Slides', edits: true, isEnabled: hasSlides,
    tip: 'Return placeholders to their layout positions and formatting, keeping their text',
    run: (app) => {
      const slides = app.targetSlides();
      app.deck.transact('Reset Slide', () => {
        for (const s of slides) for (const e of s.elements) {
          if (!e.ph) continue;
          delete e.x; delete e.y; delete e.w; delete e.h; delete e.rot; delete e.flipH; delete e.flipV;
          if (e.kind === 'shape') {
            delete e.fill; delete e.line; delete e.effects;
            if (e.text) { e.text = { paras: e.text.paras.map((p) => ({ level: p.level, runs: p.runs.map((r) => ({ text: r.text, ...(r.br ? { br: true } : {}), ...(r.field ? { field: r.field } : {}), ...(r.link ? { link: r.link } : {}) })) })) }; }
          }
        }
      }, slides.map((s) => s.id));
    },
  },
  {
    id: 'slide.reuse', label: 'Reuse Slides…', icon: 'drive_file_move', tab: 'Home', group: 'Slides', edits: true,
    tip: 'Insert slides from another presentation file',
    run: async (app) => {
      const f = await openDocument('.pptx,.pptm,.ppsx,.potx,.odp,.fodp,.ppt,.md,.qsp,.qspe', ['*/*']);
      if (!f) return;
      const { importDeck } = await import('../io');
      const { deck: src } = await importDeck(new Uint8Array(f.data), f.name);
      if (!src.slides.length) { toast(`${f.name} has no slides.`); return; }
      const r = await openDialog({ title: `Reuse Slides from ${f.name}`, fields: [
        { key: 'ids', label: 'Slides', type: 'list', multiple: true, rows: 10, options: src.slides.map((s, i) => ({ value: s.id, label: `${i + 1}. ${slideTitle(s) || '(no title)'}` })), value: src.slides.map((s) => s.id) },
        { key: 'keep', label: 'Keep source formatting', type: 'checkbox', value: false },
      ], ok: 'Insert' });
      if (!r?.ids?.length) return;
      const { pasteSlides } = await import('./edit');
      const chosen = src.slides.filter((s) => r.ids.includes(s.id));
      const layouts = [...new Set(chosen.map((s) => s.layout))].map((id) => src.layout(id));
      const masters = [...new Set(layouts.map((l) => l.master))].map((id) => src.master(id));
      const themes = [...new Set(masters.map((m) => m.theme))].map((id) => src.theme(id));
      pasteSlides(app, { kind: 'slides', data: chosen, media: src.media, text: '', time: Date.now(), design: { layouts, masters, themes } }, r.keep ? 'keep' : 'dest');
    },
  },
  {
    id: 'insert.slidesFromOutline', label: 'Slides from Outline…', icon: 'format_list_bulleted_add', tab: 'Insert', group: 'Slides', edits: true,
    tip: 'Insert slides from a text, Markdown, Word or RTF outline: headings become titles, lower levels bullets',
    run: async (app) => {
      const f = await openDocument('.txt,.md,.markdown,.docx,.rtf,.odt', ['*/*']);
      if (!f) return;
      const { importDeck } = await import('../io');
      const name = /\.(txt|md|markdown|docx|rtf)$/i.test(f.name) ? f.name : `${f.name}.txt`;
      const { deck: src } = await importDeck(new Uint8Array(f.data), name);
      const d = app.deck;
      const lays = layoutsHere(app);
      const objLayout = (lays.find((l) => l.type === 'obj') || lays[1] || lays[0]).id;
      const titleOnly = (lays.find((l) => l.type === 'titleOnly') || lays[0]).id;
      const at = Math.max(0, d.slideIndex(app.tab.current)) + 1;
      const made: Slide[] = src.slides.map((s) => {
        const body = bodyParas(s);
        const n = d.makeSlide(body.length ? objLayout : titleOnly);
        const t = titleShape(n); if (t) t.text = { paras: [{ level: 0, runs: [{ text: slideTitle(s) }] }] };
        const b = bodyShape(n); if (b && body.length) b.text = { paras: clone(body) };
        n.notes = clone(s.notes);
        return n;
      });
      d.transact('Slides from Outline', () => { d.data.slides.splice(at, 0, ...made); fixSections(d.data.slides, d.data.sections); });
      if (made[0]) app.goToSlide(made[0].id);
      toast(`Inserted ${made.length} slide${made.length === 1 ? '' : 's'}.`);
    },
  },
  {
    id: 'slide.hide', label: 'Hide Slide', icon: 'visibility_off', tab: 'Slide Show', group: 'Set Up', kind: 'toggle', edits: true, isEnabled: hasSlides,
    isActive: (app) => !!app.slide?.hidden,
    run: (app) => { const slides = app.targetSlides(); const on = !slides.every((s) => s.hidden); app.deck.transact('Hide Slide', () => { for (const s of slides) s.hidden = on || undefined; }, slides.map((s) => s.id)); },
  },
  { id: 'slide.moveUp', label: 'Move Slide Up', icon: 'arrow_upward', tab: 'Home', group: 'Slides', keys: ['Mod-ArrowUp'], edits: true, run: (app) => moveSlides(app, 'up') },
  { id: 'slide.moveDown', label: 'Move Slide Down', icon: 'arrow_downward', tab: 'Home', group: 'Slides', keys: ['Mod-ArrowDown'], edits: true, run: (app) => moveSlides(app, 'down') },
  { id: 'slide.moveStart', label: 'Move Slide to Start', icon: 'vertical_align_top', tab: 'Home', group: 'Slides', keys: ['Mod-Shift-ArrowUp'], edits: true, run: (app) => moveSlides(app, 'start') },
  { id: 'slide.moveEnd', label: 'Move Slide to End', icon: 'vertical_align_bottom', tab: 'Home', group: 'Slides', keys: ['Mod-Shift-ArrowDown'], edits: true, run: (app) => moveSlides(app, 'end') },
  {
    id: 'slide.moveTo', label: 'Move Slides', icon: 'drag_indicator', tab: 'Home', group: 'Slides', internal: true, edits: true,
    run: (app, arg: { ids: string[]; target: string; after: boolean; copy?: boolean }) => {
      const d = app.deck;
      if (!arg?.ids?.length) return;
      d.transact(arg.copy ? 'Copy Slides' : 'Move Slides', () => {
        const moving = d.data.slides.filter((s) => arg.ids.includes(s.id));
        const items = arg.copy ? moving.map((s) => { const c = clone(s); c.id = newId('sld'); c.elements = c.elements.map((e) => reId(e)); c.anims = []; return c; }) : moving;
        if (!arg.copy) d.data.slides = d.data.slides.filter((s) => !arg.ids.includes(s.id));
        let at = d.slideIndex(arg.target);
        if (at < 0) at = d.data.slides.length; else if (arg.after) at++;
        d.data.slides.splice(at, 0, ...items);
        // A slide dropped into another section joins it.
        const sec = d.sectionOf(arg.target);
        if (sec && !arg.copy) for (const s of d.data.sections) s.slides = s.slides.filter((id) => !arg.ids.includes(id));
        if (sec) sec.slides.push(...items.map((s) => s.id));
        fixSections(d.data.slides, d.data.sections);
      });
    },
  },
  { id: 'slide.next', label: 'Next Slide', icon: 'navigate_next', tab: 'View', group: 'Navigation', keys: ['PageDown'], noRecord: true, run: (app) => { const d = app.deck; const n = d.slides[d.slideIndex(app.tab.current) + 1]; if (n) app.goToSlide(n.id); } },
  { id: 'slide.prev', label: 'Previous Slide', icon: 'navigate_before', tab: 'View', group: 'Navigation', keys: ['PageUp'], noRecord: true, run: (app) => { const d = app.deck; const n = d.slides[d.slideIndex(app.tab.current) - 1]; if (n) app.goToSlide(n.id); } },
  { id: 'slide.first', label: 'First Slide', icon: 'first_page', tab: 'View', group: 'Navigation', keys: ['Mod-Home'], noRecord: true, run: (app) => { const s = app.deck.slides[0]; if (s) app.goToSlide(s.id); } },
  { id: 'slide.last', label: 'Last Slide', icon: 'last_page', tab: 'View', group: 'Navigation', keys: ['Mod-End'], noRecord: true, run: (app) => { const d = app.deck; const s = d.slides[d.slides.length - 1]; if (s) app.goToSlide(s.id); } },
  {
    id: 'slide.goTo', label: 'Go to Slide…', icon: 'move_down', tab: 'View', group: 'Navigation', noRecord: true, isEnabled: hasSlides,
    run: async (app, n?: number) => {
      const d = app.deck;
      if (typeof n !== 'number') {
        const r = await openDialog({ title: 'Go to Slide', fields: [{ key: 's', label: 'Slide', type: 'select', options: d.slides.map((s, i) => ({ value: s.id, label: `${i + 1}. ${slideTitle(s) || '(no title)'}${s.hidden ? ' (hidden)' : ''}` })), value: app.tab.current }] });
        if (r) app.goToSlide(r.s);
        return;
      }
      const s = d.slides[n - 1];
      if (s) app.goToSlide(s.id);
    },
  },
  {
    id: 'slide.copyTo', label: 'Copy Slide to Another Presentation', icon: 'move_group', tab: 'Home', group: 'Slides', noRecord: true,
    isEnabled: (app) => app.docs.length > 1,
    run: async (app) => {
      const others = app.docs.filter((d) => d !== app.tab);
      if (!others.length) { toast('Open or create another presentation first.'); return; }
      const r = await openDialog({ title: 'Copy Slides To', fields: [{ key: 't', label: 'Presentation', type: 'select', options: others.map((d) => ({ value: d.id, label: d.displayName })), value: others[0].id }, { key: 'keep', label: 'Keep source formatting', type: 'checkbox', value: true }] });
      if (!r) return;
      const src = app.deck;
      const slides = app.targetSlides();
      const layouts = [...new Set(slides.map((s) => s.layout))].map((id) => src.layout(id));
      const masters = [...new Set(layouts.map((l) => l.master))].map((id) => src.master(id));
      const themes = [...new Set(masters.map((m) => m.theme))].map((id) => src.theme(id));
      const target = app.docs.find((d) => d.id === r.t)!;
      const { pasteSlides } = await import('./edit');
      app.activate(target);
      pasteSlides(app, { kind: 'slides', data: slides, media: src.media, text: '', time: Date.now(), design: { layouts, masters, themes } }, r.keep ? 'keep' : 'dest');
      toast(`Copied ${slides.length} slide(s) to ${target.displayName}`);
    },
  },
  {
    id: 'slide.splitByParagraph', label: 'Split into Slides', icon: 'call_split', tab: 'Tools', group: 'Text', edits: true, origin: 'Lessig method',
    tip: 'Make one slide per paragraph of the current slide\'s text: each paragraph becomes the next slide\'s title',
    isEnabled: hasSlides,
    run: (app) => {
      const d = app.deck;
      const s = app.slide!;
      const paras = bodyParas(s);
      if (paras.length < 2) { toast('The slide\'s text has fewer than two paragraphs.'); return; }
      const lays = layoutsHere(app);
      const lay = (lays.find((l) => l.type === 'titleOnly') || lays[0]).id;
      const made = paras.map((p) => { const n = d.makeSlide(lay); const t = titleShape(n); if (t) t.text = { paras: [{ level: 0, runs: clone(p.runs) }] }; return n; });
      d.transact('Split into Slides', () => { d.data.slides.splice(d.slideIndex(s.id) + 1, 0, ...made); fixSections(d.data.slides, d.data.sections); });
      app.goToSlide(made[0].id);
    },
  },
  {
    id: 'slide.merge', label: 'Merge Slides', icon: 'merge', tab: 'Tools', group: 'Text', edits: true,
    tip: 'Combine the selected slides into one: their titles and text become bullets of the first slide',
    isEnabled: (app) => app.targetSlides().length > 1,
    run: (app) => {
      const d = app.deck;
      const slides = app.targetSlides();
      if (slides.length < 2) { toast('Select two or more slides in the thumbnails (Ctrl+click).'); return; }
      const [first, ...rest] = slides;
      d.transact('Merge Slides', () => {
        const b = ensurePlaceholder(first, 'body');
        const paras = bodyParas(first).length ? clone(bodyParas(first)) : [];
        for (const s of rest) {
          const t = slideTitle(s);
          if (t) paras.push({ level: 0, runs: [{ text: t }] });
          for (const p of bodyParas(s)) paras.push({ ...clone(p), level: Math.min(8, p.level + (t ? 1 : 0)) });
          first.notes.push(...clone(s.notes));
        }
        b.text = { ...(b.text || {}), paras };
        const del = new Set(rest.map((s) => s.id));
        d.data.slides = d.data.slides.filter((s) => !del.has(s.id));
        fixSections(d.data.slides, d.data.sections);
      });
      app.goToSlide(first.id);
    },
  },
  {
    id: 'slide.status', label: 'Slide Status', icon: 'flag', tab: 'Review', group: 'Collaboration', kind: 'menu', edits: true, origin: 'Pitch',
    menu: (app) => ['Not started', 'In progress', 'Needs review', 'Done'].map((s) => ({ id: 'slide.status', arg: s, label: s, checked: app.slide?.tags?.status === s })).concat([{ id: 'slide.status', arg: '', label: 'Clear status', checked: false }]),
    run: (app, status?: string) => { if (status === undefined) return; const slides = app.targetSlides(); app.deck.transact('Slide Status', () => { for (const s of slides) { s.tags = { ...(s.tags || {}) }; if (status) s.tags.status = status; else delete s.tags.status; } }, slides.map((s) => s.id)); },
  },
  {
    id: 'slide.assign', label: 'Assign Slide…', icon: 'assignment_ind', tab: 'Review', group: 'Collaboration', edits: true, origin: 'Pitch',
    run: async (app) => {
      const slides = app.targetSlides();
      const name = await promptDialog('Assign Slide', 'Assign to (name)', slides[0]?.tags?.assignee || '');
      if (name == null) return;
      app.deck.transact('Assign Slide', () => { for (const s of slides) { s.tags = { ...(s.tags || {}) }; if (name) s.tags.assignee = name; else delete s.tags.assignee; } }, slides.map((s) => s.id));
    },
  },
]);

// Sections ---------------------------------------------------------------------------------------

def([
  {
    id: 'section.menu', label: 'Section', icon: 'segment', tab: 'Home', group: 'Slides', kind: 'menu',
    menu: () => [{ id: 'section.add', label: 'Add Section' }, { id: 'section.rename', label: 'Rename Section' }, { id: 'section.remove', label: 'Remove Section' }, { id: 'section.removeWithSlides', label: 'Remove Section & Slides' }, { id: 'section.removeAll', label: 'Remove All Sections' }, { separator: true }, { id: 'section.collapseAll', label: 'Collapse All' }, { id: 'section.expandAll', label: 'Expand All' }],
    run: (app) => app.exec('section.add'),
  },
  {
    id: 'section.add', label: 'Add Section', icon: 'segment', tab: 'Home', group: 'Slides', edits: true, isEnabled: hasSlides,
    run: async (app) => {
      const d = app.deck;
      const name = await promptDialog('Add Section', 'Section name', 'Untitled Section');
      if (!name) return;
      const cur = app.slide!;
      d.transact('Add Section', () => {
        if (!d.data.sections.length) {
          // The first section added splits the deck: slides before the current one form a default section.
          const before = d.slides.slice(0, d.slideIndex(cur.id)).map((s) => s.id);
          if (before.length) d.data.sections.push({ id: newId('sec'), name: 'Default Section', slides: before });
          d.data.sections.push({ id: newId('sec'), name, slides: d.slides.slice(d.slideIndex(cur.id)).map((s) => s.id) });
          return;
        }
        const own = d.sectionOf(cur.id)!;
        const i = own.slides.indexOf(cur.id);
        const moved = own.slides.splice(i);
        d.data.sections.splice(d.data.sections.indexOf(own) + 1, 0, { id: newId('sec'), name, slides: moved });
        d.data.sections = d.data.sections.filter((s) => s.slides.length || s.name === name);
      });
    },
  },
  {
    id: 'section.rename', label: 'Rename Section', icon: 'edit', tab: 'Home', group: 'Slides', edits: true, isEnabled: (app) => !!app.deck?.data.sections.length,
    run: async (app, i?: number) => {
      const d = app.deck;
      const sec = typeof i === 'number' ? d.data.sections[i] : d.sectionOf(app.tab.current);
      if (!sec) return;
      const name = await promptDialog('Rename Section', 'Section name', sec.name);
      if (name) d.transact('Rename Section', () => { sec.name = name; });
    },
  },
  {
    id: 'section.remove', label: 'Remove Section', icon: 'remove', tab: 'Home', group: 'Slides', edits: true, isEnabled: (app) => !!app.deck?.data.sections.length,
    run: (app, i?: number) => {
      const d = app.deck;
      const sec = typeof i === 'number' ? d.data.sections[i] : d.sectionOf(app.tab.current);
      if (!sec) return;
      d.transact('Remove Section', () => {
        const k = d.data.sections.indexOf(sec);
        const target = d.data.sections[k - 1] || d.data.sections[k + 1];
        if (target) target.slides.push(...sec.slides);
        d.data.sections.splice(k, 1);
        fixSections(d.data.slides, d.data.sections);
      });
    },
  },
  {
    id: 'section.removeWithSlides', label: 'Remove Section & Slides', icon: 'delete', tab: 'Home', group: 'Slides', edits: true, isEnabled: (app) => !!app.deck?.data.sections.length,
    run: async (app, i?: number) => {
      const d = app.deck;
      const sec = typeof i === 'number' ? d.data.sections[i] : d.sectionOf(app.tab.current);
      if (!sec) return;
      if (!(await confirmDialog('Remove Section & Slides', `Delete the section "${sec.name}" and its ${sec.slides.length} slide(s)?`, 'Delete'))) return;
      d.transact('Remove Section & Slides', () => {
        const del = new Set(sec.slides);
        d.data.slides = d.data.slides.filter((s) => !del.has(s.id));
        d.data.sections = d.data.sections.filter((s) => s !== sec);
      });
    },
  },
  { id: 'section.removeAll', label: 'Remove All Sections', icon: 'clear_all', tab: 'Home', group: 'Slides', edits: true, isEnabled: (app) => !!app.deck?.data.sections.length, run: (app) => app.deck.transact('Remove All Sections', () => { app.deck.data.sections = []; }) },
  {
    id: 'section.moveUp', label: 'Move Section Up', icon: 'arrow_upward', tab: 'Home', group: 'Slides', edits: true, isEnabled: (app) => !!app.deck?.data.sections.length,
    run: (app, i?: number) => moveSection(app, typeof i === 'number' ? i : app.deck.data.sections.indexOf(app.deck.sectionOf(app.tab.current)!), -1),
  },
  {
    id: 'section.moveDown', label: 'Move Section Down', icon: 'arrow_downward', tab: 'Home', group: 'Slides', edits: true, isEnabled: (app) => !!app.deck?.data.sections.length,
    run: (app, i?: number) => moveSection(app, typeof i === 'number' ? i : app.deck.data.sections.indexOf(app.deck.sectionOf(app.tab.current)!), 1),
  },
  { id: 'section.collapseAll', label: 'Collapse All Sections', icon: 'unfold_less', tab: 'Home', group: 'Slides', noRecord: true, run: (app) => { for (const s of app.deck.data.sections) s.collapsed = true; app.tab.ui.invalidate(); } },
  { id: 'section.expandAll', label: 'Expand All Sections', icon: 'unfold_more', tab: 'Home', group: 'Slides', noRecord: true, run: (app) => { for (const s of app.deck.data.sections) s.collapsed = false; app.tab.ui.invalidate(); } },
  { id: 'section.toggle', label: 'Collapse or Expand Section', icon: 'expand_more', tab: 'Home', group: 'Slides', internal: true, noRecord: true, run: (app, i: number) => { const s = app.deck.data.sections[i]; if (s) { s.collapsed = !s.collapsed; app.tab.ui.invalidate(); } } },
]);

function moveSection(app: App, i: number, dir: -1 | 1): void {
  const d = app.deck;
  const secs = d.data.sections;
  const j = i + dir;
  if (i < 0 || j < 0 || j >= secs.length) return;
  d.transact('Move Section', () => {
    [secs[i], secs[j]] = [secs[j], secs[i]];
    const order = secs.flatMap((s) => s.slides);
    d.data.slides.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  });
}

// Outline ----------------------------------------------------------------------------------------

def([
  {
    id: 'outline.setTitle', label: 'Set Slide Title', icon: 'title', tab: 'View', group: 'Outline', internal: true, edits: true,
    run: (app, arg: { id: string; text: string }) => {
      const s = app.deck.slide(arg.id);
      if (!s) return;
      app.deck.transact('Edit Title', () => { const t = ensurePlaceholder(s, 'title'); const old = t.text?.paras[0]?.runs[0] || {}; t.text = { ...(t.text || {}), paras: [{ level: 0, runs: arg.text ? [{ ...old, text: arg.text }] : [] }] }; }, [s.id]);
    },
  },
  {
    id: 'outline.setBody', label: 'Set Slide Text', icon: 'notes', tab: 'View', group: 'Outline', internal: true, edits: true,
    run: (app, arg: { id: string; text: string }) => {
      const s = app.deck.slide(arg.id);
      if (!s) return;
      app.deck.transact('Edit Text', () => {
        let b: ShapeElement | undefined = bodyShape(s);
        if (!b && !arg.text.trim()) return;
        if (!b) {
          b = ensurePlaceholder(s, 'body');
          // The layout has no text placeholder: give the new one the standard content box.
          if (!app.deck.layout(s.layout).elements.some((e) => e.ph && ['body', 'obj'].includes(e.ph.type))) Object.assign(b, { x: 66, y: 144, w: app.deck.size.w - 132, h: app.deck.size.h - 200 });
        }
        b.text = { ...(b.text || {}), paras: parasFromText(arg.text) };
      }, [s.id]);
    },
  },
  {
    // Alt+Shift+Left/Right belong to Decrease/Increase List Level, which run these in Outline view.
    id: 'outline.promote', label: 'Promote', icon: 'format_indent_decrease', tab: 'View', group: 'Outline', edits: true,
    tip: 'Raise the selected paragraphs one level; a top-level paragraph becomes a new slide',
    run: (app) => {
      if (app.tab.ui.editingText || app.tab.view !== 'outline') { app.exec('fmt.outdent', 'para'); return; }
      const s = app.slide;
      if (!s) return;
      const paras = bodyParas(s);
      const last = paras[paras.length - 1];
      if (!last || last.level > 0) { app.exec('fmt.outdent', 'para'); return; }
      // The slide's last top-level paragraph (and what follows it) becomes the next slide.
      const d = app.deck;
      const lays = layoutsHere(app);
      const n = d.makeSlide((lays.find((l) => l.type === 'obj') || lays[0]).id);
      d.transact('Promote', () => {
        const b = bodyShape(s)!;
        const all = b.text!.paras;
        const at = all.lastIndexOf(last);
        const moved = all.splice(at);
        const t = titleShape(n); if (t) t.text = { paras: [{ level: 0, runs: clone(moved[0].runs) }] };
        const nb = bodyShape(n); if (nb && moved.length > 1) nb.text = { paras: moved.slice(1).map((p) => ({ ...clone(p), level: Math.max(0, p.level - 1) })) };
        d.data.slides.splice(d.slideIndex(s.id) + 1, 0, n);
        fixSections(d.data.slides, d.data.sections);
      });
    },
  },
  {
    id: 'outline.demote', label: 'Demote', icon: 'format_indent_increase', tab: 'View', group: 'Outline', edits: true,
    tip: 'Lower the selected paragraphs one level; a slide demoted becomes a bullet of the slide before it',
    run: (app) => {
      if (app.tab.ui.editingText || app.tab.view !== 'outline') { app.exec('fmt.indent', 'para'); return; }
      const d = app.deck;
      const s = app.slide;
      const i = s ? d.slideIndex(s.id) : -1;
      if (!s || i <= 0) { toast('The first slide cannot be demoted.'); return; }
      const prev = d.slides[i - 1];
      d.transact('Demote', () => {
        const b = ensurePlaceholder(prev, 'body');
        const paras = b.text?.paras.filter((p) => p.runs.some((r) => r.text)) || [];
        paras.push({ level: 0, runs: [{ text: slideTitle(s) }] }, ...bodyParas(s).map((p) => ({ ...clone(p), level: Math.min(8, p.level + 1) })));
        b.text = { ...(b.text || {}), paras };
        prev.notes.push(...clone(s.notes));
        d.data.slides.splice(i, 1);
        fixSections(d.data.slides, d.data.sections);
      });
      app.goToSlide(prev.id);
    },
  },
  { id: 'outline.moveUp', label: 'Move Up', icon: 'arrow_upward', tab: 'View', group: 'Outline', keys: ['Alt-Shift-ArrowUp'], edits: true, run: (app) => moveSlides(app, 'up') },
  { id: 'outline.moveDown', label: 'Move Down', icon: 'arrow_downward', tab: 'View', group: 'Outline', keys: ['Alt-Shift-ArrowDown'], edits: true, run: (app) => moveSlides(app, 'down') },
]);

export { fixSections };
