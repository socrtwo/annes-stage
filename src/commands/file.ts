/** File (backstage) commands: new, open, save, export, print, share, info, versions, options. */
import { def } from './registry';
import type { App, DeckTab } from '../app';
import { Deck } from '../model/deck';
import { FORMATS, formatById, formatFromName, importDeck, exportDeck, PasswordNeeded } from '../io';
import { openDocument, saveAs, writeBack, shareFile, readUri, OPEN_ACCEPT, OPEN_MIMES, isDesktop } from '../platform/native';
import { openDialog, toast, confirmDialog, choiceDialog, promptDialog } from '../ui/dialog';
import { kvGet, kvSet, kvKeys, kvDel } from '../util/store';
import { TEMPLATES, STARTERS } from '../templates';
import { showRecoveryReport, showManualRecovery, recoverySummary } from '../ui/recovery';
import { sanitizePrefs, DEFAULT_REPLACEMENTS } from '../prefs';
import { SPELL_DIALECTS } from '../proof/proofing';
import { forEachText } from '../edit/ops';

/** Key for a presentation's cached copy, Recent entry and snapshots. */
export function docKey(tab: DeckTab): string {
  return (tab.uri && !tab.uri.startsWith('fsa:') ? tab.uri : '') || tab.key || `doc:${tab.id}`;
}

export function localKey(name: string, data: ArrayBuffer): string {
  const b = new Uint8Array(data);
  let hh = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) hh = Math.imul(hh ^ b[i], 0x01000193);
  return `doc:${name}:${b.length.toString(36)}.${(hh >>> 0).toString(36)}`;
}

/** An untouched new presentation can be replaced by the next file opened. */
function isPristine(tab: DeckTab): boolean {
  const d = tab.deck;
  return !tab.dirty && !tab.uri && !d.canUndo && d.slides.length <= 1 && d.slides.every((s) => s.elements.every((e) => e.kind === 'shape' && !(e.text?.paras || []).some((p) => p.runs.some((r) => r.text))));
}

const toBlob = (data: Uint8Array, mime: string) => new Blob([data as BlobPart], { type: mime });

export async function openBuffer(app: App, data: ArrayBuffer, name: string, uri: string | null, opts: { repair?: boolean; key?: string; password?: string } = {}): Promise<DeckTab | null> {
  try {
    if (opts.repair) toast(`Repairing ${name}…`);
    let res;
    try {
      res = await importDeck(new Uint8Array(data), name, { repair: opts.repair, password: opts.password });
    } catch (e) {
      if (e instanceof PasswordNeeded) {
        const pw = await promptDialog('Password', `${name} is encrypted. Enter its password:`, '', { type: 'password' });
        if (pw == null) return null;
        return openBuffer(app, data, name, uri, { ...opts, password: pw });
      }
      throw e;
    }
    const { deck, format, recovery, warnings } = res;
    const fmt = formatById(format) || formatFromName(name);
    const cur = app.tab;
    const base = name.replace(/\.[^.]+$/, '');
    const keepsFile = !!fmt?.canExport && !['md', 'txt', 'json'].includes(fmt.id);
    const meta: Partial<DeckTab> = recovery
      ? { title: `${base} (Recovered)`, fileName: `${base} (Recovered).pptx`, format: 'pptx', uri: null, key: '' }
      : { title: base, fileName: keepsFile ? name : `${base}.pptx`, format: keepsFile ? fmt!.id : 'pptx', uri: keepsFile ? uri : null, key: uri && !uri.startsWith('fsa:') ? '' : opts.key || localKey(name, data) };
    deck.clearHistory();
    let tab: DeckTab;
    if (cur && isPristine(cur)) {
      Object.assign(cur, meta);
      app.replaceDeck(cur, deck);
      tab = cur;
      app.ui.tabsChanged();
    } else tab = app.createTab(deck, meta);
    tab.dirty = !!recovery;
    tab.recovery = recovery || null;
    if (fmt?.id === 'ppsx' || /\.pps[xm]?$/i.test(name)) tab.readOnly = false;
    // File ▸ Info ▸ Always Open Read-Only.
    const askedReadOnly = !recovery && deck.data.props.custom?.['quillstage:readOnly'] === '1';
    if (askedReadOnly) tab.readOnly = true;
    if (!recovery) {
      addRecent(app, tab);
      await cacheFile(tab, name, data, uri);
    }
    app.activate(tab);
    if (askedReadOnly) toast(`${name} opens read-only, as its author asked.`, { action: 'Edit Anyway', onAction: () => { tab.readOnly = false; app.ui.tabsChanged(); app.refresh(); }, ms: 9000 });
    const details = () => openDialog({ title: 'Import Notes', content: Object.assign(document.createElement('pre'), { className: 'ql-notices', textContent: (warnings || []).join('\n') }), cancel: false });
    if (recovery) toast(`${name} was damaged. ${recoverySummary(recovery)}`, { action: 'Details', onAction: () => app.exec('file.recoveryReport'), ms: 9000 });
    else if (warnings?.length) toast(`Opened ${name} (${warnings.length} note${warnings.length > 1 ? 's' : ''})`, { action: 'Details', onAction: details, ms: 9000 });
    else if (fmt && !fmt.canExport) toast(`Opened ${name}. Save as .pptx to keep your changes.`, { ms: 6000 });
    else toast(`Opened ${name}`);
    // A show file (.ppsx) starts presenting when it is opened, as desktop programs do.
    if (!recovery && (format === 'ppsx' || /\.ppsx?$/i.test(name))) setTimeout(() => app.exec('show.fromStart'), 300);
    return tab;
  } catch (e: any) {
    console.error(e);
    toast(`Could not open ${name}: ${e?.message || e}`, { action: 'Repair', onAction: () => openBuffer(app, data, name, uri, { repair: true }), ms: 9000 });
    return null;
  }
}

function addRecent(app: App, tab: DeckTab) {
  const key = docKey(tab);
  const list = app.prefs.recent.filter((r) => r.key !== key);
  const old = app.prefs.recent.find((r) => r.key === key);
  list.unshift({ key, name: tab.displayName, when: Date.now(), uri: tab.uri || undefined, format: tab.format, pinned: old?.pinned });
  app.prefs.recent = [...list.filter((r) => r.pinned), ...list.filter((r) => !r.pinned)].slice(0, 40);
  app.savePrefs();
}

/** Snapshots kept per presentation (older ones are deleted). */
export const SNAPSHOT_LIMIT = 10;

/** Keeps the bytes last opened or saved, for Revert to Saved and Recent. Reports a full store instead of failing. */
async function cacheFile(tab: DeckTab, name: string, data: ArrayBuffer, uri: string | null): Promise<boolean> {
  try {
    await kvSet('file:' + docKey(tab), { name, data, uri, when: Date.now() });
    return true;
  } catch (e) {
    console.warn(e);
    toast(`Could not keep a local copy of ${name} (storage may be full): Revert to Saved and Recent may not have it.`, { ms: 7000 });
    return false;
  }
}

/** Deletes all but the newest `keep` snapshots of a presentation. */
export async function pruneSnapshots(key: string, keep = SNAPSHOT_LIMIT): Promise<void> {
  const prefix = `snap:${key}:`;
  const mine = (await kvKeys(prefix)).filter((k) => /^\d+$/.test(k.slice(prefix.length))).sort((a, b) => +b.slice(prefix.length) - +a.slice(prefix.length));
  for (const k of mine.slice(keep)) await kvDel(k);
}

