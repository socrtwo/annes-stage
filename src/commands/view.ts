/** View commands: presentation views, master view, show/hide, zoom, color modes, window, Quick Access Bar and ribbon. */
import { def } from './registry';
import type { App, ViewMode } from '../app';
import { openDialog, toast } from '../ui/dialog';
import { addAllQatChoices } from '../prefs';
import { getCommand } from './registry';

function setView(app: App, v: ViewMode): void {
  const t = app.tab;
  if (t.ui.editingText) t.ui.commitText();
  if (v === 'master' && t.view !== 'master') {
    const s = app.slide;
    t.masterTarget = s ? s.layout : app.deck.data.masters[0].id;
  }
  if (t.view === v) return;
  t.view = v;
  t.ui.select([]);
  t.ui.layout();
  app.ui.renderTabs();
  if (v === 'master') { app.ui.currentTab = 'slideMaster'; app.ui.renderTabs(); app.ui.renderRibbon(); }
  else if (app.ui.currentTab === 'slideMaster') { app.ui.currentTab = 'home'; app.ui.renderTabs(); app.ui.renderRibbon(); }
  app.refresh();
}

const viewCmd = (id: string, v: ViewMode, label: string, icon: string, extra: any = {}) => ({
  id, label, icon, tab: 'View', group: v === 'master' ? 'Master Views' : 'Presentation Views', kind: 'toggle' as const, noRecord: true,
  isActive: (app: App) => app.tab?.view === v, run: (app: App) => setView(app, v), ...extra,
});

function setColorMode(app: App, mode: 'color' | 'grayscale' | 'blackWhite'): void {
  (app.tab as any).colorMode = mode === 'color' ? undefined : mode;
  app.tab.ui.layout();
}

const pref = (key: 'showGrid' | 'smartGuides' | 'showNotes' | 'showThumbnails' | 'snapToGrid') => ({
  kind: 'toggle' as const, noRecord: true,
  isActive: (app: App) => !!app.prefs[key],
  run: (app: App) => { (app.prefs as any)[key] = !app.prefs[key]; app.savePrefs(); app.tab.ui.layout(); app.refresh(); },
});

