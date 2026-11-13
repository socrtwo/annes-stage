/** File backstage: Home, New, Open, Info, Save As, Export, Print, Share, Options. */
import type { App } from '../app';
import { h, icon, clear } from './dom';
import { TEMPLATES, STARTERS } from '../templates';
import { FORMATS } from '../io';
import { kvKeys, kvGet, kvDel } from '../util/store';
import { Deck } from '../model/deck';
import { slideSvg } from '../render/slide';

const PAGES: [string, string, string][] = [
  ['home', 'Home', 'home'], ['new', 'New', 'note_add'], ['open', 'Open', 'folder_open'], ['info', 'Info', 'info'],
  ['save', 'Save', 'save'], ['saveas', 'Save As', 'save_as'], ['export', 'Export', 'ios_share'], ['print', 'Print', 'print'],
  ['share', 'Share', 'share'], ['close', 'Close', 'close'], ['options', 'Options', 'settings'],
];

export function renderBackstage(app: App, root: HTMLElement, page: string): void {
  clear(root);
  const nav = h('nav', { class: 'ql-bs-nav' }, h('button', { class: 'ql-bs-back', onclick: () => app.ui.hideBackstage(), 'aria-label': 'Back to presentation' }, icon('arrow_back'), ' Back'));
  for (const [id, label, ic] of PAGES) {
    nav.appendChild(h('button', { class: 'ql-bs-item' + (id === page ? ' ql-on' : ''), onclick: () => {
      if (id === 'save') { app.ui.hideBackstage(); app.exec('file.save'); return; }
      if (id === 'close') { app.exec('file.close'); return; }
      if (id === 'options') { app.exec('file.options'); return; }
      renderBackstage(app, root, id);
    } }, icon(ic), ' ', label));
  }
  const body = h('div', { class: 'ql-bs-body' });
  root.append(nav, body);
  const card = (title: string, sub: string, ic: string, onclick: () => void) => h('button', { class: 'ql-bs-card', onclick }, icon(ic, 'ql-bs-card-icon'), h('div', null, h('b', null, title), h('div', { class: 'ql-help' }, sub)));
  const deck = app.deck;
  switch (page) {
    case 'home':
    case 'new': {
      const hr = new Date().getHours();
      body.appendChild(h('h1', null, page === 'home' ? 'Good ' + (hr < 12 ? 'morning' : hr < 18 ? 'afternoon' : 'evening') : 'New'));
      const grid = h('div', { class: 'ql-bs-templates' });
      const thumb = (build: () => Deck) => { const el = h('div', { class: 'ql-template-thumb qs-template-thumb' }); try { const d = build(); if (d.slides[0]) el.innerHTML = slideSvg(d, d.slides[0], { mode: 'thumb' }); } catch { /* */ } return el; };
      const list = page === 'home' ? TEMPLATES.slice(0, 5) : TEMPLATES;
      for (const t of list) grid.appendChild(h('button', { class: 'ql-template', onclick: () => { app.ui.hideBackstage(); app.exec('file.new', t.id); } }, thumb(t.build), h('b', null, t.name), h('div', { class: 'ql-help' }, t.description)));
      body.appendChild(grid);
      if (page === 'new') {
        body.appendChild(h('h2', null, 'Content Starters'));
        const sg = h('div', { class: 'ql-bs-templates' });
        for (const t of STARTERS) sg.appendChild(h('button', { class: 'ql-template', onclick: () => { app.ui.hideBackstage(); app.exec('file.new', t.id); } }, thumb(t.build), h('b', null, t.name), h('div', { class: 'ql-help' }, t.description)));
        body.appendChild(sg);
      }
      if (page === 'new') {
        const mine = h('div', { class: 'ql-bs-templates' });
        body.append(h('h2', null, 'My Templates'), mine);
        kvKeys('tpl:').then(async (keys) => {
          if (!keys.length) mine.appendChild(h('p', { class: 'ql-help' }, 'Use File ▸ Save As ▸ Template to add your own.'));
          for (const k of keys) {
            const t = await kvGet(k);
            mine.appendChild(h('div', { class: 'ql-template' }, h('button', { class: 'ql-link', onclick: () => { app.ui.hideBackstage(); const d = Deck.fromJSON(t.json); if (!d.slides.length) d.data.slides.push(d.makeSlide(d.data.layouts[0].id)); d.clearHistory(); app.createTab(d, { title: t.name }); } }, h('b', null, t.name)), h('button', { class: 'ql-iconbtn ql-sm', title: 'Delete template', onclick: async () => { await kvDel(k); renderBackstage(app, root, 'new'); } }, icon('delete'))));
          }
        });
      }
      if (page === 'home') { body.appendChild(h('h2', null, 'Recent')); recentList(app, body); }
      break;
    }
    case 'open': {
      body.append(h('h1', null, 'Open'),
        card('Browse…', 'Open a file from this device, Drive, or any document provider', 'folder_open', () => app.exec('file.open')),
        card('Encrypted presentation…', 'Open a password-protected .qspe file', 'lock_open', () => app.exec('file.openEncrypted')),
        card('Open and Repair…', 'Rebuild a damaged .pptx, .ppt or .odp and show what was recovered', 'healing', () => app.exec('file.openRepair')),
        card('Recover Data from Any File…', 'Pull readable text and pictures out of any file, however damaged', 'text_snippet', () => app.exec('file.recoverAny')),
        card('Import Markdown Slides…', 'Slides separated by ---, headings become titles', 'markdown', () => app.exec('file.import.markdown')),
        card('Text to Deck…', 'Each paragraph of text becomes a slide', 'notes', () => app.exec('file.import.textDeck')),
        card('Recover unsaved presentations', 'Drafts saved automatically before a crash or close', 'restore_page', () => app.exec('file.recoverUnsaved')),
        h('h2', null, 'Recent'));
      recentList(app, body, true);
      break;
    }
    case 'info': {
      const tab = app.tab;
      let words = 0, pics = 0, media = 0;
      const walk = (els: any[]) => { for (const e of els) { if (e.kind === 'picture') pics++; if (e.kind === 'media') media++; if (e.kind === 'shape') for (const p of e.text?.paras || []) for (const r of p.runs) words += (r.text.match(/\S+/g) || []).length; if (e.children) walk(e.children); } };
      for (const s of deck.slides) walk(s.elements);
      const p = deck.data.props;
      body.append(h('h1', null, 'Info'), h('h2', null, tab.displayName),
        h('div', { class: 'ql-bs-cards' },
          card('Protect Presentation', deck.data.finalMarked ? 'Marked as final' : 'Encrypt with a password or mark as final', 'shield_lock', () => app.exec('file.encrypt')),
          card('Mark as Final', deck.data.finalMarked ? 'The presentation is read-only' : 'Make the presentation read-only', 'verified', () => app.exec('file.markFinal')),
          card('Inspect Presentation', 'Find and remove comments, notes, hidden slides, personal information', 'policy', () => app.exec('file.inspect')),
          card('Check Accessibility', 'Find content people with disabilities might have trouble reading', 'accessibility_new', () => { app.ui.hideBackstage(); app.exec('review.checkAccessibility'); }),
          card('Check Compatibility', 'Features that change in other formats', 'rule', () => app.exec('file.checkCompatibility')),
          card('Compress Media', 'Remove media no slide uses', 'compress', () => app.exec('file.compressMedia')),
          card('Version History', 'Browse and restore snapshots', 'history', () => app.exec('file.versions')),
          card('Revert to Saved', 'Discard changes since the last save', 'settings_backup_restore', () => app.exec('file.revert'))),
        h('h3', null, 'Properties'),
        h('table', { class: 'ql-stats' },
          ...[['Title', p.title || '—'], ['Author', p.author || app.prefs.author], ['Slides', String(deck.slides.length)], ['Hidden slides', String(deck.slides.filter((s) => s.hidden).length)], ['Words', String(words)], ['Pictures', String(pics)], ['Media clips', String(media)], ['Slide size', `${(deck.size.w / 72).toFixed(2)} × ${(deck.size.h / 72).toFixed(2)} in`], ['Format', tab.format.toUpperCase()], ['Location', tab.uri ? 'Device storage' : 'Not saved yet'], ['Created', new Date(p.created || tab.created).toLocaleString()], ['Last saved', tab.saved ? new Date(tab.saved).toLocaleString() : '—']].map(([k, v]) => h('tr', null, h('td', null, k), h('td', null, v)))),
        h('button', { class: 'ql-btn', onclick: () => app.exec('file.properties') }, 'All Properties…'));
      break;
    }
    case 'saveas':
    case 'export': {
      body.append(h('h1', null, page === 'saveas' ? 'Save As' : 'Export'), h('p', { class: 'ql-help' }, page === 'saveas' ? 'Choose a format. The system file dialog lets you pick the folder (device, SD card, Drive, Dropbox…).' : 'Save a copy in another format; the current presentation keeps its file.'));
      const grid = h('div', { class: 'ql-bs-cards' });
      for (const f of FORMATS.filter((x) => x.canExport)) grid.appendChild(card(f.label, `.${f.ext[0]}`, 'description', () => (page === 'saveas' ? app.exec('file.saveAsFormat', f.id) : app.exec(`file.export.${f.id}`))));
      grid.appendChild(card('PDF', 'Slides, handouts, notes pages or outline', 'picture_as_pdf', () => app.exec('file.export.pdf')));
      grid.appendChild(card('Pictures', 'PNG, JPEG or SVG of each slide', 'image', () => app.exec('file.export.images')));
      grid.appendChild(card('HTML Show', 'One web page that plays the presentation anywhere', 'html', () => app.exec('file.export.htmlShow')));
      grid.appendChild(card('Story', 'A responsive scrolling web page', 'web_stories', () => app.exec('file.export.story')));
      grid.appendChild(card('Outline', 'Text, Markdown or RTF', 'format_list_bulleted', () => app.exec('file.export.outline')));
      grid.appendChild(card('Package Presentation', 'A ZIP with .pptx, .qsp, HTML show and PDF', 'inventory_2', () => app.exec('file.package')));
      grid.appendChild(card('Encrypted Anne\'s Stage (.qspe)', 'AES-256 password protected', 'enhanced_encryption', () => app.exec('file.encrypt')));
      grid.appendChild(card('Template', 'Reuse this design as a starting point', 'bookmark_add', () => app.exec('file.saveTemplate')));
      body.appendChild(grid);
      break;
    }
    case 'print': {
      body.append(h('h1', null, 'Print'),
        card('Print…', 'Slides, handouts, notes pages or outline, with a preview', 'print', () => app.exec('file.print')),
        card('Quick Print', 'All slides with the current settings', 'print', () => app.exec('file.quickPrint')),
        card('Export as PDF', 'A PDF file of slides, handouts or notes pages', 'picture_as_pdf', () => app.exec('file.export.pdf')));
      break;
    }
    case 'share': {
      body.append(h('h1', null, 'Share'),
        card('Share a copy…', 'Send as .pptx, .odp, PDF…', 'share', () => app.exec('file.share')),
        card('Email', 'Attach to an email', 'mail', () => app.exec('file.email')),
        card('Email as PDF', 'Attach a PDF of the slides', 'forward_to_inbox', () => app.exec('file.emailPdf')),
        card('Export HTML Show', 'A web page anyone can open to watch the presentation', 'html', () => app.exec('file.export.htmlShow')));
      break;
    }
  }
}