async function snapshot(_app: App, tab: DeckTab, label: string): Promise<boolean> {
  const key = docKey(tab);
  try {
    await kvSet(`snap:${key}:${Date.now()}`, { label, json: tab.deck.toJSON(), when: Date.now(), name: tab.displayName });
  } catch (e) {
    console.warn(e);
    toast('The snapshot could not be stored (storage may be full).');
    return false;
  }
  try { await pruneSnapshots(key); } catch (e) { console.warn(e); }
  return true;
}

export async function saveTab(app: App, tab: DeckTab, opts: { as?: boolean; format?: string; copy?: boolean } = {}): Promise<boolean> {
  if (tab.ui.editingText) tab.ui.commitText();
  let format = opts.format || (formatById(tab.format)?.canExport ? tab.format : app.prefs.defaultSaveFormat);
  let fmt = formatById(format);
  if (!fmt?.canExport) { format = 'pptx'; fmt = formatById('pptx')!; }
  if (!opts.copy && ['md', 'txt'].includes(format)) {
    const c = await choiceDialog('Keep Current Format?', `${fmt.label} keeps only the slides' text. Pictures, shapes, layouts and formatting will be lost.`, ['Save as PowerPoint Presentation (.pptx)', `Keep ${fmt.label}`]);
    if (c < 0) return false;
    if (c === 0) { format = 'pptx'; fmt = formatById('pptx')!; opts = { ...opts, as: true }; }
  }
  const base = (tab.fileName || tab.title || 'Presentation').replace(/\.[^.]+$/, '');
  const name = `${base}.${fmt.ext[0]}`;
  tab.deck.data.props.lastModifiedBy = app.prefs.author;
  const version = tab.deck.version;
  let password: string | undefined;
  if (format === 'qspe') {
    const r = await openDialog({ title: 'Encrypt Presentation', fields: [{ key: 'p1', label: 'Password', type: 'password' }, { key: 'p2', label: 'Confirm', type: 'password' }], validate: (x) => (!x.p1 ? 'Enter a password.' : x.p1 !== x.p2 ? 'Passwords do not match.' : null) });
    if (!r) return false;
    password = r.p1;
  }
  const out = await exportDeck(tab.deck, format, { password });
  const blob = toBlob(out.data, out.mime);
  if (!opts.as && !opts.copy && tab.uri && format === tab.format) {
    try {
      if (await writeBack(tab.uri, blob)) {
        markSaved(app, tab, version);
        toast(`Saved ${tab.displayName}`);
        // Revert to Saved must find what was just written, not the bytes first opened.
        await cacheFile(tab, tab.fileName || name, out.data.buffer.slice(out.data.byteOffset, out.data.byteOffset + out.data.byteLength) as ArrayBuffer, tab.uri);
        await snapshot(app, tab, 'Saved');
        return true;
      }
    } catch (e) { console.warn(e); }
  }
  const r = await saveAs(blob, name);
  if (!r) return false;
  if (!opts.copy) {
    tab.fileName = r.name; tab.title = r.name.replace(/\.[^.]+$/, ''); tab.format = formatFromName(r.name)?.id || format; tab.uri = r.uri;
    markSaved(app, tab, version);
    addRecent(app, tab);
    await cacheFile(tab, r.name, out.data.buffer.slice(out.data.byteOffset, out.data.byteOffset + out.data.byteLength) as ArrayBuffer, r.uri);
    await snapshot(app, tab, 'Saved');
  }
  toast(`Saved ${r.name}`);
  return true;
}

function markSaved(app: App, tab: DeckTab, version: number) {
  tab.saved = Date.now();
  if (tab.deck.version === version) { tab.dirty = false; kvDel('draft:' + tab.id); } else app.scheduleAutosave();
  app.ui.tabsChanged();
  document.title = `${tab.displayName}${tab.dirty ? ' •' : ''} – Anne\'s Stage`;
}

/** Saves bytes produced by an export with the system save dialog. */
async function saveBytes(data: Uint8Array | string, name: string, mime: string): Promise<void> {
  const blob = typeof data === 'string' ? new Blob([data], { type: mime }) : toBlob(data, mime);
  const r = await saveAs(blob, name);
  if (r) toast(`Saved ${r.name}`);
}

const baseName = (app: App) => (app.tab.fileName || app.tab.title || 'Presentation').replace(/\.[^.]+$/, '');

