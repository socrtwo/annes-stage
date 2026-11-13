/** Application shell: title bar, Quick Access Bar, tabs + ribbon, document tabs, workspace, panes, status bar. */
import type { App, DeckTab } from '../app';
import type { Element } from '../model/types';
import { getCommand, allCommands, searchCommands, type Command, type MenuEntry } from '../commands/registry';
import { h, icon, clear, isPhone } from './dom';
import { showMenu, closeMenus, openDialog, toast } from './dialog';
import { DEFAULT_TABS, tabsFor, type RibbonTab } from './ribbonLayout';
import { prettyKey, canonicalKey, keyName } from '../util/keys';
import { PANES, type PaneDef } from './panes';
import { customizeQat, customizeRibbon, customizeKeyboard } from './customize';
import { renderBackstage } from './backstage';
import { Workspace } from '../edit/workspace';
import { FONT_LIST } from '../fonts';
import { currentRun } from '../edit/ops';
import { themeFont } from '../model/theme';
import { QAT_STANDARD, QAT_EXTRAS } from '../prefs';

export class Shell {
  root: HTMLElement;
  titlebar!: HTMLElement;
  qatEl!: HTMLElement;
  qatBelow!: HTMLElement;
  qatBottom!: HTMLElement;
  tabsEl!: HTMLElement;
  ribbonEl!: HTMLElement;
  docTabsEl!: HTMLElement;
  workspace!: HTMLElement;
  paneEl!: HTMLElement;
  statusEl!: HTMLElement;
  backstageEl!: HTMLElement;
  titleBtn!: HTMLElement;
  currentTab = 'home';
  ribbonOpen = true;
  pane: { def: PaneDef; el: HTMLElement; opts: any } | null = null;
  statusMsg = '';
  private statusTimer: any;
  private lastContextual = '';

  constructor(public app: App) {
    this.root = app.host;
    this.build();
    this.applyPrefs();
    document.addEventListener('keydown', (e) => this.globalKey(e), true);
  }

  // ----------------------------------------------------------------------------------------
  // Layout

  build(): void {
    clear(this.root);
    this.root.className = 'ql-app';
    this.titlebar = h('header', { class: 'ql-titlebar' });
    const fileBtn = h('button', { class: 'ql-iconbtn ql-filebtn', title: 'File', 'aria-label': 'File menu', onclick: () => this.showBackstage() }, icon('menu'));
    this.qatEl = h('div', { class: 'ql-qat', role: 'toolbar', 'aria-label': 'Quick Access Bar' });
    this.titleBtn = h('button', { class: 'ql-title', title: 'Rename / presentation info', onclick: () => this.renameDoc() }, 'Presentation');
    const search = h('button', { class: 'ql-iconbtn', title: 'Search commands (Alt+Q)', 'aria-label': 'Search commands', onclick: () => this.commandPalette() }, icon('search'));
    const present = h('button', { class: 'ql-btn ql-present', title: 'Present from Current Slide (Shift+F5)', onclick: () => this.app.exec('show.fromCurrent') }, icon('slideshow'), h('span', { class: 'ql-present-label' }, ' Present'));
    const more = h('button', { class: 'ql-iconbtn', title: 'More', 'aria-label': 'More', onclick: (e: MouseEvent) => this.moreMenu(e.currentTarget as HTMLElement) }, icon('more_vert'));
    this.titlebar.append(fileBtn, this.qatEl, this.titleBtn, h('span', { class: 'ql-spacer' }), search, present, more);
    this.tabsEl = h('nav', { class: 'ql-tabs', role: 'tablist' });
    this.ribbonEl = h('div', { class: 'ql-ribbon', role: 'toolbar' });
    this.qatBelow = h('div', { class: 'ql-qat ql-qat-below', role: 'toolbar', 'aria-label': 'Quick Access Bar' });
    this.docTabsEl = h('div', { class: 'ql-doctabs' });
    this.workspace = h('div', { class: 'ql-workspace' });
    this.paneEl = h('aside', { class: 'ql-pane', 'aria-hidden': 'true' });
    const main = h('main', { class: 'ql-main' }, this.workspace, this.paneEl);
    this.qatBottom = h('div', { class: 'ql-qat ql-qat-bottom', role: 'toolbar', 'aria-label': 'Quick Access Bar' });
    this.statusEl = h('footer', { class: 'ql-status' });
    this.backstageEl = h('div', { class: 'ql-backstage', 'aria-hidden': 'true' });
    this.root.append(this.titlebar, this.tabsEl, this.ribbonEl, this.qatBelow, this.docTabsEl, main, this.qatBottom, this.statusEl, this.backstageEl, h('div', { class: 'ql-toasts' }));
    this.renderQat();
    this.renderTabs();
    this.renderRibbon();
  }

  rebuild(): void {
    this.renderQat();
    this.renderTabs();
    this.renderRibbon();
    this.refresh();
  }

  mountTab(tab: DeckTab): void {
    const ws = new Workspace(this.app, tab);
    tab.ui = ws;
    tab.el = h('div', { class: 'qs-doc' }, ws.el);
    this.workspace.appendChild(tab.el);
    ws.canvas.onSelect = () => this.contextualCheck();
    requestAnimationFrame(() => ws.layout());
  }

  // ----------------------------------------------------------------------------------------
  // Quick Access Bar

  renderQat(): void {
    const pos = this.app.prefs.qatPosition;
    const target = pos === 'bottom' ? this.qatBottom : pos === 'below' ? this.qatBelow : this.qatEl;
    clear(this.qatEl); clear(this.qatBottom); clear(this.qatBelow);
    for (const id of this.app.prefs.qat) {
      if (id === '|') { target.appendChild(h('span', { class: 'ql-qat-sep' })); continue; }
      const c = getCommand(id);
      if (!c) continue;
      target.appendChild(this.commandButton(c, 'qat'));
    }
    target.appendChild(h('button', { class: 'ql-iconbtn ql-qat-customize', title: 'Customize Quick Access Bar', 'aria-label': 'Customize Quick Access Bar', onclick: (e: MouseEvent) => this.qatMenu(e.currentTarget as HTMLElement) }, icon('arrow_drop_down')));
  }