def([
  viewCmd('view.normal', 'normal', 'Normal', 'view_sidebar'),
  viewCmd('view.outline', 'outline', 'Outline View', 'format_list_bulleted'),
  viewCmd('view.slideSorter', 'sorter', 'Slide Sorter', 'grid_view'),
  viewCmd('view.notesPage', 'notes', 'Notes Page', 'note'),
  viewCmd('view.reading', 'reading', 'Reading View', 'menu_book'),
  viewCmd('view.slideMaster', 'master', 'Slide Master', 'dashboard_customize', { tip: 'Edit the master and layouts that every slide is built on' }),
  { id: 'view.gridlines', label: 'Gridlines', icon: 'grid_4x4', tab: 'View', group: 'Show', keys: ['Shift-F9'], ...pref('showGrid') },
  { id: 'view.smartGuides', label: 'Smart Guides', icon: 'straighten', tab: 'View', group: 'Show', ...pref('smartGuides') },
  { id: 'view.snapToGrid', label: 'Snap to Grid', icon: 'grid_goldenratio', tab: 'View', group: 'Show', ...pref('snapToGrid') },
  { id: 'view.notes', label: 'Notes', icon: 'notes', tab: 'View', group: 'Show', ...pref('showNotes') },
  { id: 'view.thumbnails', label: 'Thumbnails', icon: 'view_sidebar', tab: 'View', group: 'Show', ...pref('showThumbnails') },
  {
    id: 'view.gridSettings', label: 'Grid and Guides…', icon: 'grid_on', tab: 'View', group: 'Show', noRecord: true,
    run: async (app) => {
      const p = app.prefs;
      const r = await openDialog({ title: 'Grid and Guides', fields: [
        { key: 'snap', label: 'Snap objects to grid', type: 'checkbox', value: p.snapToGrid },
        { key: 'size', label: 'Spacing (points)', type: 'number', min: 2, max: 144, value: p.gridSize },
        { key: 'show', label: 'Display grid on screen', type: 'checkbox', value: p.showGrid },
        { key: 'smart', label: 'Display smart guides when shapes are aligned', type: 'checkbox', value: p.smartGuides },
      ], help: 'Hold Alt while dragging to move freely without snapping.' });
      if (!r) return;
      Object.assign(p, { snapToGrid: r.snap, gridSize: Math.max(2, Math.min(144, +r.size || 12)), showGrid: r.show, smartGuides: r.smart });
      app.savePrefs();
      app.tab.ui.layout();
    },
  },
  { id: 'view.navigator', label: 'Navigator', icon: 'list_alt', tab: 'View', group: 'Panes', noRecord: true, origin: 'Impress Navigator', run: (app) => app.ui.togglePane('navigator') },
  { id: 'home.selectionPane', label: 'Selection Pane', icon: 'layers', tab: 'Home', group: 'Editing', keys: ['Alt-F10'], noRecord: true, run: (app) => app.ui.togglePane('selection') },
  {
    id: 'view.zoom', label: 'Zoom…', icon: 'zoom_in', tab: 'View', group: 'Zoom', noRecord: true,
    run: async (app) => {
      const r = await openDialog({ title: 'Zoom', fields: [{ key: 'z', label: 'Zoom to', type: 'radio', options: [{ value: 'fit', label: 'Fit' }, ...[400, 300, 200, 100, 66, 50, 33].map((z) => ({ value: String(z), label: `${z}%` }))], value: 'fit' }, { key: 'pct', label: 'Percent', type: 'number', min: 10, max: 400, value: Math.round(app.tab.ui.zoom * 100) }], onChange: (v, ctl, k) => { if (k === 'z' && v.z !== 'fit') ctl.set('pct', +v.z); } });
      if (!r) return;
      app.tab.ui.setZoom(r.z === 'fit' ? 'fit' : (+r.pct || 100) / 100);
    },
  },
  { id: 'view.fit', label: 'Fit to Window', icon: 'fit_screen', tab: 'View', group: 'Zoom', noRecord: true, run: (app) => app.tab.ui.setZoom('fit') },
  // Ctrl+= is Subscript, as in Office; Ctrl+Alt+= zooms in.
  { id: 'view.zoomIn', label: 'Zoom In', icon: 'zoom_in', tab: 'View', group: 'Zoom', keys: ['Mod-Alt-='], noRecord: true, run: (app) => app.tab.ui.setZoom(Math.min(4, app.tab.ui.zoom * 1.25)) },
  { id: 'view.zoomOut', label: 'Zoom Out', icon: 'zoom_out', tab: 'View', group: 'Zoom', keys: ['Mod--'], noRecord: true, run: (app) => app.tab.ui.setZoom(Math.max(0.1, app.tab.ui.zoom / 1.25)) },
  { id: 'view.color', label: 'Color', icon: 'palette', tab: 'View', group: 'Color/Grayscale', kind: 'toggle', noRecord: true, isActive: (app) => !(app.tab as any)?.colorMode, run: (app) => setColorMode(app, 'color') },
  { id: 'view.grayscale', label: 'Grayscale', icon: 'filter_b_and_w', tab: 'View', group: 'Color/Grayscale', kind: 'toggle', noRecord: true, tip: 'Preview the slides as they print in grayscale', isActive: (app) => (app.tab as any)?.colorMode === 'grayscale', run: (app) => setColorMode(app, 'grayscale') },
  { id: 'view.blackWhite', label: 'Black and White', icon: 'contrast', tab: 'View', group: 'Color/Grayscale', kind: 'toggle', noRecord: true, tip: 'Preview the slides as they print in pure black and white', isActive: (app) => (app.tab as any)?.colorMode === 'blackWhite', run: (app) => setColorMode(app, 'blackWhite') },
  {
    id: 'view.switchWindow', label: 'Switch Windows', icon: 'tab', tab: 'View', group: 'Window', kind: 'menu', keys: ['Mod-F6'], noRecord: true,
    menu: (app) => app.docs.map((d) => ({ id: 'view.switchWindow', arg: d.id, label: d.displayName + (d.dirty ? ' •' : ''), checked: d === app.tab })),
    run: (app, id?: string) => { const d = app.docs.find((x) => x.id === id) || app.docs[(app.docs.indexOf(app.tab) + 1) % app.docs.length]; if (d) app.activate(d); },
  },
  {
    id: 'view.fullScreen', label: 'Full Screen', icon: 'fullscreen', tab: 'View', group: 'Window', kind: 'toggle', noRecord: true,
    tip: 'Hide the ribbon and use the whole screen for editing (Esc returns)',
    isActive: () => document.body.classList.contains('ql-fullscreen'),
    run: (app) => {
      watchFullScreen(app);
      const on = !document.body.classList.contains('ql-fullscreen');
      document.body.classList.toggle('ql-fullscreen', on);
      try {
        if (on) document.documentElement.requestFullscreen?.()?.catch?.(() => { /* not allowed: the ribbon stays hidden until Esc */ });
        else if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
      } catch { /* not allowed */ }
    },
  },
  {
    id: 'view.newWindow', label: 'New Window', icon: 'open_in_new', tab: 'View', group: 'Window', noRecord: true,
    tip: 'A second view of this presentation in the same window (as a tab) — edits show in both',
    run: (app) => {
      const t = app.tab;
      // The tabs share the deck; App.createTab makes every tab on it refresh when it changes.
      const twin = app.createTab(t.deck, { title: t.title, fileName: t.fileName, format: t.format, uri: t.uri, key: t.key });
      twin.title = `${t.title}:${app.docs.filter((d) => d.deck === t.deck).length}`;
      app.ui.tabsChanged();
    },
  },
]);