def([
  {
    id: 'file.new', label: 'New', icon: 'note_add', tab: 'Backstage', group: 'New', keys: ['Mod-n'], popular: true, noRecord: true,
    tip: 'New presentation',
    run: (app, arg) => {
      const t = TEMPLATES.find((x) => x.id === arg) || STARTERS.find((x) => x.id === arg);
      const prev = app.tab && isPristine(app.tab) ? app.tab : null;
      if (t && t.id !== 'blank') {
        const deck = t.build();
        deck.data.props.author = app.prefs.author;
        deck.data.props.created = Date.now();
        deck.clearHistory();
        const tab = app.createTab(deck, { title: t.name });
        if (prev) app.closeTab(prev);
        app.activate(tab);
        app.ui.hideBackstage();
        return;
      }
      if (prev) { app.ui.hideBackstage(); app.focus(); return; }
      app.createTab();
      app.ui.hideBackstage();
    },
  },
  { id: 'file.newFromTemplate', label: 'New from Template…', icon: 'library_books', tab: 'Backstage', group: 'New', noRecord: true, run: (app) => app.ui.showBackstage('new') },
  {
    id: 'file.newFromStarter', label: 'New from Content Starter…', icon: 'auto_stories', tab: 'Backstage', group: 'New', noRecord: true, origin: 'Freelance Graphics SmartMasters',
    tip: 'Start from a guided outline: each slide says what to put on it',
    run: async (app) => {
      const r = await openDialog({ title: 'Content Starters', fields: [{ key: 'id', label: 'Start from', type: 'radio', options: STARTERS.map((s) => ({ value: s.id, label: `${s.name} — ${s.description}` })), value: STARTERS[0].id }] });
      if (r) app.exec('file.new', r.id);
    },
  },
  {
    id: 'file.open', label: 'Open', icon: 'folder_open', tab: 'Backstage', group: 'Open', keys: ['Mod-o', 'Mod-F12'], popular: true, noRecord: true,
    run: async (app) => {
      const f = await openDocument(OPEN_ACCEPT, OPEN_MIMES);
      if (!f) return;
      await openBuffer(app, f.data, f.name, f.uri);
      app.ui.hideBackstage();
    },
  },
  {
    id: 'file.openDropped', label: 'Open Dropped Files', icon: 'file_open', tab: 'Backstage', group: 'Open', internal: true, noRecord: true,
    run: async (app, files: File[]) => { for (const f of files || []) await openBuffer(app, await f.arrayBuffer(), f.name, null); },
  },
  {
    id: 'file.openRepair', label: 'Open and Repair…', icon: 'healing', tab: 'Backstage', group: 'Open', noRecord: true,
    tip: 'Open a damaged presentation: rebuild its package from raw bytes, repair its XML, salvage slides, pictures and text, and show what was recovered',
    keywords: 'corrupt damaged recover fix broken salvage',
    run: async (app) => {
      const f = await openDocument('*/*', ['*/*']);
      if (!f) return;
      const tab = await openBuffer(app, f.data, f.name, f.uri, { repair: true });
      app.ui.hideBackstage();
      if (tab?.recovery) await showRecoveryReport(tab.recovery, { open: () => app.activate(tab) } as any);
    },
  },
  {
    id: 'file.recoverAny', label: 'Recover Data from Any File…', icon: 'text_snippet', tab: 'Backstage', group: 'Open', noRecord: true,
    tip: 'Extract readable text and pictures from any file, however damaged',
    keywords: 'corrupt salvage strings extract',
    run: async () => { await showManualRecovery(); },
  },
  {
    id: 'file.recoveryReport', label: 'Recovery Report', icon: 'fact_check', tab: 'Backstage', group: 'Open', noRecord: true,
    isEnabled: (app) => !!app.tab?.recovery,
    run: async (app) => {
      const r = app.tab?.recovery;
      if (!r) { toast('This presentation was not recovered from a damaged file.'); return; }
      await showRecoveryReport(r, {} as any);
    },
  },
  { id: 'file.recoveryHelp', label: 'Manual Recovery Options', icon: 'support', tab: 'Backstage', group: 'Open', noRecord: true, run: () => showManualRecovery() },
  {
    id: 'file.openRecent', label: 'Open Recent File', icon: 'history', tab: 'Backstage', group: 'Open', kind: 'menu', noRecord: true,
    run: async (app, key) => {
      if (!key) return app.ui.showBackstage('open');
      const rec = app.prefs.recent.find((r) => r.key === key);
      if (!rec) return;
      const existing = app.docs.find((d) => docKey(d) === key);
      if (existing) { app.activate(existing); app.ui.hideBackstage(); return; }
      let f = rec.uri ? await readUri(rec.uri) : null;
      if (!f) { const cached = await kvGet('file:' + key); if (cached) f = { name: cached.name, data: cached.data, uri: cached.uri }; }
      if (!f) { toast('That file is no longer available. Use Open to locate it.'); return; }
      await openBuffer(app, f.data, f.name, f.uri, { key });
      app.ui.hideBackstage();
    },
    menu: (app) => app.prefs.recent.length ? app.prefs.recent.slice(0, 12).map((r) => ({ id: 'file.openRecent', arg: r.key, label: (r.pinned ? '📌 ' : '') + r.name })) : [{ label: '(no recent presentations)' }],
  },
  { id: 'file.clearRecent', label: 'Clear Unpinned Recent Presentations', icon: 'delete_sweep', tab: 'Backstage', group: 'Open', noRecord: true, run: (app) => { app.prefs.recent = app.prefs.recent.filter((r) => r.pinned); app.savePrefs(); app.ui.showBackstage('open'); } },
  {
    id: 'file.openEncrypted', label: 'Open Encrypted Presentation…', icon: 'lock_open', tab: 'Backstage', group: 'Open', noRecord: true,
    run: async (app) => {
      const f = await openDocument('.qspe', ['application/octet-stream', '*/*']);
      if (!f) return;
      await openBuffer(app, f.data, f.name, null);
    },
  },
  { id: 'file.save', label: 'Save', icon: 'save', tab: 'Backstage', group: 'Save', keys: ['Mod-s', 'Shift-F12'], popular: true, noRecord: true, run: (app) => saveTab(app, app.tab) },
  { id: 'file.saveAs', label: 'Save As', icon: 'save_as', tab: 'Backstage', group: 'Save', keys: ['F12'], popular: true, noRecord: true, run: (app) => app.ui.showBackstage('saveas') },
  { id: 'file.saveCopy', label: 'Save a Copy…', icon: 'file_copy', tab: 'Backstage', group: 'Save', noRecord: true, run: (app) => saveTab(app, app.tab, { copy: true }) },
  { id: 'file.saveAll', label: 'Save All', icon: 'library_add_check', tab: 'Backstage', group: 'Save', noRecord: true, run: async (app) => { for (const d of app.docs) if (d.dirty) await saveTab(app, d); } },
  {
    id: 'file.saveAsFormat', label: 'Save As Format', icon: 'save_as', tab: 'Backstage', group: 'Save', internal: true, noRecord: true,
    run: async (app, format: string) => { await saveTab(app, app.tab, { as: true, format }); app.ui.hideBackstage(); },
  },
  {
    id: 'file.saveTemplate', label: 'Save as Template', icon: 'bookmark_add', tab: 'Backstage', group: 'Save', noRecord: true,
    tip: 'Keep this presentation\'s design (and slides, if you want) as a starting point under File ▸ New ▸ My Templates',
    run: async (app) => {
      const r = await openDialog({ title: 'Save as Template', fields: [{ key: 'name', label: 'Template name', type: 'text', value: app.tab.title }, { key: 'slides', label: 'Keep the slides (otherwise only the design)', type: 'checkbox', value: true }] });
      if (!r?.name) return;
      const json = app.deck.toJSON();
      const copy = JSON.parse(JSON.stringify(json));
      if (!r.slides) { copy.data.slides = []; copy.data.sections = []; }
      await kvSet(`tpl:${r.name}`, { name: r.name, json: copy, when: Date.now() });
      toast(`Template "${r.name}" saved`);
    },
  },
  { id: 'file.autosave', label: 'AutoSave', icon: 'autorenew', tab: 'Backstage', group: 'Save', kind: 'toggle', noRecord: true, run: (app) => { app.prefs.autosave = !app.prefs.autosave; app.savePrefs(); toast(app.prefs.autosave ? 'AutoSave on (drafts saved automatically)' : 'AutoSave off'); }, isActive: (app) => app.prefs.autosave },
  {
    id: 'file.revert', label: 'Revert to Saved', icon: 'settings_backup_restore', tab: 'Backstage', group: 'Info', noRecord: true,
    run: async (app) => {
      const tab = app.tab;
      const cached = await kvGet('file:' + docKey(tab));
      if (!cached) { toast('No saved version to revert to.'); return; }
      if (!(await confirmDialog('Revert', 'Discard all changes since the last save?'))) return;
      const { deck } = await importDeck(new Uint8Array(cached.data), cached.name);
      deck.clearHistory();
      app.replaceDeck(tab, deck); tab.dirty = false; app.ui.tabsChanged();
    },
  },
]);

// Exports -------------------------------------------------------------------------------------

for (const f of FORMATS.filter((x) => x.canExport)) {
  def({ id: `file.export.${f.id}`, label: `Export as ${f.label}`, icon: 'ios_share', tab: 'Backstage', group: 'Export', noRecord: true, run: (app) => saveTab(app, app.tab, { copy: true, format: f.id }) });
}