  qatMenu(anchor: HTMLElement): void {
    const q = this.app.prefs.qat;
    const item = (id: string) => ({ id, label: getCommand(id)?.label || id, checked: q.includes(id), arg: '__toggle' });
    const present = (id: string) => !!getCommand(id);
    const pos = this.app.prefs.qatPosition;
    showMenu([
      { heading: 'Customize Quick Access Bar' },
      ...QAT_STANDARD.filter(present).map(item),
      { separator: true },
      ...QAT_EXTRAS.filter(present).map(item),
      { separator: true },
      { id: '__addAll', label: 'Add All Choices (Save, Print, then A–Z)', icon: 'sort_by_alpha' },
      { id: '__more', label: 'More Commands…', icon: 'library_add' },
      ...(pos !== 'top' ? [{ id: '__pos', arg: 'top', label: 'Show Above the Ribbon', icon: 'vertical_align_top' }] : []),
      ...(pos !== 'below' ? [{ id: '__pos', arg: 'below', label: 'Show Below the Ribbon', icon: 'vertical_align_center' }] : []),
      ...(pos !== 'bottom' ? [{ id: '__pos', arg: 'bottom', label: 'Show at the Bottom (near keyboard)', icon: 'vertical_align_bottom' }] : []),
      { id: '__labels', label: this.app.prefs.qatLabels ? 'Hide Command Labels' : 'Show Command Labels', icon: 'label' },
      { id: '__hide', label: 'Hide Quick Access Bar', icon: 'visibility_off' },
      { id: '__ribbon', label: this.app.prefs.ribbon === 'full' ? 'Collapse the Ribbon' : 'Show the Ribbon', icon: 'expand_less' },
    ], {
      anchor, onPick: (e) => {
        const p = this.app.prefs;
        if (e.arg === '__toggle' && e.id) { p.qat = q.includes(e.id) ? q.filter((x) => x !== e.id) : [...q, e.id]; }
        else if (e.id === '__addAll') { this.app.exec('view.qatAddAll'); return; }
        else if (e.id === '__more') { this.customizeQat(); return; }
        else if (e.id === '__pos') { this.app.exec('view.qatPosition', e.arg); return; }
        else if (e.id === '__labels') p.qatLabels = !p.qatLabels;
        else if (e.id === '__hide') { p.qatHidden = true; toast('Quick Access Bar hidden. Show it again from View ▸ Show Quick Access Bar or by long-pressing any ribbon command.', { ms: 5000 }); }
        else if (e.id === '__ribbon') p.ribbon = p.ribbon === 'full' ? 'tabs' : 'full';
        this.app.savePrefs();
        this.applyPrefs();
        this.renderQat();
        this.refresh();
      },
    });
  }

  // ----------------------------------------------------------------------------------------
  // Tabs and ribbon

  renderTabs(): void {
    clear(this.tabsEl);
    this.tabsEl.appendChild(h('button', { class: 'ql-tab ql-tab-file', role: 'tab', onclick: () => this.showBackstage() }, 'File'));
    for (const t of tabsFor(this.app)) {
      const b = h('button', { class: 'ql-tab' + (t.contextual ? ' ql-contextual' : '') + (t.id === this.currentTab ? ' ql-active' : ''), role: 'tab', 'data-tab': t.id, style: t.accent ? `--tab-accent:${t.accent}` : '' }, t.label);
      b.addEventListener('click', () => {
        if (this.currentTab === t.id && this.app.prefs.ribbon !== 'hidden') { this.ribbonOpen = !this.ribbonOpen; this.root.classList.toggle('ql-ribbon-closed', !this.ribbonOpen); return; }
        this.currentTab = t.id; this.ribbonOpen = true; this.root.classList.remove('ql-ribbon-closed');
        this.renderTabs(); this.renderRibbon(); this.refresh();
        b.scrollIntoView({ inline: 'nearest', block: 'nearest' });
      });
      b.addEventListener('dblclick', () => { this.app.exec('view.collapseRibbon'); });
      this.tabsEl.appendChild(b);
    }
  }

  ribbonTab(): RibbonTab {
    return tabsFor(this.app).find((t) => t.id === this.currentTab) || DEFAULT_TABS[0];
  }

  renderRibbon(): void {
    clear(this.ribbonEl);
    const tab = this.ribbonTab();
    for (const g of tab.groups) {
      const items = h('div', { class: 'ql-group-items' });
      for (const id of g.items) {
        const c = getCommand(id);
        if (!c) continue;
        items.appendChild(this.ribbonItem(c));
      }
      if (!items.children.length) continue;
      const label = h('div', { class: 'ql-group-label' }, g.label, g.launcher ? h('button', { class: 'ql-launcher', title: `${g.label} settings`, 'aria-label': `${g.label} settings`, onclick: () => this.app.exec(g.launcher!) }, icon('open_in_new')) : null);
      this.ribbonEl.appendChild(h('section', { class: 'ql-group', 'data-group': g.id }, items, label));
    }
    this.ribbonEl.scrollLeft = 0;
  }

  ribbonItem(c: Command): HTMLElement {
    switch (c.kind) {
      case 'font': return this.fontBox(c);
      case 'size': return this.sizeBox(c);
      case 'gallery': return this.gallery(c);
      case 'combo': return this.comboBox(c);
      default: return this.commandButton(c, 'ribbon');
    }
  }