/** Leaves Full Screen when the browser leaves full screen (its own Esc) or on Esc when it never entered it. */
let fullScreenWatched = false;
function watchFullScreen(app: App): void {
  if (fullScreenWatched) return;
  fullScreenWatched = true;
  const leave = () => { if (!document.body.classList.contains('ql-fullscreen')) return; document.body.classList.remove('ql-fullscreen'); app.refresh(); };
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) leave(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !document.fullscreenElement) leave(); });
}

// Quick Access Bar and ribbon -----------------------------------------------------------------

def([
  { id: 'view.cmdSearch', label: 'Search Commands', icon: 'search', tab: 'View', group: 'Help', keys: ['Alt-q'], popular: true, noRecord: true, run: (app) => app.ui.commandPalette() },
  {
    id: 'view.qatAddAll', label: 'Add All Quick Access Choices (A–Z)', icon: 'sort_by_alpha', tab: 'View', group: 'Quick Access Bar', noRecord: true,
    tip: 'Put every drop-down choice on the Quick Access Bar: Save and Print first, then the rest alphabetically',
    run: (app) => { app.prefs.qat = addAllQatChoices(app.prefs.qat, (id) => getCommand(id)?.label); app.prefs.qatHidden = false; app.savePrefs(); app.ui.applyPrefs(); app.ui.renderQat(); toast('All Quick Access choices added'); },
  },
  {
    id: 'view.qatPosition', label: 'Quick Access Bar Position', icon: 'swap_vert', tab: 'View', group: 'Quick Access Bar', kind: 'menu', noRecord: true,
    menu: (app) => (['top', 'below', 'bottom'] as const).map((p) => ({ id: 'view.qatPosition', arg: p, label: p === 'top' ? 'Show Above the Ribbon' : p === 'below' ? 'Show Below the Ribbon' : 'Show at the Bottom (near keyboard)', checked: app.prefs.qatPosition === p })),
    run: (app, pos?: 'top' | 'below' | 'bottom') => { const order: ('top' | 'below' | 'bottom')[] = ['top', 'below', 'bottom']; app.prefs.qatPosition = pos || order[(order.indexOf(app.prefs.qatPosition) + 1) % 3]; app.savePrefs(); app.ui.applyPrefs(); },
  },
  { id: 'view.qatLabels', label: 'Quick Access Bar Labels', icon: 'label', tab: 'View', group: 'Quick Access Bar', kind: 'toggle', noRecord: true, isActive: (app) => app.prefs.qatLabels, run: (app) => { app.prefs.qatLabels = !app.prefs.qatLabels; app.savePrefs(); app.ui.renderQat(); } },
  { id: 'view.qatShow', label: 'Show Quick Access Bar', icon: 'bolt', tab: 'View', group: 'Quick Access Bar', noRecord: true, run: (app) => { app.prefs.qatHidden = false; app.savePrefs(); app.ui.applyPrefs(); } },
  { id: 'view.qatHide', label: 'Hide Quick Access Bar', icon: 'visibility_off', tab: 'View', group: 'Quick Access Bar', noRecord: true, run: (app) => { app.prefs.qatHidden = true; app.savePrefs(); app.ui.applyPrefs(); } },
  { id: 'view.collapseRibbon', label: 'Collapse the Ribbon', icon: 'expand_less', tab: 'View', group: 'Ribbon', keys: ['Mod-F1'], kind: 'toggle', noRecord: true, isActive: (app) => app.prefs.ribbon !== 'full', run: (app) => { app.prefs.ribbon = app.prefs.ribbon === 'full' ? 'tabs' : 'full'; app.savePrefs(); app.ui.applyPrefs(); } },
  { id: 'view.touchMode', label: 'Touch/Mouse Mode', icon: 'touch_app', tab: 'View', group: 'Ribbon', kind: 'toggle', noRecord: true, tip: 'More space between commands for fingers', isActive: (app) => app.prefs.touchMode, run: (app) => { app.prefs.touchMode = !app.prefs.touchMode; app.savePrefs(); app.ui.applyPrefs(); } },
  {
    id: 'view.theme', label: 'Dark Mode', icon: 'dark_mode', tab: 'View', group: 'Appearance', kind: 'menu', noRecord: true,
    menu: (app) => (['system', 'light', 'dark'] as const).map((t) => ({ id: 'view.theme', arg: t, label: t === 'system' ? 'Follow the System' : t === 'light' ? 'Light' : 'Dark', checked: app.prefs.theme === t })),
    run: (app, t?: 'system' | 'light' | 'dark') => { app.prefs.theme = t || (app.prefs.theme === 'dark' ? 'light' : 'dark'); app.savePrefs(); app.ui.applyPrefs(); },
  },
]);