def([
  {
    id: 'file.export.pdf', label: 'Export to PDF', icon: 'picture_as_pdf', tab: 'Backstage', group: 'Export', popular: true, noRecord: true,
    tip: 'Slides, handouts, notes pages or outline as a PDF file, optionally one page per build step. For a PDF with selectable text use Print ▸ Save as PDF.',
    run: async (app, arg?: { what?: string }) => {
      const r = arg?.what ? { what: arg.what, perPage: 6, steps: false, hidden: false, paper: 'letter', quality: 'standard' } : await openDialog({ title: 'Export to PDF', fields: [
        { key: 'what', label: 'Publish what', type: 'select', options: [{ value: 'slides', label: 'Slides' }, { value: 'handouts', label: 'Handouts' }, { value: 'notes', label: 'Notes pages' }, { value: 'outline', label: 'Outline' }], value: 'slides' },
        { key: 'perPage', label: 'Slides per page (handouts)', type: 'select', options: ['1', '2', '3', '4', '6', '9'], value: '6', visibleIf: (v) => v.what === 'handouts' },
        { key: 'paper', label: 'Paper (handouts, notes, outline)', type: 'select', options: [{ value: 'letter', label: 'Letter' }, { value: 'a4', label: 'A4' }], value: 'letter', visibleIf: (v) => v.what !== 'slides' },
        { key: 'steps', label: 'One page per build step', type: 'checkbox', value: false, visibleIf: (v) => v.what === 'slides' },
        { key: 'hidden', label: 'Include hidden slides', type: 'checkbox', value: false },
        { key: 'quality', label: 'Picture quality', type: 'select', options: [{ value: 'standard', label: 'Standard (online and printing)' }, { value: 'small', label: 'Minimum size' }, { value: 'high', label: 'High' }], value: 'standard' },
      ], ok: 'Export' });
      if (!r) return;
      app.ui.hideBackstage();
      toast('Creating the PDF…');
      const { deckToPdf } = await import('../export/pdf');
      const width = r.quality === 'small' ? 960 : r.quality === 'high' ? 2400 : 1600;
      const pdf = await deckToPdf(app.deck, { kind: r.what, perPage: +r.perPage || 6, paper: r.paper, buildSteps: !!r.steps, hidden: !!r.hidden, imageWidth: width, onWarning: (m: string) => toast(m, { ms: 8000 }) } as any);
      await saveBytes(pdf, `${baseName(app)}.pdf`, 'application/pdf');
    },
  },
  { id: 'file.export.handoutsPdf', label: 'Export Handouts PDF', icon: 'picture_as_pdf', tab: 'Backstage', group: 'Export', noRecord: true, run: (app) => app.exec('file.export.pdf', { what: 'handouts' }) },
  {
    id: 'file.export.images', label: 'Export Slides as Pictures…', icon: 'image', tab: 'Backstage', group: 'Export', noRecord: true,
    run: async (app) => {
      const r = await openDialog({ title: 'Export Slides as Pictures', fields: [
        { key: 'format', label: 'Format', type: 'select', options: [{ value: 'png', label: 'PNG' }, { value: 'jpeg', label: 'JPEG' }, { value: 'svg', label: 'SVG (vector)' }], value: 'png' },
        { key: 'which', label: 'Slides', type: 'radio', options: [{ value: 'current', label: 'Current slide' }, { value: 'selected', label: 'Selected slides' }, { value: 'all', label: 'All slides (one ZIP file)' }], value: 'current' },
        { key: 'width', label: 'Width in pixels', type: 'number', value: 1920, min: 160, max: 7680 },
      ], ok: 'Export' });
      if (!r) return;
      const { exportImages } = await import('../export/images');
      const ids = r.which === 'all' ? undefined : r.which === 'selected' ? app.targetSlides().map((s) => s.id) : [app.tab.current];
      const files = await exportImages(app.deck, { format: r.format, width: +r.width || 1920, slides: ids });
      if (files.length === 1) { await saveBytes(files[0].data, files[0].name, r.format === 'svg' ? 'image/svg+xml' : `image/${r.format}`); return; }
      const JSZip = (await import('jszip')).default;
      const zip = new JSZip();
      for (const f of files) zip.file(f.name, f.data);
      await saveBytes(await zip.generateAsync({ type: 'uint8array' }), `${baseName(app)} slides.zip`, 'application/zip');
    },
  },
  {
    id: 'file.export.htmlShow', label: 'Export HTML Show', icon: 'html', tab: 'Backstage', group: 'Export', noRecord: true, origin: 'S5 and reveal.js',
    tip: 'One self-contained web page that plays the presentation in any browser',
    run: async (app) => { const { deckToHtmlShow } = await import('../export/html'); await saveBytes(deckToHtmlShow(app.deck, { title: app.tab.title }), `${baseName(app)}.html`, 'text/html'); },
  },
  {
    id: 'file.export.story', label: 'Export Story (responsive web page)', icon: 'web_stories', tab: 'Backstage', group: 'Export', noRecord: true, origin: 'Sway',
    run: async (app) => { const { deckToStory } = await import('../export/html'); await saveBytes(deckToStory(app.deck), `${baseName(app)} story.html`, 'text/html'); },
  },
  {
    id: 'file.export.outline', label: 'Export Outline…', icon: 'format_list_bulleted', tab: 'Backstage', group: 'Export', noRecord: true,
    run: async (app) => {
      const r = await openDialog({ title: 'Export Outline', fields: [{ key: 'f', label: 'Format', type: 'radio', options: [{ value: 'txt', label: 'Plain text (.txt)' }, { value: 'md', label: 'Markdown (.md)' }, { value: 'rtf', label: 'Rich Text (.rtf)' }], value: 'txt' }] });
      if (!r) return;
      const { outlineToText, outlineToRtf } = await import('../io/outline');
      if (r.f === 'rtf') await saveBytes(outlineToRtf(app.deck), `${baseName(app)} outline.rtf`, 'application/rtf');
      else if (r.f === 'md') { const out = await exportDeck(app.deck, 'md'); await saveBytes(out.data, `${baseName(app)}.md`, 'text/markdown'); }
      else await saveBytes(outlineToText(app.deck), `${baseName(app)} outline.txt`, 'text/plain');
    },
  },
  { id: 'file.export.markdown', label: 'Export Markdown Slides', icon: 'markdown', tab: 'Backstage', group: 'Export', noRecord: true, origin: 'Marp, reveal.js, Slidev', run: (app) => saveTab(app, app.tab, { copy: true, format: 'md' }) },
  {
    id: 'file.package', label: 'Package Presentation…', icon: 'inventory_2', tab: 'Backstage', group: 'Export', noRecord: true, origin: 'Corel Show on the Go, Pack and Go',
    tip: 'A ZIP with the presentation (.pptx and .qsp), a self-contained HTML show that plays anywhere, and a PDF',
    run: async (app) => {
      toast('Packaging…');
      const JSZip = (await import('jszip')).default;
      const zip = new JSZip();
      const b = baseName(app);
      zip.file(`${b}.pptx`, (await exportDeck(app.deck, 'pptx')).data);
      zip.file(`${b}.qsp`, (await exportDeck(app.deck, 'qsp')).data);
      const { deckToHtmlShow } = await import('../export/html');
      zip.file(`${b} (play in a browser).html`, deckToHtmlShow(app.deck, { title: app.tab.title }));
      try { const { deckToPdf } = await import('../export/pdf'); zip.file(`${b}.pdf`, await deckToPdf(app.deck, { kind: 'slides' } as any)); } catch (e) { console.warn('PDF not packaged', e); }
      await saveBytes(await zip.generateAsync({ type: 'uint8array' }), `${b} package.zip`, 'application/zip');
    },
  },
  {
    id: 'file.import.markdown', label: 'Import Markdown Slides…', icon: 'markdown', tab: 'Backstage', group: 'Import', noRecord: true,
    run: async (app) => { const f = await openDocument('.md,.markdown,.txt', ['text/markdown', 'text/plain', '*/*']); if (f) await openBuffer(app, f.data, f.name.replace(/\.txt$/i, '.md'), null); },
  },
  {
    id: 'file.import.textDeck', label: 'Text to Deck…', icon: 'notes', tab: 'Backstage', group: 'Import', noRecord: true, origin: 'Plain-text decks',
    tip: 'Paste or type text: each paragraph (separated by a blank line) becomes a slide',
    run: async (app) => {
      const r = await openDialog({ title: 'Text to Deck', wide: true, fields: [{ key: 't', label: 'Text (blank line = new slide; the first line of each paragraph is its title)', type: 'textarea', rows: 14 }] });
      if (!r?.t?.trim()) return;
      const { textToDeck } = await import('../io/outline');
      const deck = textToDeck(r.t);
      deck.clearHistory();
      app.createTab(deck, { title: 'Text Deck' });
    },
  },
]);