  commandButton(c: Command, where: 'ribbon' | 'qat' | 'mini'): HTMLElement {
    const showLabel = where === 'ribbon' || (where === 'qat' && this.app.prefs.qatLabels);
    const key = c.keys?.[0] ? ` (${prettyKey(c.keys[0])})` : '';
    const main = h('button', { class: 'ql-cmd', 'data-cmd': c.id, title: (c.tip ? `${c.label}: ${c.tip}` : c.label) + key, 'aria-label': c.label, type: 'button' }, icon(c.icon), showLabel ? h('span', { class: 'ql-cmd-label' }, c.label.replace(/…$/, '')) : null);
    if (c.kind === 'color') main.appendChild(h('span', { class: 'ql-colorbar' }));
    let longPress: any;
    main.addEventListener('pointerdown', () => { longPress = setTimeout(() => { longPress = 'fired'; this.longPress(c, main); }, 550); });
    main.addEventListener('pointerup', () => { if (longPress !== 'fired') clearTimeout(longPress); });
    main.addEventListener('pointerleave', () => { if (longPress !== 'fired') clearTimeout(longPress); });
    main.addEventListener('contextmenu', (e) => { e.preventDefault(); this.longPress(c, main); });
    main.addEventListener('click', () => {
      if (longPress === 'fired') { longPress = null; return; }
      if (c.kind === 'menu') { this.openCommandMenu(c, main); return; }
      this.app.exec(c.id);
      if (where !== 'qat' && !['menu', 'split', 'color'].includes(c.kind || '')) setTimeout(() => this.app.focus(), 0);
    });
    main.addEventListener('mousedown', (e) => e.preventDefault());
    if (c.kind === 'menu') main.appendChild(icon('arrow_drop_down', 'ql-caret'));
    if (c.kind === 'split' || c.kind === 'color') {
      const arrow = h('button', { class: 'ql-split-arrow', type: 'button', title: `${c.label} options`, 'aria-label': `${c.label} options` }, icon('arrow_drop_down'));
      arrow.addEventListener('mousedown', (e) => e.preventDefault());
      arrow.addEventListener('click', () => (c.kind === 'color' ? this.app.exec(c.id, 'menu') : this.openCommandMenu(c, wrap)));
      const wrap = h('span', { class: 'ql-split', 'data-cmd-wrap': c.id }, main, arrow);
      return wrap;
    }
    return main;
  }

  longPress(c: Command, el: HTMLElement): void {
    const inQat = this.app.prefs.qat.includes(c.id);
    showMenu([
      { id: '__qat', label: inQat ? 'Remove from Quick Access Bar' : 'Add to Quick Access Bar', icon: inQat ? 'remove_circle' : 'add_circle' },
      { id: '__customizeQat', label: 'Customize Quick Access Bar…', icon: 'tune' },
      ...(this.app.prefs.qatHidden ? [{ id: '__showQat', label: 'Show Quick Access Bar', icon: 'bolt' }] : []),
      ...(c.id === 'edit.formatPainter' ? [{ id: '__sticky', label: 'Keep Format Painter On', icon: 'format_paint' }] : []),
      { id: '__key', label: 'Assign Shortcut…', icon: 'keyboard' },
      { id: '__ribbon', label: this.app.prefs.ribbon === 'full' ? 'Collapse the Ribbon' : 'Show the Ribbon', icon: 'expand_less' },
      { id: '__info', label: `About: ${c.label}`, icon: 'info' },
    ], {
      anchor: el, onPick: (e) => {
        if (e.id === '__qat') { this.app.prefs.qat = inQat ? this.app.prefs.qat.filter((x) => x !== c.id) : [...this.app.prefs.qat, c.id]; this.app.savePrefs(); this.renderQat(); this.refresh(); toast(inQat ? 'Removed from Quick Access Bar' : 'Added to Quick Access Bar'); }
        if (e.id === '__customizeQat') this.customizeQat();
        if (e.id === '__showQat') this.app.exec('view.qatShow');
        if (e.id === '__sticky') this.app.exec('edit.formatPainter', 'sticky');
        if (e.id === '__key') this.customizeKeyboard(c.id);
        if (e.id === '__ribbon') this.app.exec('view.collapseRibbon');
        if (e.id === '__info') toast(`${c.label} — ${c.tab}${c.group ? ' ▸ ' + c.group : ''}${c.keys?.length ? ' — ' + c.keys.map(prettyKey).join(', ') : ''}${c.origin ? ' — inspired by ' + c.origin : ''}`, { ms: 5000 });
      },
    });
  }

  openCommandMenu(c: Command, anchor: HTMLElement): void {
    const entries = c.menu ? c.menu(this.app) : [];
    showMenu(entries, { anchor, onPick: (e) => this.pickEntry(c, e) });
  }

  pickEntry(c: Command, e: MenuEntry): void {
    if (!e.id) return;
    if (e.id === c.id) this.app.exec(c.id, e.arg);
    else this.app.exec(e.id, e.arg);
    setTimeout(() => this.app.focus(), 0);
  }

