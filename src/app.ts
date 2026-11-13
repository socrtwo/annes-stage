/** Anne's Stage application core: presentation tabs, command execution, recording, autosave. */
import { isSafeExternalUrl } from './util/sanitize';
import { Deck } from './model/deck';
import type { Element, Layout, Master, Slide } from './model/types';
import { getCommand, allCommands, type Command } from './commands/registry';
import { loadPrefs, savePrefs, type Prefs } from './prefs';
import { kvSet, kvDel } from './util/store';
import { toast } from './ui/dialog';
import { canonicalKey } from './util/keys';
import type { Shell } from './ui/shell';

let tabCounter = 0;

export type ViewMode = 'normal' | 'outline' | 'sorter' | 'notes' | 'reading' | 'master';

/** The view mounted for a tab (edit/workspace.ts). */
export interface TabView {
  el: HTMLElement;
  layout(): void;
  invalidate(): void;
  focus(): void;
  destroy(): void;
  /** True while text is being edited in place. */
  readonly editingText: boolean;
  /** Commits in-place text editing. */
  commitText(): void;
  /** Ids of elements selected on the canvas. */
  selection: string[];
  select(ids: string[]): void;
  /** Starts editing an element's text, optionally selecting all of it. */
  editText(id: string, selectAll?: boolean): void;
  /** Element whose text is being edited. */
  readonly editing: string | null;
  setZoom(z: number | 'fit'): void;
  readonly zoom: number;
}

export class DeckTab {
  id = `t${Date.now().toString(36)}${tabCounter++}`;
  title = 'Presentation';
  fileName = '';
  format = 'pptx';
  uri: string | null = null;
  dirty = false;
  created = Date.now();
  saved = 0;
  readOnly = false;
  key = '';
  view: ViewMode = 'normal';
  /** Current slide. */
  current = '';
  /** Layout or master being edited in Master view. */
  masterTarget = '';
  el!: HTMLElement;
  ui!: TabView;
  recovery: any = null;
  /** Slides selected in the thumbnail rail or sorter (current slide included). */
  slideSel: string[] = [];
  /** Position of the current slide when last seen, so deleting it moves to its neighbour. */
  lastIndex = 0;
  constructor(public app: App, public deck: Deck) {
    this.current = deck.slides[0]?.id || '';
  }
  get displayName(): string { return this.fileName || this.title; }
}

export class App {
  prefs: Prefs = loadPrefs();
  docs: DeckTab[] = [];
  active!: DeckTab;
  ui!: Shell;
  recording: { name: string; steps: { id: string; arg?: any }[] } | null = null;
  recordingPaused = false;
  private refreshQueued = false;
  private autosaveTimer: any = null;
  private listeners = new Set<(app: App) => void>();
  lastCommand: { id: string; arg?: any } | null = null;
  /** How many commands are running inside one another (0 when idle). */
  execDepth = 0;
  keyIndex = new Map<string, string>();
  /** Clipboard of slides and elements copied inside Anne's Stage. */
  clip: { kind: 'elements' | 'slides'; data: any; media: Record<string, any>; text: string; time: number } | null = null;
  /** Format Painter: copied formatting, and whether it stays on. */
  painter: { fmt: any; sticky: boolean } | null = null;

  constructor(public host: HTMLElement) {
    this.rebuildKeyIndex();
  }

  get tab(): DeckTab { return this.active; }
  get deck(): Deck { return this.active.deck; }
  /** The current slide (undefined in an empty deck). */
  get slide(): Slide | undefined { return this.deck.slide(this.active.current) || this.deck.slides[0]; }
  /** What the canvas edits: the current slide, or the layout/master in Master view. */
  get owner(): Slide | Layout | Master | undefined {
    const t = this.active;
    if (t.view === 'master') {
      return this.deck.data.layouts.find((l) => l.id === t.masterTarget) || this.deck.data.masters.find((m) => m.id === t.masterTarget) || this.deck.data.masters[0];
    }
    return this.slide;
  }
  /** Selected elements on the canvas. */
  get selected(): Element[] {
    const o = this.owner;
    if (!o || !this.active.ui) return [];
    return this.active.ui.selection.map((id) => this.deck.findElement(o, id)).filter(Boolean) as Element[];
  }

