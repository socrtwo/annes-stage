/**
 * Side panes (task panes). On phones they appear as bottom sheets. Command modules register their own
 * panes with registerPane(); the core ones (Navigator, Selection, Version History) are defined here.
 */
import type { App } from '../app';
import type { Element } from '../model/types';
import { Deck } from '../model/deck';
import { h, icon, clear } from './dom';
import { toast, confirmDialog } from './dialog';
import { slideTitle } from '../render/slide';
import { kvKeys, kvGet, kvDel } from '../util/store';

export interface PaneDef {
  id: string;
  title: string;
  render: (app: App, el: HTMLElement, opts: any) => void;
  update?: (app: App, el: HTMLElement, opts: any) => void;
  onOpen?: (app: App, el: HTMLElement, opts: any) => void;
  onClose?: (app: App) => void;
}

export const PANES: Record<string, PaneDef> = {};

export function registerPane(def: PaneDef): void { PANES[def.id] = def; }

/** True while the user is typing in a field of the pane (redrawing would destroy the field). */
export const typingIn = (el: HTMLElement) => { const a = document.activeElement as HTMLElement | null; return !!a && el.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT'); };

/** For pane buttons that change the document directly: false (and a message) when it is read-only or marked final. */
export function canEdit(app: App): boolean {
  if (!app.isReadOnly?.()) return true;
  toast('This presentation is read-only.');
  return false;
}

export const sigOf = (el: HTMLElement, sig: string) => { if (el.dataset.sig === sig) return false; el.dataset.sig = sig; return true; };

const KIND_ICON: Record<string, string> = { shape: 'shapes', picture: 'image', table: 'table', chart: 'bar_chart', media: 'movie', group: 'join' };

export function elementLabel(e: Element): string {
  if (e.name) return e.name;
  if (e.ph) return `${e.ph.type} placeholder`;
  return e.kind;
}

registerPane({
  id: 'navigator', title: 'Navigator',
  render(app, el) { this.update!(app, el, {}); },
  update(app, el) {
    const d = app.deck;
    const sig = JSON.stringify([d.version, app.tab.id, app.tab.current]);
    if (!sigOf(el, sig) || typingIn(el)) return;
    clear(el);
    const filter = h('input', { class: 'ql-input', placeholder: 'Filter slides and objects…', 'aria-label': 'Filter' }) as HTMLInputElement;
    const list = h('div', { class: 'ql-nav-list' });
    const draw = () => {
      clear(list);
      const q = filter.value.trim().toLowerCase();
      const secOf = new Map<string, string>();
      d.data.sections.forEach((s) => s.slides.forEach((id) => secOf.set(id, s.name)));
      let lastSec = '';
      d.slides.forEach((s, i) => {
        const title = slideTitle(s) || '(no title)';
        const objs = s.elements.filter((e) => !q || elementLabel(e).toLowerCase().includes(q));
        if (q && !title.toLowerCase().includes(q) && !objs.length) return;
        const sec = secOf.get(s.id) || '';
        if (sec && sec !== lastSec) { lastSec = sec; list.appendChild(h('h3', { class: 'ql-pane-h' }, icon('segment'), ` ${sec}`)); }
        list.appendChild(h('button', { class: 'ql-nav-item' + (s.id === app.tab.current ? ' ql-on' : ''), onclick: () => app.goToSlide(s.id) }, icon(s.hidden ? 'visibility_off' : 'slideshow'), h('span', null, `${i + 1}. ${title}`)));
        if (s.id === app.tab.current || q) for (const e of objs) list.appendChild(h('button', { class: 'ql-nav-item ql-nav-sub', onclick: () => { app.goToSlide(s.id); app.tab.ui.select([e.id]); } }, icon(KIND_ICON[e.kind] || 'category'), h('span', null, elementLabel(e))));
      });
      if (d.data.customShows.length) {
        list.appendChild(h('h3', { class: 'ql-pane-h' }, icon('playlist_play'), ' Custom Shows'));
        for (const cs of d.data.customShows) list.appendChild(h('button', { class: 'ql-nav-item', onclick: () => app.exec('show.customShows') }, h('span', null, cs.name), h('span', { class: 'ql-help' }, `${cs.slides.length} slides`)));
      }
    };
    filter.addEventListener('input', draw);
    el.append(filter, list);
    draw();
  },
});

registerPane({
  id: 'selection', title: 'Selection',
  render(app, el) { this.update!(app, el, {}); },
  update(app, el) {
    const o = app.owner;
    const sel = app.tab.ui.selection;
    const sig = JSON.stringify([app.deck.version, o?.id, sel]);
    if (!sigOf(el, sig) || typingIn(el)) return;
    clear(el);
    if (!o) return;
    el.appendChild(h('div', { class: 'ql-row' },
      h('button', { class: 'ql-btn ql-sm', onclick: () => canEdit(app) && app.deck.transact('Show All', () => { for (const e of o.elements) delete e.hidden; }, 'layout' in o ? [o.id] : undefined) }, 'Show All'),
      h('button', { class: 'ql-btn ql-sm', onclick: () => canEdit(app) && app.deck.transact('Hide All', () => { for (const e of o.elements) e.hidden = true; }, 'layout' in o ? [o.id] : undefined) }, 'Hide All')));
    if (!o.elements.length) el.appendChild(h('p', { class: 'ql-help' }, 'This slide has no objects.'));
    el.appendChild(h('p', { class: 'ql-help' }, 'Top of the list is in front. Double-click a name to rename it.'));
    const scope = 'layout' in o ? [o.id] : undefined;
    // Front-most first, as desktop selection panes list them.
    [...o.elements].reverse().forEach((e) => {
      const name = h('span', { class: 'ql-sel-name' }, elementLabel(e));
      name.addEventListener('dblclick', () => {
        if (!canEdit(app)) return;
        const inp = h('input', { class: 'ql-input', value: elementLabel(e) }) as HTMLInputElement;
        name.replaceWith(inp);
        inp.focus(); inp.select();
        const done = () => { const v = inp.value.trim(); if (v && v !== e.name && canEdit(app)) app.deck.transact('Rename', () => { e.name = v; }, scope); else app.refresh(); };
        inp.addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') inp.blur(); if (ev.key === 'Escape') { inp.value = elementLabel(e); inp.blur(); } });
        inp.addEventListener('blur', done);
      });
      const row = h('div', { class: 'ql-nav-item' + (sel.includes(e.id) ? ' ql-on' : '') },
        icon(KIND_ICON[e.kind] || 'category'), name,
        h('button', { class: 'ql-iconbtn ql-sm', title: e.hidden ? 'Show' : 'Hide', 'aria-label': e.hidden ? 'Show' : 'Hide', onclick: (ev: Event) => { ev.stopPropagation(); if (canEdit(app)) app.deck.transact(e.hidden ? 'Show' : 'Hide', () => { e.hidden = e.hidden ? undefined : true; }, scope); } }, icon(e.hidden ? 'visibility_off' : 'visibility')),
        h('button', { class: 'ql-iconbtn ql-sm', title: 'Bring Forward', 'aria-label': 'Bring forward', onclick: (ev: Event) => { ev.stopPropagation(); app.tab.ui.select([e.id]); app.exec('arrange.bringForward'); } }, icon('arrow_upward')),
        h('button', { class: 'ql-iconbtn ql-sm', title: 'Send Backward', 'aria-label': 'Send backward', onclick: (ev: Event) => { ev.stopPropagation(); app.tab.ui.select([e.id]); app.exec('arrange.sendBackward'); } }, icon('arrow_downward')));
      row.addEventListener('click', (ev) => { const add = (ev as MouseEvent).ctrlKey || (ev as MouseEvent).shiftKey; app.tab.ui.select(add ? (sel.includes(e.id) ? sel.filter((x) => x !== e.id) : [...sel, e.id]) : [e.id]); });
      el.appendChild(row);
    });
  },
});

registerPane({
  id: 'versions', title: 'Version History',
  render(app, el) { this.update!(app, el, {}); },
  update(app, el) {
    const sig = `${app.tab.id}:${app.tab.saved}`;
    if (!sigOf(el, sig)) return;
    clear(el);
    el.appendChild(h('p', { class: 'ql-help' }, 'Snapshots are kept on this device each time you save, and when you choose File ▸ Info ▸ Take Snapshot.'));
    el.appendChild(h('button', { class: 'ql-btn', onclick: async () => { await app.exec('file.snapshot'); el.dataset.sig = ''; } }, icon('add_a_photo'), ' Take Snapshot'));
    const list = h('div', { class: 'ql-nav-list' });
    el.appendChild(list);
    void (async () => {
      const { docKey } = await import('../commands/file');
      const keys = (await kvKeys(`snap:${docKey(app.tab)}:`)).sort().reverse();
      if (!keys.length) list.appendChild(h('p', { class: 'ql-help' }, 'No snapshots yet.'));
      for (const k of keys) {
        const v = await kvGet(k);
        if (!v) continue;
        list.appendChild(h('div', { class: 'ql-nav-item' },
          icon('history'), h('span', null, v.label), h('span', { class: 'ql-help' }, new Date(v.when).toLocaleString()),
          h('button', { class: 'ql-iconbtn ql-sm', title: 'Open as a copy', 'aria-label': 'Open as a copy', onclick: () => { try { const d = Deck.fromJSON(v.json); d.clearHistory(); app.createTab(d, { title: `${v.name} (${new Date(v.when).toLocaleString()})` }); } catch (e: any) { toast(`Could not open the snapshot: ${e?.message || e}`); } } }, icon('open_in_new')),
          h('button', { class: 'ql-iconbtn ql-sm', title: 'Restore into this presentation', 'aria-label': 'Restore', onclick: async () => {
            if (!canEdit(app)) return;
            if (!(await confirmDialog('Restore Snapshot', `Replace the current presentation with "${v.label}"? You can undo this.`, 'Restore'))) return;
            const d = Deck.fromJSON(v.json);
            if (!canEdit(app)) return;
            app.deck.transact('Restore Snapshot', () => { app.deck.data = d.data; Object.assign(app.deck.media, d.media); });
          } }, icon('settings_backup_restore')),
          h('button', { class: 'ql-iconbtn ql-sm', title: 'Delete', 'aria-label': 'Delete snapshot', onclick: async () => { await kvDel(k); el.dataset.sig = ''; this.update!(app, el, {}); } }, icon('delete'))));
      }
    })();
  },
});