// Print, share, close ------------------------------------------------------------------------

def([
  {
    id: 'file.print', label: 'Print Preview and Print', icon: 'print', tab: 'Backstage', group: 'Print', keys: ['Mod-p'], popular: true, noRecord: true,
    run: async (app) => { app.ui.hideBackstage(); const { printPreviewDialog } = await import('../export/print'); await printPreviewDialog(app); },
  },
  {
    id: 'file.quickPrint', label: 'Quick Print', icon: 'print', tab: 'Backstage', group: 'Print', noRecord: true,
    tip: 'Print all slides with the current settings, without the preview',
    run: async (app) => { const { printDeck } = await import('../export/print'); await printDeck(app, { what: 'slides' }); },
  },
  {
    id: 'file.share', label: 'Share', icon: 'share', tab: 'Backstage', group: 'Share', popular: true, noRecord: true,
    run: async (app) => {
      const r = await openDialog({ title: 'Share', fields: [{ key: 'fmt', label: 'Send as', type: 'radio', options: [...FORMATS.filter((f) => f.canExport && f.id !== 'qspe').map((f) => ({ value: f.id, label: f.label })), { value: 'pdf', label: 'PDF' }], value: 'pptx' }] });
      if (!r) return;
      const b = baseName(app);
      if (r.fmt === 'pdf') {
        const { deckToPdf } = await import('../export/pdf');
        await shareFile(toBlob(await deckToPdf(app.deck, { kind: 'slides' } as any), 'application/pdf'), `${b}.pdf`, app.tab.title);
        return;
      }
      const out = await exportDeck(app.deck, r.fmt);
      await shareFile(toBlob(out.data, out.mime), `${b}.${out.ext}`, app.tab.title);
    },
  },
  {
    id: 'file.email', label: 'Email', icon: 'attach_email', tab: 'Backstage', group: 'Share', noRecord: true,
    tip: 'Send the presentation as an attachment (uses the system share sheet, which includes your mail app and Anne\'s Post when installed)',
    run: async (app) => { const out = await exportDeck(app.deck, 'pptx'); await shareFile(toBlob(out.data, out.mime), `${baseName(app)}.pptx`, app.tab.title); },
  },
  {
    id: 'file.emailPdf', label: 'Email as PDF', icon: 'forward_to_inbox', tab: 'Backstage', group: 'Share', noRecord: true,
    run: async (app) => { const { deckToPdf } = await import('../export/pdf'); await shareFile(toBlob(await deckToPdf(app.deck, { kind: 'slides' } as any), 'application/pdf'), `${baseName(app)}.pdf`, app.tab.title); },
  },
  {
    id: 'file.close', label: 'Close', icon: 'close', tab: 'Backstage', group: 'Close', keys: ['Mod-w', 'Mod-F4'], popular: true, noRecord: true,
    run: async (app, arg) => {
      const tab = app.docs.find((d) => d.id === arg) || app.tab;
      if (tab.dirty && app.prefs.confirmClose) {
        const c = await choiceDialog('Save Changes?', `Save changes to "${tab.displayName}" before closing?`, ['Save', "Don't Save"]);
        if (c < 0) return;
        if (c === 0 && !(await saveTab(app, tab))) return;
      }
      app.closeTab(tab);
      app.ui.hideBackstage();
    },
  },
  { id: 'file.closeAll', label: 'Close All', icon: 'tab_close', tab: 'Backstage', group: 'Close', noRecord: true, run: async (app) => { for (const d of [...app.docs]) { app.activate(d); await app.exec('file.close', d.id); } } },
  {
    id: 'file.exit', label: 'Exit', icon: 'logout', tab: 'Backstage', group: 'Close', noRecord: true,
    run: async (app) => {
      for (const d of [...app.docs]) if (d.dirty) { app.activate(d); await app.exec('file.close', d.id); if (app.docs.includes(d)) return; }
      await app.saveDrafts();
      if (isDesktop()) { window.close(); return; }
      try { const { App: CapApp } = await import('@capacitor/app'); await CapApp.exitApp(); } catch { window.close(); }
    },
  },
]);

// Info ---------------------------------------------------------------------------------------