  fontBox(c: Command): HTMLElement {
    const b = h('button', { class: 'ql-combo ql-fontbox', 'data-cmd': c.id, 'data-combo': 'font', title: 'Font', type: 'button' }, h('span', { class: 'ql-combo-text' }, 'Font'), icon('arrow_drop_down'));
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => {
      const theme = this.app.deck.themeOf(this.app.owner || this.app.deck.data.masters[0]);
      const entries: MenuEntry[] = [
        { heading: 'Theme Fonts' }, { arg: '+mj-lt', label: `${theme.fonts.major} (Headings)`, preview: `font-family:"${theme.fonts.major}"` }, { arg: '+mn-lt', label: `${theme.fonts.minor} (Body)`, preview: `font-family:"${theme.fonts.minor}"` },
        { heading: 'All Fonts' }, ...FONT_LIST.map((f) => ({ arg: f, label: f, preview: `font-family:"${f}"` })),
      ];
      const input = h('input', { class: 'ql-menu-search', placeholder: 'Search fonts or type a name…' }) as HTMLInputElement;
      const m = showMenu(entries, { anchor: b, onPick: (e) => { this.app.exec('fmt.font', e.arg); this.app.focus(); }, className: 'ql-font-menu' });
      m.prepend(input);
      input.addEventListener('input', () => {
        const q = input.value.toLowerCase();
        m.querySelectorAll<HTMLElement>('.ql-menu-item').forEach((it) => { it.style.display = it.textContent!.toLowerCase().includes(q) ? '' : 'none'; });
      });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && input.value) { closeMenus(); this.app.exec('fmt.font', input.value); this.app.focus(); } });
      setTimeout(() => { if (!isPhone()) input.focus(); }, 20);
    });
    return b;
  }

  sizeBox(c: Command): HTMLElement {
    const wrap = h('span', { class: 'ql-sizebox', 'data-cmd-wrap': c.id });
    const input = h('input', { class: 'ql-size-input', 'data-combo': c.id, inputmode: 'decimal', 'aria-label': c.label, title: c.label }) as HTMLInputElement;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); const val = parseFloat(input.value); if (!isNaN(val)) this.app.exec(c.id, val); this.app.focus(); }
      if (e.key === 'Escape') this.app.focus();
    });
    const arrow = h('button', { class: 'ql-split-arrow', type: 'button', 'aria-label': `${c.label} list` }, icon('arrow_drop_down'));
    arrow.addEventListener('mousedown', (e) => e.preventDefault());
    arrow.addEventListener('click', () => { if (c.menu) this.openCommandMenu(c, wrap); else this.app.exec(c.id); });
    wrap.append(input, arrow);
    return wrap;
  }

  comboBox(c: Command): HTMLElement {
    const b = h('button', { class: 'ql-combo ql-wide-combo', 'data-cmd': c.id, 'data-combo': c.id, title: c.label, type: 'button' }, h('span', { class: 'ql-combo-text' }, c.label), icon('arrow_drop_down'));
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => this.openCommandMenu(c, b));
    return b;
  }

  gallery(c: Command): HTMLElement {
    const wrap = h('div', { class: 'ql-gallery', 'data-gallery': c.id });
    const strip = h('div', { class: 'ql-gallery-strip' });
    const more = h('button', { class: 'ql-gallery-more', title: 'More', 'aria-label': `More ${c.label}` }, icon('expand_more'));
    more.addEventListener('mousedown', (e) => e.preventDefault());
    more.addEventListener('click', () => this.openCommandMenu(c, wrap));
    wrap.append(strip, more);
    return wrap;
  }

  fillGalleries(): void {
    this.ribbonEl.querySelectorAll<HTMLElement>('[data-gallery]').forEach((wrap) => {
      const id = wrap.dataset.gallery!;
      const c = getCommand(id);
      if (!c?.menu) return;
      const strip = wrap.querySelector('.ql-gallery-strip')!;
      const entries = c.menu(this.app).filter((e) => !e.heading && !e.separator).slice(0, 14);
      const sig = JSON.stringify(entries.map((e) => [e.label, e.checked, e.preview, e.swatch]));
      if (strip.getAttribute('data-sig') === sig) return;
      strip.setAttribute('data-sig', sig);
      clear(strip as HTMLElement);
      for (const e of entries) {
        const chip = h('button', { class: 'ql-gallery-item' + (e.checked ? ' ql-on' : ''), title: e.label || '', type: 'button' }, e.icon ? icon(e.icon) : null, h('span', { style: e.preview || '' }, e.label || ''));
        chip.addEventListener('mousedown', (ev) => ev.preventDefault());
        chip.addEventListener('click', () => { this.app.exec(e.id || id, e.arg); this.app.focus(); });
        strip.appendChild(chip);
      }
    });
  }

  // ----------------------------------------------------------------------------------------
  // Refresh (state → UI)

  private contextualCheck(): void {
    const sig = DEFAULT_TABS.filter((t) => t.contextual).map((t) => { try { return t.contextual!(this.app) ? 1 : 0; } catch { return 0; } }).join('');
    if (sig !== this.lastContextual) { this.lastContextual = sig; this.refresh(); }
  }

  refresh(): void {
    const app = this.app;
    if (!app.active) return;
    let firstContextual = '';
    for (const t of DEFAULT_TABS.filter((x) => x.contextual)) {
      const el = this.tabsEl.querySelector<HTMLElement>(`[data-tab="${t.id}"]`);
      let show = false;
      try { show = t.contextual!(app); } catch { /* */ }
      if (el) el.style.display = show ? '' : 'none';
      if (show && !firstContextual) firstContextual = t.id;
      if (!show && this.currentTab === t.id) { this.currentTab = 'home'; this.renderTabs(); this.renderRibbon(); }
    }
    for (const b of this.root.querySelectorAll<HTMLElement>('[data-cmd]')) {
      const c = getCommand(b.dataset.cmd!);
      if (!c) continue;
      let active = false, enabled = true;
      try { active = !!c.isActive?.(app); enabled = c.isEnabled ? c.isEnabled(app) : true; } catch { /* */ }
      b.classList.toggle('ql-on', active);
      b.setAttribute('aria-pressed', String(active));
      b.classList.toggle('ql-disabled', !enabled);
    }
    const run = currentRun(app);
    const theme = app.deck.themeOf(app.owner || app.deck.data.masters[0]);
    const fontEl = this.ribbonEl.querySelector<HTMLElement>('[data-combo=font] .ql-combo-text');
    if (fontEl) { const f = themeFont(run.font, theme) || (app.selected.length ? theme.fonts.minor : ''); fontEl.textContent = f || 'Font'; fontEl.style.fontFamily = f ? `"${f}"` : ''; }
    this.root.querySelectorAll<HTMLInputElement>('input[data-combo]').forEach((inp) => {
      if (document.activeElement === inp) return;
      const c = getCommand(inp.dataset.combo!);
      const v = c?.value?.(app);
      inp.value = v != null ? String(v) : '';
    });
    this.root.querySelectorAll<HTMLElement>('button[data-combo]').forEach((b) => {
      const c = getCommand(b.dataset.combo!);
      const v = c?.value?.(app);
      const t = b.querySelector('.ql-combo-text');
      if (t && v != null) t.textContent = String(v);
    });
    this.fillGalleries();
    this.renderStatus();
    if (this.pane?.def.update) this.pane.def.update(app, this.pane.el, this.pane.opts);
    this.titleBtn.textContent = app.tab.displayName + (app.tab.dirty ? ' •' : '');
    void firstContextual;
  }

  // ----------------------------------------------------------------------------------------
  // Status bar

  renderStatus(): void {
    const app = this.app;
    const tab = app.tab;
    const d = tab.deck;
    clear(this.statusEl);
    const item = (text: string, onclick?: () => void, title?: string, cls = '') => h('button', { class: 'ql-status-item ' + cls, onclick, title: title || text, type: 'button' }, text);
    const i = d.slideIndex(tab.current);
    if (tab.view === 'master') this.statusEl.appendChild(h('span', { class: 'ql-status-mode' }, 'Slide Master'));
    else this.statusEl.appendChild(item(d.slides.length ? `Slide ${i + 1} of ${d.slides.length}` : 'No slides', () => app.exec('slide.goTo'), 'Go to slide…'));
    if (tab.view !== 'master' && d.slides.length) {
      const s = d.slides[i];
      if (s?.hidden) this.statusEl.appendChild(h('span', { class: 'ql-status-msg' }, 'Hidden'));
      const sec = s && d.sectionOf(s.id);
      if (sec) this.statusEl.appendChild(h('span', { class: 'ql-status-msg' }, sec.name));
    }
    if (app.recording) this.statusEl.appendChild(item(app.recordingPaused ? '⏸ Paused' : '● REC', () => app.exec('dev.stopRecording'), 'Stop recording macro', 'ql-status-rec'));
    if (d.data.finalMarked) this.statusEl.appendChild(item('Marked as Final', () => app.exec('file.markFinal'), 'Marked as final'));
    if (tab.readOnly) this.statusEl.appendChild(h('span', { class: 'ql-status-msg' }, 'Read-only'));
    if (this.statusMsg) this.statusEl.appendChild(h('span', { class: 'ql-status-msg' }, this.statusMsg));
    this.statusEl.appendChild(h('span', { class: 'ql-spacer' }));
    this.statusEl.appendChild(h('button', { class: 'ql-iconbtn ql-status-view' + (app.prefs.showNotes ? ' ql-on' : ''), title: 'Notes', 'aria-label': 'Notes', onclick: () => app.exec('view.notes') }, icon('notes')));
    this.statusEl.appendChild(h('button', { class: 'ql-iconbtn ql-status-view' + (this.paneOpen('comments') ? ' ql-on' : ''), title: 'Comments', 'aria-label': 'Comments', onclick: () => app.exec('review.commentsPane') }, icon('comment')));
    const views: [string, string, string, string][] = [['normal', 'view.normal', 'view_sidebar', 'Normal'], ['sorter', 'view.slideSorter', 'grid_view', 'Slide Sorter'], ['reading', 'view.reading', 'menu_book', 'Reading View']];
    for (const [m, id, ic, l] of views) this.statusEl.appendChild(h('button', { class: 'ql-iconbtn ql-status-view' + (tab.view === m ? ' ql-on' : ''), title: l, 'aria-label': l, onclick: () => app.exec(id) }, icon(ic)));
    this.statusEl.appendChild(h('button', { class: 'ql-iconbtn ql-status-view', title: 'Slide Show (Shift+F5)', 'aria-label': 'Slide Show', onclick: () => app.exec('show.fromCurrent') }, icon('slideshow')));
    const z = tab.ui?.zoom || 1;
    const slider = h('input', { type: 'range', class: 'ql-zoom-slider', min: '10', max: '400', step: '5', value: String(Math.round(z * 100)), 'aria-label': 'Zoom' }) as HTMLInputElement;
    slider.addEventListener('input', () => tab.ui.setZoom(+slider.value / 100));
    this.statusEl.append(h('button', { class: 'ql-iconbtn', title: 'Zoom out', 'aria-label': 'Zoom out', onclick: () => app.exec('view.zoomOut') }, icon('remove')), slider,
      h('button', { class: 'ql-iconbtn', title: 'Zoom in', 'aria-label': 'Zoom in', onclick: () => app.exec('view.zoomIn') }, icon('add')),
      h('button', { class: 'ql-status-item ql-zoom', title: 'Zoom…', onclick: () => app.exec('view.zoom') }, `${Math.round(z * 100)}%`),
      h('button', { class: 'ql-iconbtn', title: 'Fit Slide to Current Window', 'aria-label': 'Fit slide to window', onclick: () => app.exec('view.fit') }, icon('fit_screen')));
  }

  status(msg: string): void {
    this.statusMsg = msg;
    clearTimeout(this.statusTimer);
    if (msg && !msg.startsWith('●')) this.statusTimer = setTimeout(() => { this.statusMsg = ''; this.renderStatus(); }, 3000);
    this.renderStatus();
  }

  // ----------------------------------------------------------------------------------------
  // Document tabs strip and title

  tabsChanged(): void {
    const app = this.app;
    clear(this.docTabsEl);
    this.root.classList.toggle('ql-multi-doc', app.docs.length > 1);
    for (const d of app.docs) {
      const t = h('div', { class: 'ql-doctab' + (d === app.active ? ' ql-active' : ''), role: 'tab' },
        h('button', { class: 'ql-doctab-name', onclick: () => app.activate(d) }, d.displayName + (d.dirty ? ' •' : '')),
        h('button', { class: 'ql-doctab-close', 'aria-label': `Close ${d.displayName}`, onclick: () => { app.activate(d); app.exec('file.close', d.id); } }, icon('close')));
      this.docTabsEl.appendChild(t);
    }
    this.docTabsEl.appendChild(h('button', { class: 'ql-iconbtn', title: 'New presentation', 'aria-label': 'New presentation', onclick: () => app.exec('file.new') }, icon('add')));
    if (app.active) this.titleBtn.textContent = app.active.displayName + (app.active.dirty ? ' •' : '');
  }

  async renameDoc(): Promise<void> {
    const tab = this.app.tab;
    const r = await openDialog({ title: 'Presentation', fields: [{ key: 'name', label: 'File name', type: 'text', value: tab.fileName || tab.title }, { key: 'title', label: 'Title property', type: 'text', value: this.app.deck.data.props.title || '' }] });
    if (!r) return;
    const deck = this.app.deck;
    const name = String(r.name || '').trim() || tab.fileName || tab.title;
    if (name !== (tab.fileName || tab.title)) {
      tab.fileName = name; tab.title = name.replace(/\.[^.]+$/, '');
      // The new name is kept by the next save and the next draft.
      tab.dirty = true;
      this.app.scheduleAutosave();
    }
    if ((r.title || '') !== (deck.data.props.title || '')) {
      if (this.app.isReadOnly()) toast('This presentation is read-only: its title property was not changed.');
      else deck.transact('Title', () => { deck.data.props.title = r.title; });
    }
    this.tabsChanged();
    document.title = `${tab.displayName}${tab.dirty ? ' •' : ''} – Anne\'s Stage`;
  }

  moreMenu(anchor: HTMLElement): void {
    const app = this.app;
    showMenu([
      { id: 'file.save', label: 'Save', icon: 'save' }, { id: 'file.share', label: 'Share', icon: 'share' }, { id: 'file.print', label: 'Print / PDF', icon: 'print' },
      { separator: true },
      { id: 'show.fromStart', label: 'Present from Beginning', icon: 'play_arrow' }, { id: 'show.presenterView', label: 'Presenter View', icon: 'co_present' },
      { separator: true },
      { id: 'view.navigator', label: 'Navigator', icon: 'list_alt' }, { id: 'review.commentsPane', label: 'Comments', icon: 'forum' }, { id: 'edit.find', label: 'Find & Replace', icon: 'search' },
      { separator: true },
      { id: 'file.customizeQat', label: 'Customize Quick Access Bar…', icon: 'tune' }, { id: 'file.customizeRibbon', label: 'Customize Tabs…', icon: 'view_quilt' },
      { id: 'file.customizeKeyboard', label: 'Customize Keyboard…', icon: 'keyboard' }, { id: 'file.options', label: 'Options…', icon: 'settings' },
      { id: 'help.about', label: 'About', icon: 'info' },
    ], { anchor, onPick: (e) => e.id && app.exec(e.id, e.arg) });
  }

  // ----------------------------------------------------------------------------------------
  // Panes

  openPane(id: string, opts: any = {}): void {
    const def = PANES[id];
    if (!def) { toast(`Unknown pane ${id}`); return; }
    if (this.pane?.def.id === id) { this.pane.opts = opts; def.update?.(this.app, this.pane.el, opts); def.onOpen?.(this.app, this.pane.el, opts); return; }
    this.closePane();
    const body = h('div', { class: 'ql-pane-body' });
    const head = h('div', { class: 'ql-pane-head' }, h('h2', null, def.title), h('button', { class: 'ql-iconbtn', 'aria-label': 'Close pane', onclick: () => this.closePane() }, icon('close')));
    clear(this.paneEl);
    this.paneEl.append(head, body);
    this.paneEl.setAttribute('aria-hidden', 'false');
    this.root.classList.add('ql-pane-open');
    this.pane = { def, el: body, opts };
    def.render(this.app, body, opts);
    def.onOpen?.(this.app, body, opts);
    this.refresh();
    requestAnimationFrame(() => this.app.tab.ui.layout());
  }

  closePane(): void {
    if (!this.pane) return;
    this.pane.def.onClose?.(this.app);
    this.pane = null;
    clear(this.paneEl);
    this.paneEl.setAttribute('aria-hidden', 'true');
    this.root.classList.remove('ql-pane-open');
    this.app.refresh();
    requestAnimationFrame(() => this.app.tab?.ui.layout());
  }

  togglePane(id: string, opts?: any): void { if (this.pane?.def.id === id) this.closePane(); else this.openPane(id, opts); }
  paneOpen(id: string): boolean { return this.pane?.def.id === id; }

  // ----------------------------------------------------------------------------------------
  // Backstage

  showBackstage(page = 'home'): void {
    closeMenus();
    if (this.app.tab?.ui.editingText) this.app.tab.ui.commitText();
    this.backstageEl.setAttribute('aria-hidden', 'false');
    this.root.classList.add('ql-backstage-open');
    renderBackstage(this.app, this.backstageEl, page);
  }
  hideBackstage(): void {
    this.backstageEl.setAttribute('aria-hidden', 'true');
    this.root.classList.remove('ql-backstage-open');
    clear(this.backstageEl);
  }

  customizeQat(): void { customizeQat(this.app); }
  customizeRibbon(): void { customizeRibbon(this.app); }
  customizeKeyboard(id?: string): void { customizeKeyboard(this.app, id); }

  // ----------------------------------------------------------------------------------------
  // Command palette

  commandPalette(): void {
    const app = this.app;
    const overlay = h('div', { class: 'ql-overlay ql-palette-overlay' });
    const input = h('input', { class: 'ql-palette-input', placeholder: `Search ${allCommands().length} commands… (e.g. "morph", "outline", "presenter")`, 'aria-label': 'Search commands' }) as HTMLInputElement;
    const list = h('div', { class: 'ql-palette-list', role: 'listbox' });
    const box = h('div', { class: 'ql-palette', role: 'dialog' }, input, list);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    let results: Command[] = [];
    let sel = 0;
    // Escape closes the palette wherever focus is (a pin button, the list, the page).
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape' && overlay.isConnected && !document.querySelector('.ql-menu')) { e.preventDefault(); e.stopPropagation(); close(); } };
    const close = () => { document.removeEventListener('keydown', onEsc, true); overlay.remove(); app.focus(); };
    document.addEventListener('keydown', onEsc, true);
    const run = (c: Command) => { close(); if (c.kind === 'menu' && c.menu) this.openCommandMenu(c, this.anchorFor(c.id)); else app.exec(c.id); };
    const draw = () => {
      clear(list);
      const q = input.value.trim();
      results = q ? searchCommands(q, 80) : [...app.prefs.pinnedCommands.map((id) => getCommand(id)!).filter(Boolean), ...allCommands().filter((c) => c.popular).slice(0, 40)];
      results.forEach((c, i) => {
        const pinned = app.prefs.qat.includes(c.id);
        const row = h('div', { class: 'ql-palette-row' + (i === sel ? ' ql-sel' : ''), role: 'option' },
          icon(c.icon), h('span', { class: 'ql-palette-label' }, c.label), h('span', { class: 'ql-palette-tab' }, `${c.tab === 'Backstage' ? 'File' : c.tab}${c.group ? ' ▸ ' + c.group : ''}`),
          c.keys?.[0] ? h('kbd', null, prettyKey(c.keys[0])) : null,
          h('button', { class: 'ql-iconbtn ql-palette-pin', title: pinned ? 'Remove from Quick Access Bar' : 'Add to Quick Access Bar', onclick: (e: Event) => { e.stopPropagation(); app.prefs.qat = pinned ? app.prefs.qat.filter((x) => x !== c.id) : [...app.prefs.qat, c.id]; app.savePrefs(); this.renderQat(); draw(); } }, icon(pinned ? 'push_pin' : 'keep')));
        row.addEventListener('click', () => run(c));
        list.appendChild(row);
      });
      if (!results.length) list.appendChild(h('div', { class: 'ql-help' }, 'No matching commands.'));
    };
    input.addEventListener('input', () => { sel = 0; draw(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { sel = Math.min(results.length - 1, sel + 1); draw(); list.children[sel]?.scrollIntoView({ block: 'nearest' }); e.preventDefault(); }
      if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); draw(); list.children[sel]?.scrollIntoView({ block: 'nearest' }); e.preventDefault(); }
      if (e.key === 'Enter' && results[sel]) { e.preventDefault(); run(results[sel]); }
    });
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    draw();
    setTimeout(() => input.focus(), 20);
  }

  // ----------------------------------------------------------------------------------------
  // Context menus

  canvasContextMenu(x: number, y: number, hit: Element | undefined): void {
    const app = this.app;
    const entries: MenuEntry[] = [
      { id: 'edit.cut', label: 'Cut', icon: 'content_cut' }, { id: 'edit.copy', label: 'Copy', icon: 'content_copy' }, { id: 'edit.paste', label: 'Paste', icon: 'content_paste' },
      { separator: true },
    ];
    if (!hit) {
      entries.push(
        { id: 'slide.layoutMenu', label: 'Layout', icon: 'dashboard', submenu: app.deck.layoutsOf(app.deck.layout(app.slide?.layout || '').master).map((l) => ({ id: 'slide.layout', arg: l.id, label: l.name, checked: app.slide?.layout === l.id })) },
        { id: 'slide.reset', label: 'Reset Slide', icon: 'restart_alt' },
        { id: 'design.formatBackground', label: 'Format Background…', icon: 'format_color_fill' },
        { id: 'view.gridSettings', label: 'Grid and Guides…', icon: 'grid_4x4' },
        { separator: true },
        { id: 'review.newComment', label: 'New Comment', icon: 'add_comment' },
        { id: 'slide.new', label: 'New Slide', icon: 'add_box' });
    } else {
      if (hit.kind === 'shape') entries.push({ id: 'shape.editText', label: 'Edit Text', icon: 'edit' });
      if (hit.kind === 'picture') entries.push({ id: 'picture.change', label: 'Change Picture…', icon: 'image' }, { id: 'picture.crop', label: 'Crop', icon: 'crop' }, { id: 'picture.saveAs', label: 'Save as Picture…', icon: 'download' });
      if (hit.kind === 'table') entries.push({ id: 'table.editCells', label: 'Edit Table…', icon: 'table' });
      if (hit.kind === 'chart') entries.push({ id: 'chart.editData', label: 'Edit Data…', icon: 'dataset' }, { id: 'chart.changeType', label: 'Change Chart Type…', icon: 'bar_chart' });
      if (hit.kind === 'group') entries.push({ id: 'arrange.ungroup', label: 'Ungroup', icon: 'call_split' });
      if (app.selected.length > 1) entries.push({ id: 'arrange.group', label: 'Group', icon: 'join' });
      entries.push(
        { label: 'Bring to Front', icon: 'flip_to_front', submenu: [{ id: 'arrange.bringToFront', label: 'Bring to Front' }, { id: 'arrange.bringForward', label: 'Bring Forward' }] },
        { label: 'Send to Back', icon: 'flip_to_back', submenu: [{ id: 'arrange.sendToBack', label: 'Send to Back' }, { id: 'arrange.sendBackward', label: 'Send Backward' }] },
        { id: 'insert.link', label: 'Link…', icon: 'link' },
        { id: 'review.altText', label: 'Edit Alt Text…', icon: 'image_search' },
        { id: 'anim.add', label: 'Add Animation…', icon: 'auto_awesome' },
        { separator: true },
        { id: 'shape.formatPane', label: 'Format Shape…', icon: 'format_shapes' },
        { id: 'shape.sizeDialog', label: 'Size and Position…', icon: 'photo_size_select_large' },
        { id: 'review.newComment', label: 'New Comment', icon: 'add_comment' });
    }
    showMenu(entries, { x, y, onPick: (en) => { if (en.id) app.exec(en.id, en.arg); } });
  }

  slideContextMenu(x: number, y: number): void {
    const app = this.app;
    const s = app.slide;
    showMenu([
      { id: 'edit.cut', label: 'Cut', icon: 'content_cut' }, { id: 'edit.copy', label: 'Copy', icon: 'content_copy' }, { id: 'edit.paste', label: 'Paste', icon: 'content_paste' },
      { separator: true },
      { id: 'slide.new', label: 'New Slide', icon: 'add_box' }, { id: 'slide.duplicate', label: 'Duplicate Slide', icon: 'library_add' }, { id: 'slide.delete', label: 'Delete Slide', icon: 'delete' },
      { id: 'section.add', label: 'Add Section', icon: 'segment' },
      { separator: true },
      { label: 'Layout', icon: 'dashboard', submenu: s ? app.deck.layoutsOf(app.deck.layout(s.layout).master).map((l) => ({ id: 'slide.layout', arg: l.id, label: l.name, checked: s.layout === l.id })) : [] },
      { id: 'slide.reset', label: 'Reset Slide', icon: 'restart_alt' },
      { id: 'design.formatBackground', label: 'Format Background…', icon: 'format_color_fill' },
      { id: 'slide.hide', label: s?.hidden ? 'Unhide Slide' : 'Hide Slide', icon: s?.hidden ? 'visibility' : 'visibility_off' },
      { id: 'slide.moveUp', label: 'Move Slide Up', icon: 'arrow_upward' }, { id: 'slide.moveDown', label: 'Move Slide Down', icon: 'arrow_downward' },
      { id: 'review.newComment', label: 'New Comment', icon: 'add_comment' },
    ], { x, y, onPick: (e) => e.id && app.exec(e.id, e.arg) });
  }

  // ----------------------------------------------------------------------------------------

  anchorFor(id: string): HTMLElement {
    const els = [...this.root.querySelectorAll<HTMLElement>(`[data-cmd-wrap="${id}"], [data-cmd="${id}"]`)].filter((e) => e.offsetParent);
    return els[0] || this.ribbonEl;
  }

  applyPrefs(): void {
    const p = this.app.prefs;
    const dark = p.theme === 'dark' || (p.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    this.root.classList.toggle('ql-ribbon-collapsed', p.ribbon !== 'full');
    this.root.classList.toggle('ql-qat-at-bottom', p.qatPosition === 'bottom');
    this.root.classList.toggle('ql-qat-below-ribbon', p.qatPosition === 'below');
    this.root.classList.toggle('ql-qat-hidden', p.qatHidden);
    this.root.classList.toggle('ql-touch', p.touchMode);
    this.root.classList.toggle('ql-high-contrast', p.highContrastUI);
    this.root.style.setProperty('--ql-ui-scale', String(p.uiScale || 1));
    if (!this.app.docs.length) return;
    this.renderQat();
    for (const d of this.app.docs) d.ui.layout();
    this.refresh();
  }

  globalKey(e: KeyboardEvent): void {
    const k = keyName(e);
    if (!k) return;
    if (document.querySelector('.qs-show-ui, .qs-presenter')) return; // the slide show handles its own keys
    if (e.key === 'Escape') {
      if (document.querySelector('.ql-menu')) { closeMenus(); return; }
      if (this.root.classList.contains('ql-backstage-open')) { this.hideBackstage(); return; }
    }
    if (document.querySelector('.ql-overlay')) {
      // A dialog is open: its fields get the keys, but Save, Print and Open must not reach the browser.
      const over = this.app.keyIndex.get(canonicalKey(k));
      if ((e.ctrlKey || e.metaKey) && ((over && /^file\.(save|print|open|quickPrint|saveAs)$/.test(over)) || /^[spo]$/i.test(e.key))) e.preventDefault();
      return;
    }
    const t = e.target as HTMLElement;
    const inField = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
    const inCanvas = this.app.active && this.app.tab.ui.el.contains(t) && !inField;
    const inEditor = !!t?.closest?.('.qs-textedit');
    const id = this.app.keyIndex.get(canonicalKey(k));
    if (!id) return;
    // Character formatting keys work while editing text; other keys are left to the editor.
    if (inEditor) {
      if (/^(fmt\.|edit\.(undo|redo|find|replace|selectAll)|file\.|view\.cmdSearch|show\.|insert\.link)/.test(id) && (e.ctrlKey || e.metaKey || e.altKey || /^F\d+$/.test(e.key))) {
        if (id === 'edit.undo' || id === 'edit.redo' || id === 'edit.selectAll') return; // native inside the island
        e.preventDefault(); e.stopPropagation(); this.app.exec(id);
      }
      return;
    }
    if (inCanvas) return; // the canvas forwards unhandled keys itself
    if (inField) { if (!/^(file\.|view\.cmdSearch|show\.)/.test(id) || !(e.ctrlKey || e.metaKey || /^F\d+$/.test(e.key))) return; }
    e.preventDefault();
    this.app.exec(id);
  }

  async showShortcuts(): Promise<void> {
    const rows = allCommands().filter((c) => (c.keys && c.keys.length) || Object.values(this.app.prefs.keymap).includes(c.id));
    const custom = Object.entries(this.app.prefs.keymap);
    const nav: [string, string][] = [['Arrow keys', 'Move the selected object (Shift: farther)'], ['Tab / Shift+Tab', 'Select the next / previous object'], ['Enter or F2', 'Edit the selected shape\'s text'], ['Esc', 'Stop editing text / deselect'], ['Tab / Shift+Tab (in text)', 'Demote / promote the paragraph'], ['PgDn / PgUp', 'Next / previous slide'], ['Ctrl+wheel, pinch', 'Zoom']];
    const table = h('table', { class: 'ql-stats ql-shortcuts' },
      ...nav.map(([a, b]) => h('tr', null, h('td', null, b), h('td', null, a), h('td', { class: 'ql-help' }, 'Editing'))),
      ...rows.sort((a, b) => a.tab.localeCompare(b.tab) || a.label.localeCompare(b.label)).map((c) => {
        const keys = [...(c.keys || []), ...custom.filter(([, id]) => id === c.id).map(([k2]) => k2)];
        return h('tr', null, h('td', null, c.label), h('td', null, keys.map(prettyKey).join(', ')), h('td', { class: 'ql-help' }, c.tab === 'Backstage' ? 'File' : c.tab));
      }));
    await openDialog({ title: 'Keyboard Shortcuts', wide: true, content: table, cancel: false });
  }

  async showCommandReference(): Promise<void> {
    const byTab = new Map<string, Command[]>();
    for (const c of allCommands()) { const t = c.tab === 'Backstage' ? 'File' : c.tab; if (!byTab.has(t)) byTab.set(t, []); byTab.get(t)!.push(c); }
    const div = h('div', { class: 'ql-cmdref' });
    div.appendChild(h('p', { class: 'ql-help' }, `${allCommands().length} commands. Every command can be added to the Quick Access Bar, a custom tab, a keyboard shortcut, or a macro.`));
    for (const [t, cs] of byTab) {
      div.appendChild(h('h3', null, `${t} (${cs.length})`));
      div.appendChild(h('ul', null, ...cs.sort((a, b) => a.label.localeCompare(b.label)).map((c) => h('li', null, h('b', null, c.label), c.keys?.length ? ` — ${c.keys.map(prettyKey).join(', ')}` : '', c.origin ? h('span', { class: 'ql-help' }, ` (from ${c.origin})`) : ''))));
    }
    await openDialog({ title: 'Command Reference', wide: true, content: div, cancel: false });
  }

  async tour(): Promise<void> {
    const steps = [
      ['Everything is a command', 'Every feature of Anne\'s Stage is a command you can find with the search button (or Alt+Q), place on the Quick Access Bar, put on your own tab, assign a key, or record in a macro.'],
      ['Quick Access Bar', 'Tap ▾ at the end of the Quick Access Bar to add common commands, or choose More Commands… to pick from the full library. Long-press or right-click any ribbon button to add it. You can move the bar below the ribbon or to the bottom, near the keyboard.'],
      ['Slides', 'Add slides with New Slide (Ctrl+M). Click a placeholder to type. Drag thumbnails to reorder; right-click (or long-press) them for more. The Outline view lets you write the whole deck as an outline.'],
      ['Presenting', 'Present from the beginning with F5, or from the current slide with Shift+F5. With a second screen, Presenter View shows your notes, the next slide and a timer while the audience sees the slides. Press ? during the show for every key.'],
      ['Files', 'Open and save .pptx, .odp and Markdown slides with the system file picker. Damaged presentations are repaired on open; File ▸ Open ▸ Open and Repair forces it.'],
    ];
    for (let i = 0; i < steps.length; i++) {
      const r = await openDialog({ title: `${steps[i][0]} (${i + 1}/${steps.length})`, content: h('p', { class: 'ql-msg' }, steps[i][1]), ok: i === steps.length - 1 ? 'Start' : 'Next', cancel: 'Skip tour' });
      if (!r) break;
    }
    this.app.prefs.firstRun = false;
    this.app.savePrefs();
  }
}