  onRefresh(fn: (app: App) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  savePrefs(): void { savePrefs(this.prefs); this.rebuildKeyIndex(); }

  rebuildKeyIndex(): void {
    this.keyIndex.clear();
    for (const c of allCommands()) for (const k of c.keys || []) this.keyIndex.set(canonicalKey(k), c.id);
    for (const [k, id] of Object.entries(this.prefs.keymap)) {
      if (id) this.keyIndex.set(canonicalKey(k), id); else this.keyIndex.delete(canonicalKey(k));
    }
  }

  // ------------------------------------------------------------------------------------------
  // Presentations

  createTab(deck?: Deck, meta: Partial<DeckTab> = {}): DeckTab {
    if (!deck) {
      deck = Deck.blank(this.prefs.defaultTheme);
      if (this.prefs.defaultSize === 'standard') {
        deck = new Deck(Deck.blankData({ w: 720, h: 540 }, this.prefs.defaultTheme));
        deck.data.slides.push(deck.makeSlide(deck.data.layouts[0].id));
      }
      deck.data.props.author = this.prefs.author;
      deck.data.props.created = Date.now();
    }
    const tab = new DeckTab(this, deck);
    Object.assign(tab, meta);
    this.watchDeck(deck);
    this.ui.mountTab(tab);
    this.docs.push(tab);
    this.activate(tab);
    return tab;
  }

  activate(tab: DeckTab): void {
    this.active = tab;
    for (const d of this.docs) d.el.classList.toggle('ql-hidden-tab', d !== tab);
    this.ui.tabsChanged();
    tab.ui.layout();
    this.refresh();
    document.title = `${tab.displayName}${tab.dirty ? ' •' : ''} – Anne\'s Stage`;
  }

  closeTab(tab: DeckTab): void {
    const i = this.docs.indexOf(tab);
    if (i < 0) return;
    tab.ui.destroy();
    tab.el.remove();
    this.docs.splice(i, 1);
    kvDel('draft:' + tab.id);
    if (!this.docs.length) this.createTab();
    else this.activate(this.docs[Math.max(0, i - 1)]);
  }

  replaceDeck(tab: DeckTab, deck: Deck): void {
    tab.deck = deck;
    this.watchDeck(deck);
    tab.current = deck.slides[0]?.id || '';
    tab.slideSel = [];
    tab.ui.select([]);
    tab.ui.layout();
    this.refresh();
  }

  /** Updates every open tab showing a deck (View ▸ New Window opens a second tab on the same deck). */
  watchDeck(deck: Deck): void {
    deck.onChange = () => { for (const d of this.docs) if (d.deck === deck) this.deckChanged(d); };
  }

  /** Called after every transaction, undo and redo. */
  deckChanged(tab: DeckTab): void {
    // Keep the current slide valid after deletions and undo: stay at the same position.
    const n = tab.deck.slides.length;
    if (!tab.deck.slide(tab.current)) tab.current = tab.deck.slides[Math.max(0, Math.min(n - 1, tab.lastIndex))]?.id || '';
    tab.lastIndex = Math.max(0, tab.deck.slideIndex(tab.current));
    tab.slideSel = tab.slideSel.filter((id) => tab.deck.slide(id));
    if (!tab.dirty) { tab.dirty = true; this.ui.tabsChanged(); document.title = `${tab.displayName} • – Anne\'s Stage`; }
    this.scheduleAutosave();
    tab.ui.invalidate();
    this.refresh();
  }

  /** Makes a slide current and shows it. */
  goToSlide(id: string, opts: { extend?: boolean; toggle?: boolean } = {}): void {
    const t = this.active;
    if (!t.deck.slide(id)) return;
    if (t.ui.editingText) t.ui.commitText();
    if (opts.toggle) t.slideSel = t.slideSel.includes(id) ? t.slideSel.filter((x) => x !== id) : [...t.slideSel, id];
    else if (opts.extend && t.current) {
      const a = t.deck.slideIndex(t.current), b = t.deck.slideIndex(id);
      t.slideSel = t.deck.slides.slice(Math.min(a, b), Math.max(a, b) + 1).map((s) => s.id);
    } else t.slideSel = [id];
    t.current = id;
    t.lastIndex = Math.max(0, t.deck.slideIndex(id));
    t.ui.select([]);
    t.ui.invalidate();
    this.refresh();
  }

  /** Slides the slide commands act on: the selected thumbnails, or the current slide. */
  targetSlides(): Slide[] {
    const t = this.active;
    const ids = t.slideSel.length ? t.slideSel : [t.current];
    return t.deck.slides.filter((s) => ids.includes(s.id));
  }

  refresh(): void {
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    requestAnimationFrame(() => {
      this.refreshQueued = false;
      if (!this.active) return;
      for (const d of this.docs) { const i = d.deck.slideIndex(d.current); if (i >= 0) d.lastIndex = i; }
      this.ui.refresh();
      for (const l of this.listeners) l(this);
    });
  }

  // ------------------------------------------------------------------------------------------
  // Commands

  handleKey(key: string): boolean {
    const id = this.keyIndex.get(canonicalKey(key));
    if (!id) return false;
    const c = getCommand(id);
    if (!c) return false;
    if (c.isEnabled && !c.isEnabled(this)) return false;
    this.exec(id);
    return true;
  }

  isReadOnly(): boolean {
    return this.tab.readOnly || !!this.deck.data.finalMarked;
  }

  exec(id: string, arg?: any): unknown {
    const c = getCommand(id);
    if (!c) { toast(`Unknown command: ${id}`); return false; }
    if (c.edits && this.isReadOnly()) { toast('This presentation is read-only.'); return false; }
    if (c.isEnabled && !c.isEnabled(this)) { toast(`${c.label} is not available here.`); return false; }
    // Only commands the user ran are recorded and repeated, not the ones they run in turn.
    const top = this.execDepth === 0;
    if (top && this.recording && !c.noRecord && id !== 'dev.recordMacro' && id !== 'dev.stopRecording') this.recordStep(id, arg);
    if (top && !c.noRecord && id !== 'edit.repeat') this.lastCommand = { id, arg };
    this.execDepth++;
    try {
      const r = c.run(this, arg);
      if (r instanceof Promise) r.catch((e) => this.reportError(c, e)).finally(() => this.refresh());
      this.refresh();
      return r;
    } catch (e) {
      this.reportError(c, e);
      return false;
    } finally {
      this.execDepth--;
    }
  }

  private reportError(c: Command, e: unknown): void {
    console.error(e);
    toast(`${c.label}: ${(e as any)?.message || e}`);
  }

  recordStep(id: string, arg?: any): void {
    if (!this.recording || this.recordingPaused) return;
    this.recording.steps.push(arg === undefined ? { id } : { id, arg: JSON.parse(JSON.stringify(arg)) });
  }

  // ------------------------------------------------------------------------------------------
  // Autosave and drafts

  scheduleAutosave(): void {
    if (!this.prefs.autosave || this.autosaveTimer) return;
    this.autosaveTimer = setTimeout(() => { this.autosaveTimer = null; void this.saveDrafts(); }, Math.max(3, this.prefs.autosaveSeconds) * 1000);
  }

  async saveDrafts(): Promise<boolean> {
    let saved = 0;
    const failed: string[] = [];
    for (const tab of this.docs) {
      if (!tab.dirty) continue;
      try {
        await kvSet('draft:' + tab.id, { id: tab.id, json: tab.deck.toJSON(), title: tab.title, fileName: tab.fileName, format: tab.format, uri: tab.uri, key: tab.key, time: Date.now() });
        saved++;
      } catch (e) {
        console.warn(e);
        failed.push(tab.displayName);
      }
    }
    if (failed.length) {
      this.ui.status?.('Draft not saved');
      toast(`AutoSave could not store a draft of ${failed.join(', ')} (storage may be full). Save the presentation to keep your changes.`, { ms: 9000 });
      return false;
    }
    if (saved) this.ui.status?.('Draft saved');
    return true;
  }

  followLink(href: string): void {
    if (!isSafeExternalUrl(href)) { toast(`Blocked a link with an unsupported or unsafe address: ${href.slice(0, 60)}`); return; }
    import('./platform/native').then(({ openExternal }) => openExternal(href));
  }

  focus(): void { this.active?.ui.focus(); }
}