function recentList(app: App, body: HTMLElement, full = false) {
  const list = h('div', { class: 'ql-recent' });
  const rec = app.prefs.recent;
  if (!rec.length) list.appendChild(h('p', { class: 'ql-help' }, 'Presentations you open or save appear here.'));
  for (const r of rec.slice(0, full ? 40 : 8)) {
    list.appendChild(h('div', { class: 'ql-recent-row' },
      h('button', { class: 'ql-recent-open', onclick: () => app.exec('file.openRecent', r.key) }, icon('slideshow'), h('div', null, h('b', null, r.name), h('div', { class: 'ql-help' }, new Date(r.when).toLocaleString()))),
      h('button', { class: 'ql-iconbtn', title: r.pinned ? 'Unpin' : 'Pin', onclick: () => { r.pinned = !r.pinned; app.savePrefs(); renderBackstage(app, body.parentElement!, full ? 'open' : 'home'); } }, icon(r.pinned ? 'keep_off' : 'keep')),
      h('button', { class: 'ql-iconbtn', title: 'Remove from list', onclick: () => { app.prefs.recent = app.prefs.recent.filter((x) => x !== r); app.savePrefs(); renderBackstage(app, body.parentElement!, full ? 'open' : 'home'); } }, icon('close'))));
  }
  if (full && rec.length) list.appendChild(h('button', { class: 'ql-btn', onclick: () => app.exec('file.clearRecent') }, 'Clear unpinned'));
  body.appendChild(list);
}
