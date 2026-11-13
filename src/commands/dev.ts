/** Developer tab: macros (recorded command lists), macro editor, VBA viewer, tags, native JSON. */
import { def } from './registry';
import type { App } from '../app';
import type { Macro } from '../prefs';
import { Deck } from '../model/deck';
import { getCommand } from './registry';
import { openDialog, toast, confirmDialog, promptDialog } from '../ui/dialog';
import { download, pickFile, esc } from '../ui/dom';

/** Macros running inside one another, outermost first. */
const runningMacros: string[] = [];
let macroAbort = false;
export const MAX_MACRO_DEPTH = 8;

export async function runMacro(app: App, name: string): Promise<void> {
  const m = app.prefs.macros.find((x) => x.name === name);
  if (!m) { toast(`No macro named "${name}".`); return; }
  if (runningMacros.includes(name) || runningMacros.length >= MAX_MACRO_DEPTH) {
    macroAbort = true;
    toast(runningMacros.includes(name)
      ? `Macro "${name}" stopped: it runs itself (${[...runningMacros, name].join(' → ')}).`
      : `Macro "${name}" stopped: macros can run other macros only ${MAX_MACRO_DEPTH} levels deep.`);
    return;
  }
  if (!runningMacros.length) macroAbort = false;
  runningMacros.push(name);
  try {
    for (const s of m.steps) {
      if (macroAbort) return;
      if (!getCommand(s.id)) { toast(`Macro "${name}" stopped: the command ${s.id} no longer exists.`); macroAbort = true; return; }
      // Steps run as part of the macro: they are not recorded again or made the command to repeat.
      app.execDepth = (app.execDepth || 0) + 1;
      let r: unknown;
      try { r = app.exec(s.id, s.arg); } finally { app.execDepth--; }
      if (r instanceof Promise) await r;
    }
  } finally {
    runningMacros.pop();
    if (!runningMacros.length) macroAbort = false;
  }
}

function stepsLabel(m: Macro): string {
  return m.steps.map((s) => getCommand(s.id)?.label || s.id).slice(0, 6).join(' → ') + (m.steps.length > 6 ? ' …' : '');
}

/** Lists readable module and stream names inside a VBA project (compound file), without running anything. */
export function vbaSummary(b64: string): { bytes: number; names: string[] } {
  const bin = atob(b64);
  const names = new Set<string>();
  // Directory entries of a compound file store names as UTF-16LE.
  const re = /((?:[A-Za-z0-9_ ]\x00){3,31})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bin))) { const n = m[1].replace(/\x00/g, ''); if (!/^(Root Entry|_VBA_PROJECT|dir|PROJECT|PROJECTwm|VBA)$/.test(n) && !/^__SRP_/.test(n)) names.add(n); }
  return { bytes: bin.length, names: [...names].slice(0, 200) };
}