def([
  {
    id: 'file.properties', label: 'Properties…', icon: 'info', tab: 'Backstage', group: 'Info', noRecord: true, edits: true,
    run: async (app) => {
      const p = app.deck.data.props;
      const r = await openDialog({ title: 'Presentation Properties', wide: true, fields: [
        { key: 'title', label: 'Title', type: 'text', value: p.title || '' }, { key: 'subject', label: 'Subject', type: 'text', value: p.subject || '' },
        { key: 'author', label: 'Author', type: 'text', value: p.author || app.prefs.author, half: true }, { key: 'company', label: 'Company', type: 'text', value: p.company || '', half: true },
        { key: 'category', label: 'Category', type: 'text', value: p.category || '', half: true }, { key: 'keywords', label: 'Tags / keywords', type: 'text', value: p.keywords || '', half: true },
        { key: 'description', label: 'Comments', type: 'textarea', rows: 3, value: p.description || '' },
        { key: 'custom', label: 'Custom properties (name=value per line)', type: 'textarea', rows: 3, value: Object.entries(p.custom || {}).map(([k, x]) => `${k}=${x}`).join('\n') },
        { key: 'stats', type: 'info', html: `<p class="ql-help">Created: ${p.created ? new Date(p.created).toLocaleString() : '—'} · Modified: ${p.modified ? new Date(p.modified).toLocaleString() : '—'} · Last saved: ${app.tab.saved ? new Date(app.tab.saved).toLocaleString() : '—'}</p>` },
      ] });
      if (!r) return;
      app.deck.transact('Properties', () => {
        Object.assign(app.deck.data.props, { title: r.title, subject: r.subject, author: r.author, company: r.company, category: r.category, keywords: r.keywords, description: r.description });
        app.deck.data.props.custom = Object.fromEntries(String(r.custom).split('\n').map((l) => l.split('=')).filter((x) => x[0]?.trim()).map(([k, ...rest]) => [k.trim(), rest.join('=').trim()]));
      });
    },
  },
  {
    id: 'file.inspect', label: 'Inspect Presentation…', icon: 'policy', tab: 'Backstage', group: 'Info', noRecord: true, edits: true,
    tip: 'Find and remove comments, speaker notes, hidden slides, off-slide content, invisible objects and personal information before sharing',
    run: async (app) => {
      const d = app.deck;
      const { w, h } = d.size;
      let comments = 0, notes = 0, offSlide = 0, invisible = 0, ink = 0;
      for (const s of d.slides) {
        comments += s.comments?.length || 0;
        if (s.notes.some((p) => p.runs.some((r) => r.text))) notes++;
        ink += s.ink?.length || 0;
        for (const e of s.elements) {
          if (e.hidden) invisible++;
          if (e.x != null && e.y != null && e.w != null && e.h != null && (e.x + e.w < 0 || e.y + e.h < 0 || e.x > w || e.y > h)) offSlide++;
        }
      }
      const hidden = d.slides.filter((s) => s.hidden).length;
      const r = await openDialog({ title: 'Document Inspector', help: 'Select the content to remove before sharing. You can undo the removal with Undo.', fields: [
        { key: 'comments', label: `Comments (${comments})`, type: 'checkbox', value: comments > 0 },
        { key: 'props', label: 'Document properties and personal information', type: 'checkbox', value: true },
        { key: 'notes', label: `Speaker notes (${notes} slides)`, type: 'checkbox', value: false },
        { key: 'hidden', label: `Hidden slides (${hidden})`, type: 'checkbox', value: false },
        { key: 'offSlide', label: `Off-slide content (${offSlide})`, type: 'checkbox', value: false },
        { key: 'invisible', label: `Invisible objects (${invisible})`, type: 'checkbox', value: false },
        { key: 'ink', label: `Ink annotations (${ink})`, type: 'checkbox', value: false },
        { key: 'tags', label: 'Slide tags (status, assignees)', type: 'checkbox', value: false },
        { key: 'vba', label: `Macro project (${d.data.vba ? 'present' : 'none'})`, type: 'checkbox', value: false },
      ], ok: 'Remove' });
      if (!r) return;
      d.transact('Inspect Presentation', () => {
        if (r.hidden) d.data.slides = d.data.slides.filter((s) => !s.hidden);
        for (const s of d.slides) {
          if (r.comments) s.comments = [];
          if (r.notes) s.notes = [];
          if (r.ink) s.ink = [];
          if (r.tags) delete s.tags;
          if (r.invisible) s.elements = s.elements.filter((e) => !e.hidden);
          if (r.offSlide) s.elements = s.elements.filter((e) => !(e.x != null && e.y != null && e.w != null && e.h != null && (e.x + e.w < 0 || e.y + e.h < 0 || e.x > w || e.y > h)));
        }
        if (r.props) { const keep = d.data.props.title; d.data.props = { title: keep, created: d.data.props.created }; }
        if (r.vba) delete d.data.vba;
      });
      toast('Presentation inspected and cleaned');
    },
  },
  { id: 'file.encrypt', label: 'Encrypt with Password…', icon: 'enhanced_encryption', tab: 'Backstage', group: 'Info', noRecord: true, tip: 'Save an AES-256 encrypted Anne\'s Stage copy (.qspe)', run: (app) => saveTab(app, app.tab, { copy: true, format: 'qspe' }) },
  {
    id: 'file.markFinal', label: 'Mark as Final', icon: 'verified', tab: 'Backstage', group: 'Info', kind: 'toggle', noRecord: true,
    tip: 'Make the presentation read-only so readers know it is finished',
    isActive: (app) => !!app.deck?.data.finalMarked,
    run: (app) => { const d = app.deck; d.data.finalMarked = !d.data.finalMarked; d.changed(); toast(d.data.finalMarked ? 'Marked as final: editing is turned off.' : 'Editing is allowed again.'); },
  },
  {
    id: 'file.alwaysReadOnly', label: 'Always Open Read-Only', icon: 'lock', tab: 'Backstage', group: 'Info', kind: 'toggle', noRecord: true,
    isActive: (app) => app.deck?.data.props.custom?.['quillstage:readOnly'] === '1',
    run: (app) => {
      const d = app.deck;
      d.transact('Always Open Read-Only', () => { const c = (d.data.props.custom ||= {}); if (c['quillstage:readOnly'] === '1') delete c['quillstage:readOnly']; else c['quillstage:readOnly'] = '1'; });
    },
  },
  {
    id: 'file.checkCompatibility', label: 'Check Compatibility', icon: 'rule', tab: 'Backstage', group: 'Info', noRecord: true,
    tip: 'Features that change when the presentation is saved as OpenDocument or Markdown',
    run: async (app) => {
      const d = app.deck;
      const issues: string[] = [];
      const morph = d.slides.filter((s) => s.transition?.type === 'morph').length;
      if (morph) issues.push(`${morph} slide(s) use Smooth Morph: OpenDocument shows a fade instead.`);
      const anims = d.slides.reduce((a, s) => a + s.anims.length, 0);
      if (anims) issues.push(`${anims} animation(s): Markdown slides keep no animations; OpenDocument keeps common entrance and exit effects.`);
      const charts = d.slides.reduce((a, s) => a + s.elements.filter((e) => e.kind === 'chart').length, 0);
      if (charts) issues.push(`${charts} chart(s): Markdown keeps no charts.`);
      if (d.data.vba) issues.push('The macro project is kept only in .pptm.');
      if (d.data.sections.length) issues.push('Sections are kept in .pptx and .qsp only.');
      if (d.slides.some((s) => s.ink?.length)) issues.push('Ink annotations are kept in .qsp and as drawn shapes in .pptx.');
      await openDialog({ title: 'Compatibility Checker', content: Object.assign(document.createElement('div'), { className: 'ql-msg', innerHTML: issues.length ? `<ul>${issues.map((i) => `<li>${i.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</li>`).join('')}</ul>` : '<p>No compatibility issues were found.</p>' }), cancel: false });
    },
  },
  { id: 'file.versions', label: 'Version History', icon: 'history', tab: 'Backstage', group: 'Info', popular: true, noRecord: true, origin: 'Snapshots (Scrivener) / version history (online editors)', run: (app) => { app.ui.hideBackstage(); app.ui.openPane('versions'); } },
  { id: 'file.snapshot', label: 'Take Snapshot', icon: 'add_a_photo', tab: 'Backstage', group: 'Info', keys: ['Mod-Alt-5'], noRecord: true, run: async (app) => { const label = await promptDialog('Take Snapshot', 'Snapshot name', `Snapshot ${new Date().toLocaleString()}`); if (label) { await snapshot(app, app.tab, label); toast('Snapshot saved'); } } },
  {
    id: 'file.recoverUnsaved', label: 'Recover Unsaved Presentations', icon: 'restore_page', tab: 'Backstage', group: 'Info', noRecord: true,
    run: async (app) => {
      const keys = (await kvKeys('draft:')).filter((k) => !app.docs.some((d) => 'draft:' + d.id === k));
      if (!keys.length) { toast('No unsaved drafts found.'); return; }
      // One unreadable draft must not hide the others.
      const drafts = (await Promise.all(keys.map(async (k) => { try { return { k, d: await kvGet(k) }; } catch { return { k, d: undefined }; } })))
        .filter((x): x is { k: string; d: any } => !!x.d && typeof x.d === 'object' && !!x.d.json);
      const bad = keys.length - drafts.length;
      if (!drafts.length) { toast(bad ? `${bad} draft(s) could not be read.` : 'No unsaved drafts found.'); return; }
      const r = await openDialog({ title: 'Presentation Recovery', fields: [{ key: 'k', label: 'Available drafts', type: 'list', multiple: true, rows: 8, options: drafts.map(({ k, d }) => ({ value: k, label: `${d.fileName || d.title || 'Presentation'} — ${d.time ? new Date(d.time).toLocaleString() : 'unknown time'}` })), value: drafts.map((x) => x.k) }], help: bad ? `${bad} damaged draft(s) could not be read; Discard All removes them too.` : undefined, buttons: [{ label: 'Discard All', onClick: async (_v, ctl) => { for (const k of keys) await kvDel(k); ctl.close(); toast('Drafts discarded'); } }], ok: 'Recover' });
      if (!r?.k?.length) return;
      for (const { k, d } of drafts.filter((x) => r.k.includes(x.k))) {
        try {
          const tab = app.createTab(Deck.fromJSON(d.json), { title: d.title, fileName: d.fileName, format: d.format, uri: d.uri, key: d.key || '' });
          // Mark it changed so it is saved as a draft again (under the new tab) and asks to be saved on close.
          tab.dirty = true;
          app.ui.tabsChanged();
          app.scheduleAutosave();
          await kvDel(k);
        } catch (e) { toast(`Could not restore ${d.title || 'a draft'}: ${(e as Error).message}`); }
      }
    },
  },
  {
    id: 'file.compressMedia', label: 'Compress Media…', icon: 'compress', tab: 'Backstage', group: 'Info', noRecord: true, edits: true,
    tip: 'Remove media no slide uses and report the size of the rest (pictures are re-encoded with Picture Format ▸ Compress Pictures)',
    run: async (app) => {
      const d = app.deck;
      const used = new Set<string>();
      const walkEls = (els: any[]) => { for (const e of els) { if (e.media) used.add(e.media); if (e.poster) used.add(e.poster); if (e.fill?.type === 'image') used.add(e.fill.media); if (e.children) walkEls(e.children); } };
      for (const s of d.slides) { walkEls(s.elements); if (s.bg?.type === 'image') used.add(s.bg.media); }
      for (const l of d.data.layouts) { walkEls(l.elements); if (l.bg?.type === 'image') used.add(l.bg.media); }
      for (const m of d.data.masters) { walkEls(m.elements); if (m.bg?.type === 'image') used.add(m.bg.media); }
      // Media named anywhere else in the document (notes, comments, themes) also stays.
      const now = JSON.stringify(d.data);
      // Undo and Redo restore earlier states, which may use media no slide uses now.
      const stacks = [(d as any).undoStack, (d as any).redoStack];
      const canScan = stacks.every(Array.isArray);
      const past = canScan ? JSON.stringify(stacks) : '';
      for (const k of Object.keys(d.media)) if (now.includes(`"${k}"`) || past.includes(`"${k}"`)) used.add(k);
      const unused = Object.keys(d.media).filter((k) => !used.has(k));
      const size = (ks: string[]) => ks.reduce((a, k) => a + Math.floor(((d.media[k]?.b64?.length || 0) * 3) / 4), 0);
      const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;
      if (!unused.length) { toast(`All ${used.size} media files are in use (${kb(size([...used]))}).`); return; }
      if (!(await confirmDialog('Compress Media', `${unused.length} media file(s) are not used by any slide (${kb(size(unused))}). Remove them?${canScan ? '' : ' Undo history will be cleared.'}`, 'Remove'))) return;
      for (const k of unused) delete d.media[k];
      if (!canScan) d.clearHistory();
      d.changed();
      toast(`Removed ${unused.length} unused media file(s).`);
    },
  },
]);

// Options ------------------------------------------------------------------------------------

def([
  {
    id: 'file.options', label: 'Options…', icon: 'settings', tab: 'Backstage', group: 'Options', popular: true, noRecord: true,
    run: async (app) => {
      const p = app.prefs;
      const r = await openDialog({ title: 'Anne\'s Stage Options', wide: true, fields: [
        { key: 'h1', type: 'heading', label: 'General' },
        { key: 'author', label: 'User name', type: 'text', value: p.author, half: true },
        { key: 'initials', label: 'Initials', type: 'text', value: p.initials, half: true },
        { key: 'theme', label: 'App theme', type: 'select', options: ['system', 'light', 'dark'], value: p.theme, half: true },
        { key: 'uiScale', label: 'Toolbar size', type: 'select', options: [{ value: '0.85', label: 'Compact' }, { value: '1', label: 'Normal' }, { value: '1.15', label: 'Large (touch)' }], value: String(p.uiScale), half: true },
        { key: 'qatPosition', label: 'Quick Access Bar', type: 'select', options: [{ value: 'top', label: 'Above the ribbon' }, { value: 'below', label: 'Below the ribbon' }, { value: 'bottom', label: 'At the bottom (near keyboard)' }], value: p.qatPosition, half: true },
        { key: 'qatLabels', label: 'Show labels on Quick Access Bar', type: 'checkbox', value: p.qatLabels, half: true },
        { key: 'h2', type: 'heading', label: 'New presentations' },
        { key: 'defaultSize', label: 'Slide size', type: 'select', options: [{ value: 'wide', label: 'Widescreen (16:9)' }, { value: 'standard', label: 'Standard (4:3)' }], value: p.defaultSize, half: true },
        { key: 'defaultSaveFormat', label: 'Default save format', type: 'select', options: FORMATS.filter((f) => f.canExport && f.id !== 'qspe').map((f) => ({ value: f.id, label: f.label })), value: p.defaultSaveFormat, half: true },
        { key: 'h3', type: 'heading', label: 'Editing' },
        { key: 'snapToGrid', label: 'Snap objects to grid', type: 'checkbox', value: p.snapToGrid, half: true },
        { key: 'gridSize', label: 'Grid spacing (points)', type: 'number', min: 2, max: 144, value: p.gridSize, half: true },
        { key: 'smartGuides', label: 'Smart guides when moving objects', type: 'checkbox', value: p.smartGuides, half: true },
        { key: 'autoLists', label: 'Automatic bulleted and numbered lists', type: 'checkbox', value: p.autoLists, half: true },
        { key: 'autoCorrect', label: 'AutoCorrect as you type', type: 'checkbox', value: p.autoCorrect, half: true },
        { key: 'autoCapitalize', label: 'Capitalize the first letter of sentences', type: 'checkbox', value: p.autoCapitalize, half: true },
        { key: 'h4', type: 'heading', label: 'Slide Show' },
        { key: 'presenterView', label: 'Use Presenter View when presenting', type: 'checkbox', value: p.presenterView, half: true },
        { key: 'showEndBlack', label: 'End with a black slide', type: 'checkbox', value: p.showEndBlack, half: true },
        { key: 'penColor', label: 'Pen color', type: 'color', value: p.penColor, half: true },
        { key: 'laserColor', label: 'Laser pointer color', type: 'color', value: p.laserColor, half: true },
        { key: 'h5', type: 'heading', label: 'Save and Proofing' },
        { key: 'autosave', label: 'AutoSave drafts', type: 'checkbox', value: p.autosave, half: true },
        { key: 'autosaveSeconds', label: 'Every (seconds)', type: 'number', value: p.autosaveSeconds, half: true },
        { key: 'confirmClose', label: 'Ask to save when closing', type: 'checkbox', value: p.confirmClose, half: true },
        { key: 'spellcheck', label: 'Check spelling as you type', type: 'checkbox', value: p.spellcheck, half: true },
        { key: 'spellDialect', label: 'English spelling', type: 'select', options: SPELL_DIALECTS, value: p.spellDialect || 'any', half: true },
        { key: 'h6', type: 'heading', label: 'Customize' },
        { key: 'bq', type: 'button', label: 'Customize Quick Access Bar…', onClick: () => app.exec('file.customizeQat') },
        { key: 'br', type: 'button', label: 'Customize Tabs (Ribbon)…', onClick: () => app.exec('file.customizeRibbon') },
        { key: 'bk', type: 'button', label: 'Customize Keyboard…', onClick: () => app.exec('file.customizeKeyboard') },
        { key: 'ba', type: 'button', label: 'AutoCorrect Options…', onClick: () => app.exec('file.autocorrectOptions') },
        { key: 'bx', type: 'button', label: 'Export / Import All Settings…', onClick: () => app.exec('file.exportSettings') },
      ] });
      if (!r) return;
      Object.assign(p, {
        author: r.author || 'Author', initials: r.initials || (r.author || 'A')[0], theme: r.theme, uiScale: parseFloat(r.uiScale), qatPosition: r.qatPosition, qatLabels: r.qatLabels,
        defaultSize: r.defaultSize, defaultSaveFormat: r.defaultSaveFormat, snapToGrid: r.snapToGrid, gridSize: Math.max(2, Math.min(144, r.gridSize || 12)), smartGuides: r.smartGuides,
        autoLists: r.autoLists, autoCorrect: r.autoCorrect, autoCapitalize: r.autoCapitalize, presenterView: r.presenterView, showEndBlack: r.showEndBlack, penColor: r.penColor, laserColor: r.laserColor,
        autosave: r.autosave, autosaveSeconds: Math.max(3, r.autosaveSeconds || 10), confirmClose: r.confirmClose, spellcheck: r.spellcheck, spellDialect: r.spellDialect,
      });
      // Clamp the numbers typed into the form (NaN falls back to the default).
      Object.assign(p, sanitizePrefs({ uiScale: p.uiScale, gridSize: p.gridSize, autosaveSeconds: p.autosaveSeconds }));
      app.savePrefs();
      app.ui.applyPrefs();
    },
  },
  { id: 'file.customizeQat', label: 'Customize Quick Access Bar…', icon: 'tune', tab: 'Backstage', group: 'Options', popular: true, noRecord: true, run: (app) => app.ui.customizeQat() },
  { id: 'file.customizeRibbon', label: 'Customize Tabs…', icon: 'view_quilt', tab: 'Backstage', group: 'Options', noRecord: true, run: (app) => app.ui.customizeRibbon() },
  { id: 'file.customizeKeyboard', label: 'Customize Keyboard…', icon: 'keyboard', tab: 'Backstage', group: 'Options', noRecord: true, run: (app) => app.ui.customizeKeyboard() },
  {
    id: 'file.autocorrectOptions', label: 'AutoCorrect Options…', icon: 'auto_fix_normal', tab: 'Backstage', group: 'Options', noRecord: true,
    run: async (app) => {
      const r = await openDialog({ title: 'AutoCorrect', wide: true, fields: [
        { key: 'on', label: 'Replace text as you type', type: 'checkbox', value: app.prefs.autoCorrect },
        { key: 'caps', label: 'Capitalize the first letter of sentences', type: 'checkbox', value: app.prefs.autoCapitalize },
        { key: 'lists', label: 'Automatic bulleted and numbered lists', type: 'checkbox', value: app.prefs.autoLists },
        { key: 'list', label: 'Replacements (one per line: typo => correction)', type: 'textarea', rows: 12, value: Object.entries(app.prefs.replacements).map(([k, x]) => `${k} => ${x}`).join('\n') },
      ], buttons: [{ label: 'Reset to Defaults', onClick: (_v, ctl) => ctl.set('list', Object.entries(DEFAULT_REPLACEMENTS).map(([k, x]) => `${k} => ${x}`).join('\n')) }] });
      if (!r) return;
      app.prefs.autoCorrect = r.on; app.prefs.autoCapitalize = r.caps; app.prefs.autoLists = r.lists;
      app.prefs.replacements = Object.fromEntries(String(r.list).split('\n').map((l) => l.split('=>')).filter((x) => x.length === 2 && x[0].trim()).map(([k, x]) => [k.trim(), x.trim()]));
      app.savePrefs();
    },
  },
  {
    id: 'file.customDictionary', label: 'Custom Dictionary…', icon: 'book', tab: 'Backstage', group: 'Options', noRecord: true,
    run: async (app) => {
      const r = await openDialog({ title: 'Custom Dictionary', fields: [{ key: 'words', label: 'Words (one per line)', type: 'textarea', rows: 12, value: app.prefs.dictionary.join('\n') }, { key: 'ign', label: 'Ignored words (one per line)', type: 'textarea', rows: 4, value: app.prefs.ignoredWords.join('\n') }] });
      if (!r) return;
      app.prefs.dictionary = String(r.words).split('\n').map((w) => w.trim()).filter(Boolean);
      app.prefs.ignoredWords = String(r.ign).split('\n').map((w) => w.trim()).filter(Boolean);
      app.savePrefs();
    },
  },
  {
    id: 'file.exportSettings', label: 'Export / Import Settings…', icon: 'import_export', tab: 'Backstage', group: 'Options', noRecord: true,
    run: async (app) => {
      const r = await openDialog({ title: 'Settings Transfer', help: 'Copy this text to back up your Quick Access Bar, custom tabs, shortcuts, macros, AutoCorrect and preferences. Paste settings text here and choose Import to restore. The format is shared with Anne\'s Pen and Anne\'s Grid; settings that do not apply to Anne\'s Stage are ignored.', fields: [{ key: 'json', label: 'Settings (JSON)', type: 'textarea', rows: 12, value: JSON.stringify({ ...app.prefs, recent: [] }, null, 1) }], ok: 'Import', buttons: [{ label: 'Copy', onClick: (x) => { navigator.clipboard?.writeText(x.json); toast('Copied'); } }] });
      if (!r) return;
      let p: unknown;
      try { p = JSON.parse(r.json); } catch { /* reported below */ }
      if (!p || typeof p !== 'object' || Array.isArray(p)) { toast('That is not valid settings JSON.'); return; }
      const before = JSON.parse(JSON.stringify(app.prefs));
      Object.assign(app.prefs, sanitizePrefs(p), { recent: app.prefs.recent });
      try { app.ui.applyPrefs(); app.ui.rebuild(); } catch (e: any) {
        Object.assign(app.prefs, before); app.ui.applyPrefs(); app.ui.rebuild();
        toast(`These settings could not be applied: ${e?.message || e}`);
        return;
      }
      app.savePrefs();
      toast('Settings imported');
    },
  },
  { id: 'file.resetCustomizations', label: 'Reset All Customizations', icon: 'restart_alt', tab: 'Backstage', group: 'Options', noRecord: true, run: async (app) => { if (!(await confirmDialog('Reset', 'Reset the Quick Access Bar, custom tabs and keyboard shortcuts to defaults?'))) return; const { DEFAULT_QAT } = await import('../prefs'); app.prefs.qat = [...DEFAULT_QAT]; app.prefs.customTabs = []; app.prefs.hiddenTabs = []; app.prefs.tabOrder = []; app.prefs.keymap = {}; app.savePrefs(); app.ui.rebuild(); } },
]);

/** Words in a deck (slides and notes), used by statistics and the backstage Info page. */
export function wordCount(deck: Deck, notes = false): number {
  let n = 0;
  forEachText(deck.slides, (paras, el) => { if (!notes && !el) return; for (const p of paras) for (const r of p.runs) n += (r.text.match(/\S+/g) || []).length; }, notes);
  return n;
}