def([
  {
    id: 'dev.macros', label: 'Macros', icon: 'smart_button', tab: 'Developer', group: 'Code', keys: ['Alt-F8'], edits: false, noRecord: true,
    tip: 'Run, rename, delete or put a macro on the Quick Access Bar',
    run: async (app) => {
      const ms = app.prefs.macros;
      if (!ms.length) { toast('No macros yet. Use Record Macro to make one.', { action: 'Record', onAction: () => app.exec('dev.recordMacro') }); return; }
      const r = await openDialog({ title: 'Macros', fields: [
        { key: 'm', label: 'Macro', type: 'list', options: ms.map((m) => ({ value: m.name, label: `${m.name} — ${stepsLabel(m)}` })), value: ms[0].name },
        { key: 'act', label: 'Action', type: 'radio', options: [{ value: 'run', label: 'Run' }, { value: 'edit', label: 'Edit…' }, { value: 'rename', label: 'Rename…' }, { value: 'qat', label: 'Add to Quick Access Bar' }, { value: 'delete', label: 'Delete' }], value: 'run' },
      ] });
      if (!r?.m) return;
      const m = ms.find((x) => x.name === r.m)!;
      if (r.act === 'run') await runMacro(app, m.name);
      else if (r.act === 'edit') app.exec('dev.macroEditor', m.name);
      else if (r.act === 'rename') { const n = await promptDialog('Rename Macro', 'Name', m.name); if (n && !ms.some((x) => x.name === n)) { const old = m.name; m.name = n; app.prefs.qat = app.prefs.qat.map((q) => (q === `macro:${old}` ? `macro:${n}` : q)); app.savePrefs(); app.ui.renderQat(); } }
      else if (r.act === 'qat') { if (!app.prefs.qat.includes(`macro:${m.name}`)) app.prefs.qat = [...app.prefs.qat, `macro:${m.name}`]; app.savePrefs(); app.ui.renderQat(); }
      else if (r.act === 'delete' && (await confirmDialog('Delete Macro', `Delete "${m.name}"?`, 'Delete'))) { app.prefs.macros = ms.filter((x) => x !== m); app.prefs.qat = app.prefs.qat.filter((q) => q !== `macro:${m.name}`); app.savePrefs(); app.ui.renderQat(); }
    },
  },
  { id: 'dev.runMacro', label: 'Run Macro', icon: 'play_arrow', tab: 'Developer', group: 'Code', internal: true, edits: false, run: (app, name: string) => runMacro(app, name) },
  {
    id: 'dev.recordMacro', label: 'Record Macro', icon: 'fiber_manual_record', tab: 'Developer', group: 'Code', kind: 'toggle', noRecord: true, edits: false,
    tip: 'Record the commands you run (formatting, inserting, slide changes) to replay them later',
    isActive: (app) => !!app.recording,
    run: async (app) => {
      if (app.recording) { app.exec('dev.stopRecording'); return; }
      const name = await promptDialog('Record Macro', 'Macro name', `Macro${app.prefs.macros.length + 1}`);
      if (!name) return;
      if (app.prefs.macros.some((m) => m.name === name) && !(await confirmDialog('Record Macro', `Replace the macro "${name}"?`, 'Replace'))) return;
      app.recording = { name, steps: [] };
      app.recordingPaused = false;
      app.ui.status?.('● Recording macro');
    },
  },
  {
    id: 'dev.stopRecording', label: 'Stop Recording', icon: 'stop', tab: 'Developer', group: 'Code', noRecord: true, edits: false, isEnabled: (app) => !!app.recording,
    run: (app) => {
      const rec = app.recording;
      if (!rec) return;
      app.recording = null;
      app.ui.status?.('');
      if (!rec.steps.length) { toast('Nothing was recorded.'); return; }
      app.prefs.macros = [...app.prefs.macros.filter((m) => m.name !== rec.name), { name: rec.name, steps: rec.steps, created: Date.now() }];
      app.savePrefs();
      toast(`Macro "${rec.name}" saved with ${rec.steps.length} step(s).`, { action: 'Add to QAT', onAction: () => { app.prefs.qat = [...app.prefs.qat, `macro:${rec.name}`]; app.savePrefs(); app.ui.renderQat(); } });
    },
  },
  {
    id: 'dev.macroEditor', label: 'Macro Editor', icon: 'code', tab: 'Developer', group: 'Code', noRecord: true, edits: false,
    tip: 'Edit a macro\'s steps (one command per line: id and an optional JSON argument)',
    run: async (app, name?: string) => {
      const ms = app.prefs.macros;
      const m = ms.find((x) => x.name === name) || ms[0];
      const text = m ? m.steps.map((s) => (s.arg === undefined ? s.id : `${s.id} ${JSON.stringify(s.arg)}`)).join('\n') : 'fmt.bold\nfmt.fontSize 28';
      const r = await openDialog({ title: m ? `Edit Macro: ${m.name}` : 'New Macro', wide: true, fields: [
        { key: 'name', label: 'Name', type: 'text', value: m?.name || `Macro${ms.length + 1}` },
        { key: 'desc', label: 'Description', type: 'text', value: m?.description || '' },
        { key: 'steps', label: 'Steps', type: 'textarea', rows: 14, value: text, help: 'Find command ids in Help ▸ Command Reference or the Customize dialogs. Macros run Anne\'s Stage commands only; they cannot reach files, the network or other apps.' },
      ], validate: (v) => {
        for (const [i, line] of String(v.steps).split('\n').entries()) {
          const t = line.trim(); if (!t || t.startsWith('#')) continue;
          const [id, ...rest] = t.split(/\s+/);
          if (!getCommand(id)) return `Line ${i + 1}: unknown command "${id}".`;
          if (rest.length) { try { JSON.parse(rest.join(' ')); } catch { return `Line ${i + 1}: the argument is not valid JSON.`; } }
        }
        return v.name ? null : 'Give the macro a name.';
      } });
      if (!r) return;
      const steps = String(r.steps).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => { const [id, ...rest] = l.split(/\s+/); return rest.length ? { id, arg: JSON.parse(rest.join(' ')) } : { id }; });
      app.prefs.macros = [...ms.filter((x) => x.name !== r.name && x !== m), { name: r.name, description: r.desc || undefined, steps, created: m?.created || Date.now() }];
      app.savePrefs();
      toast(`Saved "${r.name}".`, { action: 'Run', onAction: () => void runMacro(app, r.name) });
    },
  },
  {
    id: 'dev.macroSecurity', label: 'Macro Security', icon: 'admin_panel_settings', tab: 'Developer', group: 'Code', noRecord: true, edits: false,
    run: async () => { await openDialog({ title: 'Macro Security', ok: 'Close', cancel: false, fields: [{ key: 'i', type: 'info', html: '<p><b>Anne\'s Stage macros are lists of Anne\'s Stage commands.</b> They can do only what you could do with the ribbon: format, insert, change slides. They cannot run code, read or write files on their own, or use the network.</p><p><b>VBA macros</b> in .pptm files are kept byte-for-byte when you save as .pptm, and can be viewed (Developer ▸ View VBA Project), but are <b>never run</b>.</p>' }] }); },
  },
  {
    id: 'dev.viewVba', label: 'View VBA Project', icon: 'data_object', tab: 'Developer', group: 'Code', noRecord: true, edits: false, isEnabled: (app) => !!app.deck.data.vba,
    tip: 'Show the modules in this presentation\'s VBA project (read-only; never run)',
    run: async (app) => {
      const v = vbaSummary(app.deck.data.vba!);
      await openDialog({ title: 'VBA Project (read-only)', ok: 'Close', cancel: false, fields: [{ key: 'i', type: 'info', html: `<p>${(v.bytes / 1024).toFixed(1)} KB. Anne\'s Stage keeps this project when saving as .pptm and never runs it.</p><p><b>Modules and streams:</b> ${v.names.map((n) => esc(n)).join(', ') || '(none found)'}</p>` }] });
    },
  },
  {
    id: 'dev.tags', label: 'Document Tags', icon: 'sell', tab: 'Developer', group: 'Data', edits: true, isEnabled: (app) => !!app.slide,
    tip: 'Edit the current slide\'s tags (name = value, one per line)',
    run: async (app) => {
      const s = app.slide!;
      const r = await openDialog({ title: 'Slide Tags', fields: [{ key: 't', label: 'Tags (name = value per line)', type: 'textarea', rows: 8, value: Object.entries(s.tags || {}).map(([k, v]) => `${k} = ${v}`).join('\n') }] });
      if (!r) return;
      const tags: Record<string, string> = {};
      for (const l of String(r.t).split('\n')) { const i = l.indexOf('='); if (i > 0) tags[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }
      app.deck.transact('Tags', () => { s.tags = Object.keys(tags).length ? tags : undefined; }, [s.id]);
    },
  },
  {
    id: 'dev.exportJson', label: 'Export Presentation JSON', icon: 'download', tab: 'Developer', group: 'Data', noRecord: true, edits: false,
    run: (app) => download(new Blob([JSON.stringify(app.deck.toJSON(), null, 1)], { type: 'application/json' }), `${(app.tab.displayName || 'presentation').replace(/\.[^.]+$/, '')}.json`),
  },
  {
    id: 'dev.importJson', label: 'Import Presentation JSON', icon: 'upload', tab: 'Developer', group: 'Data', noRecord: true, edits: false,
    tip: 'Open an Anne\'s Stage presentation JSON file in a new tab',
    run: async (app) => {
      const f = (await pickFile('.json,application/json'))[0];
      if (!f) return;
      try { const d = Deck.fromJSON(JSON.parse(await f.text())); app.createTab(d, { title: f.name.replace(/\.json$/i, ''), fileName: f.name, format: 'json' }); }
      catch (e: any) { toast(`Not an Anne\'s Stage presentation: ${e?.message || e}`); }
    },
  },
]);

