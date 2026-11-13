/** Review tab: spelling, statistics, accessibility, alt text, reading order, design check, language, comments, compare. */
import { def } from './registry';
import type { App } from '../app';
import type { Comment, Element, Paragraph, ShapeElement, Slide } from '../model/types';
import { clone, newId } from '../model/deck';
import { edit, forEachText, shapeText } from '../edit/ops';
import { splitRuns, paraText } from '../edit/textEdit';
import { openDialog, toast, confirmDialog, promptDialog } from '../ui/dialog';
import { h, clear, icon } from '../ui/dom';
import { registerPane, typingIn, canEdit } from '../ui/panes';
import { isSlide, levelStyle, resolveBox } from '../model/inherit';
import { contrastRatio, resolveColor, themeFont } from '../model/theme';
import { effectiveBackground, slideTitle } from '../render/slide';
import { titleShape } from '../edit/workspace';

const hasSlides = (app: App) => app.deck.slides.length > 0;
const slideOf = (app: App): Slide | undefined => (app.owner && isSlide(app.owner) ? app.owner : undefined);

/** Replaces characters [start, end) of a paragraph, keeping the formatting of the first replaced run. */
export function replaceInPara(p: Paragraph, start: number, end: number, text: string): void {
  let first = true;
  p.runs = splitRuns(p.runs, start, end, (r) => { r.text = first ? text : ''; first = false; });
}

// ------------------------------------------------------------------------------------------
// Spelling

interface SpellLoc { slide: Slide; paras: Paragraph[]; pi: number; el: Element | null }

async function spelling(app: App): Promise<void> {
  if (app.tab.ui.editingText) app.tab.ui.commitText();
  const { workerChecker, wordsIn, dictionaryKey } = await import('../proof/proofing');
  const d = app.deck;
  const dict = (await dictionaryKey(app.prefs.language, app.prefs.spellDialect as any)) || 'any';
  const start = Math.max(0, d.slideIndex(app.tab.current));
  const order = [...d.slides.slice(start), ...d.slides.slice(0, start)];
  const locs: SpellLoc[] = [];
  for (const s of order) forEachText([s], (paras, el) => paras.forEach((_, pi) => locs.push({ slide: s, paras, pi, el })));
  const ignored = new Set(app.prefs.ignoredWords.map((w) => w.toLowerCase()));
  const mine = new Set(app.prefs.dictionary.map((w) => w.toLowerCase()));
  const all = new Set<string>();
  for (const l of locs) for (const w of wordsIn(paraText(l.paras[l.pi]))) all.add(w.word);
  let bad: Set<string>;
  try { bad = await workerChecker.check([...all], dict); } catch (e: any) { toast(`Spelling: ${e?.message || e}`); return; }
  const changeAll = new Map<string, string>();
  let changed = 0;
  for (const l of locs) {
    let from = 0;
    for (;;) {
      const p = l.paras[l.pi];
      const words = wordsIn(paraText(p)).filter((w) => w.start >= from);
      const w = words.find((x) => bad.has(x.word) && !ignored.has(x.word.toLowerCase()) && !mine.has(x.word.toLowerCase()));
      if (!w) break;
      const auto = changeAll.get(w.word);
      if (auto != null) { d.transact('Spelling', () => replaceInPara(p, w.start, w.end, auto), [l.slide.id]); changed++; from = w.start + auto.length; continue; }
      if (app.tab.current !== l.slide.id) app.goToSlide(l.slide.id);
      if (l.el) app.tab.ui.select([l.el.id]);
      const sugg = await workerChecker.suggest(w.word, dict).catch(() => [] as string[]);
      const text = paraText(p);
      const r = await openDialog({ title: 'Spelling', fields: [
        { key: 'ctx', type: 'info', html: `<p>${l.el ? '' : '<i>(Speaker notes)</i> '}${esc(text.slice(Math.max(0, w.start - 40), w.start))}<b style="color:#c62828;text-decoration:underline wavy">${esc(w.word)}</b>${esc(text.slice(w.end, w.end + 40))}</p>` },
        { key: 'to', label: 'Change to', type: 'combo', options: sugg, value: sugg[0] || w.word },
        { key: 'act', label: 'Action', type: 'radio', options: [{ value: 'change', label: 'Change' }, { value: 'changeAll', label: 'Change All' }, { value: 'ignore', label: 'Ignore Once' }, { value: 'ignoreAll', label: 'Ignore All' }, { value: 'add', label: 'Add to Dictionary' }], value: sugg.length ? 'change' : 'ignore' },
      ], ok: 'Apply', cancel: 'Stop' });
      if (!r) { toast(changed ? `Stopped. ${changed} change(s) made.` : 'Spelling check stopped.'); return; }
      if (r.act === 'change' || r.act === 'changeAll') {
        const to = String(r.to);
        d.transact('Spelling', () => replaceInPara(p, w.start, w.end, to), [l.slide.id]);
        changed++;
        if (r.act === 'changeAll') changeAll.set(w.word, to);
        from = w.start + to.length;
      } else {
        if (r.act === 'ignoreAll') { ignored.add(w.word.toLowerCase()); app.prefs.ignoredWords = [...new Set([...app.prefs.ignoredWords, w.word])]; app.savePrefs(); }
        if (r.act === 'add') { mine.add(w.word.toLowerCase()); app.prefs.dictionary = [...new Set([...app.prefs.dictionary, w.word])]; app.savePrefs(); try { await workerChecker.add?.(w.word); } catch { /* */ } }
        from = w.end;
      }
    }
  }
  toast(changed ? `Spelling check complete: ${changed} change(s).` : 'Spelling check complete. No errors found.');
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

// ------------------------------------------------------------------------------------------
// Statistics

export function deckStats(app: App): Record<string, number> {
  const d = app.deck;
  let words = 0, chars = 0, paras = 0, notesWords = 0, pictures = 0, media = 0, shapes = 0, tables = 0, charts = 0;
  const count = (t: string) => t.split(/\s+/).filter(Boolean).length;
  const walk = (els: Element[]) => { for (const e of els) { if (e.kind === 'group') walk(e.children); else if (e.kind === 'picture') pictures++; else if (e.kind === 'media') media++; else if (e.kind === 'table') tables++; else if (e.kind === 'chart') charts++; else shapes++; } };
  for (const s of d.slides) {
    walk(s.elements);
    forEachText([s], (ps, el) => { for (const p of ps) { const t = paraText(p); if (!t.trim()) continue; if (el) { words += count(t); chars += t.length; paras++; } else notesWords += count(t); } });
  }
  return { Slides: d.slides.length, 'Hidden slides': d.slides.filter((s) => s.hidden).length, Words: words, Characters: chars, Paragraphs: paras, 'Words in notes': notesWords, Pictures: pictures, 'Video and audio': media, Shapes: shapes, Tables: tables, Charts: charts, Sections: d.data.sections.length, Comments: d.slides.reduce((a, s) => a + (s.comments?.length || 0), 0) };
}

// ------------------------------------------------------------------------------------------
// Accessibility and design checks

interface Issue { kind: 'error' | 'warning' | 'tip'; text: string; slide: string; el?: string; fix?: string }

export function accessibilityIssues(app: App): Issue[] {
  const d = app.deck;
  const out: Issue[] = [];
  const titles = new Map<string, number>();
  d.slides.forEach((s, i) => {
    const n = `Slide ${i + 1}`;
    const t = slideTitle(s);
    if (!t) out.push({ kind: 'error', text: `${n}: missing slide title`, slide: s.id, fix: 'Add a title (it can be placed off the slide if you do not want it shown).' });
    else titles.set(t.toLowerCase(), (titles.get(t.toLowerCase()) || 0) + 1);
    const theme = d.themeOf(s), master = d.masterOf(s);
    const bg = effectiveBackground(d, s);
    const bgHex = bg.type === 'solid' ? resolveColor(bg.color, { theme, master }, '#FFFFFF').hex : bg.type === 'gradient' ? resolveColor(bg.stops[0].color, { theme, master }).hex : null;
    for (const e of s.elements) {
      if ((e.kind === 'picture' || e.kind === 'chart' || e.kind === 'media' || e.kind === 'group' || (e.kind === 'shape' && !e.text?.paras.some((p) => p.runs.some((r) => r.text)) && !e.ph && !e.textbox)) && !e.alt && !e.decorative)
        out.push({ kind: 'error', text: `${n}: ${e.name || e.kind} has no alternative text`, slide: s.id, el: e.id, fix: 'Review ▸ Alt Text, or mark it as decorative.' });
      if (e.kind === 'table' && !e.style?.firstRow) out.push({ kind: 'warning', text: `${n}: table without a header row`, slide: s.id, el: e.id });
      if (e.kind === 'shape' && e.text && bgHex && !(e as ShapeElement).fill) {
        for (const p of e.text.paras) {
          const st = levelStyle(d, s, e, p.level);
          for (const r of p.runs) {
            if (!r.text.trim()) continue;
            const fg = resolveColor(r.color ?? st.run?.color ?? 'tx1', { theme, master }).hex;
            const ratio = contrastRatio(fg, bgHex);
            const size = r.size ?? st.run?.size ?? 18;
            if (ratio < (size >= 18 || (r.b && size >= 14) ? 3 : 4.5)) { out.push({ kind: 'warning', text: `${n}: hard-to-read text contrast (${ratio.toFixed(1)}:1) in ${e.name || 'text'}`, slide: s.id, el: e.id }); break; }
            if (size < 12) { out.push({ kind: 'tip', text: `${n}: text smaller than 12 pt in ${e.name || 'text'}`, slide: s.id, el: e.id }); break; }
          }
        }
      }
      if (e.kind === 'media' && e.mediaKind === 'video') out.push({ kind: 'tip', text: `${n}: check that the video has captions or a transcript`, slide: s.id, el: e.id });
    }
  });
  d.slides.forEach((s, i) => { const t = slideTitle(s).toLowerCase(); if (t && (titles.get(t) || 0) > 1) out.push({ kind: 'warning', text: `Slide ${i + 1}: duplicate slide title "${slideTitle(s)}"`, slide: s.id }); });
  return out;
}

export function designIssues(app: App): Issue[] {
  const d = app.deck;
  const out: Issue[] = [];
  const fonts = new Set<string>();
  d.slides.forEach((s, i) => {
    const n = `Slide ${i + 1}`;
    const theme = d.themeOf(s);
    let bullets = 0, words = 0;
    const boxes: { id: string; b: ReturnType<typeof resolveBox>; name: string }[] = [];
    for (const e of s.elements) {
      const b = resolveBox(d, s, e);
      if (b.x + b.w < 1 || b.y + b.h < 1 || b.x > d.size.w - 1 || b.y > d.size.h - 1) out.push({ kind: 'warning', text: `${n}: ${e.name || e.kind} is off the slide`, slide: s.id, el: e.id });
      else if (b.x < -1 || b.y < -1 || b.x + b.w > d.size.w + 1 || b.y + b.h > d.size.h + 1) out.push({ kind: 'tip', text: `${n}: ${e.name || e.kind} extends past the slide edge`, slide: s.id, el: e.id });
      if (e.kind === 'shape' && e.text) {
        const ps = e.text.paras.filter((p) => paraText(p).trim());
        if (e !== titleShape(s)) { bullets += ps.length; words += ps.reduce((a, p) => a + paraText(p).split(/\s+/).filter(Boolean).length, 0); }
        if (ps.length) boxes.push({ id: e.id, b, name: e.name || 'text' });
        for (const p of e.text.paras) { const st = levelStyle(d, s, e, p.level); for (const r of p.runs) if (r.text.trim()) fonts.add(themeFont(r.font ?? st.run?.font, theme) || theme.fonts.minor); }
      }
    }
    if (bullets > 6) out.push({ kind: 'tip', text: `${n}: ${bullets} bullet points — consider splitting the slide (Tools ▸ Split into Slides)`, slide: s.id });
    if (words > 40) out.push({ kind: 'tip', text: `${n}: ${words} words — audiences read or listen, rarely both`, slide: s.id });
    for (let a = 0; a < boxes.length; a++) for (let b = a + 1; b < boxes.length; b++) {
      const p = boxes[a].b, q = boxes[b].b;
      const ox = Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x), oy = Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y);
      if (ox > 4 && oy > 4) out.push({ kind: 'warning', text: `${n}: text boxes "${boxes[a].name}" and "${boxes[b].name}" overlap`, slide: s.id, el: boxes[b].id });
    }
  });
  if (fonts.size > 3) out.push({ kind: 'tip', text: `The presentation uses ${fonts.size} fonts (${[...fonts].join(', ')}); two or three read better`, slide: d.slides[0]?.id || '' });
  return out;
}

function issuesPane(id: string, title: string, get: (app: App) => Issue[], intro: string): void {
  registerPane({
    id, title,
    render(app, el) { this.update!(app, el, {}); },
    update(app, el) {
      const sig = String(app.deck.version);
      if (el.dataset.sig === sig) return;
      el.dataset.sig = sig;
      clear(el);
      const list = get(app);
      el.appendChild(h('p', { class: 'ql-help' }, intro));
      if (!list.length) { el.appendChild(h('p', null, icon('check_circle'), ' No issues found.')); return; }
      for (const k of ['error', 'warning', 'tip'] as const) {
        const items = list.filter((i) => i.kind === k);
        if (!items.length) continue;
        el.appendChild(h('h3', { class: 'ql-pane-h' }, `${k === 'error' ? 'Errors' : k === 'warning' ? 'Warnings' : 'Tips'} (${items.length})`));
        for (const it of items) el.appendChild(h('button', { class: 'ql-nav-item', title: it.fix || '', onclick: () => { app.goToSlide(it.slide); if (it.el) app.tab.ui.select([it.el]); } }, icon(k === 'error' ? 'error' : k === 'warning' ? 'warning' : 'lightbulb'), h('span', null, ' ' + it.text)));
      }
    },
  });
}
issuesPane('accessibility', 'Accessibility', accessibilityIssues, 'Content people with disabilities might find hard to read or navigate. Click an item to go to it.');
issuesPane('designCheck', 'Design Checker', designIssues, 'Suggestions in the spirit of the old presentation advisors and of Tufte: fewer words, fewer fonts, nothing off the slide.');

registerPane({
  id: 'readingOrder', title: 'Reading Order',
  render(app, el) { this.update!(app, el, {}); },
  update(app, el) {
    const s = slideOf(app);
    const sig = `${app.deck.version}:${s?.id}:${app.tab.ui?.selection.join()}`;
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    clear(el);
    if (!s) return;
    el.appendChild(h('p', { class: 'ql-help' }, 'Screen readers read objects from top to bottom of this list (the back-to-front order on the slide).'));
    s.elements.forEach((e, i) => {
      const on = app.tab.ui.selection.includes(e.id);
      el.appendChild(h('div', { class: 'ql-nav-item' + (on ? ' ql-on' : ''), style: 'display:flex;gap:4px;align-items:center' },
        h('span', { style: 'flex:1;cursor:pointer', onclick: () => app.tab.ui.select([e.id]) }, `${i + 1}. ${e.name || e.kind}${e.decorative ? ' (decorative)' : !e.alt && e.kind !== 'shape' ? ' — no alt text' : ''}`),
        h('button', { class: 'ql-iconbtn ql-sm', title: 'Read earlier', disabled: i === 0 ? '' : null, onclick: () => canEdit(app) && edit(app, 'Reading Order', (o) => { const l = o.elements; [l[i - 1], l[i]] = [l[i], l[i - 1]]; }) }, icon('arrow_upward')),
        h('button', { class: 'ql-iconbtn ql-sm', title: 'Read later', disabled: i === s.elements.length - 1 ? '' : null, onclick: () => canEdit(app) && edit(app, 'Reading Order', (o) => { const l = o.elements; [l[i + 1], l[i]] = [l[i], l[i + 1]]; }) }, icon('arrow_downward'))));
    });
  },
});

// ------------------------------------------------------------------------------------------
// Comments

function allComments(app: App): { slide: Slide; c: Comment }[] {
  return app.deck.slides.flatMap((s) => (s.comments || []).map((c) => ({ slide: s, c })));
}

function addComment(app: App, text: string, target?: string): boolean {
  const s = slideOf(app);
  if (!s || !canEdit(app)) return false;
  const c: Comment = { id: newId('cm'), author: app.prefs.author, initials: app.prefs.initials, time: Date.now(), text, ...(target ? { target } : {}) };
  app.deck.transact('New Comment', () => { (s.comments ||= []).push(c); }, [s.id]);
  return true;
}

registerPane({
  id: 'comments', title: 'Comments',
  render(app, el) { this.update!(app, el, {}); },
  update(app, el) {
    const s = slideOf(app);
    const sig = `${app.deck.version}:${s?.id}`;
    if ((el.dataset.sig === sig) || typingIn(el)) return;
    el.dataset.sig = sig;
    clear(el);
    if (!s) return;
    // Redraw now: the field the user typed in still has focus, which would hold the pane back.
    const redraw = () => { delete el.dataset.sig; this.update!(app, el, {}); };
    const input = h('textarea', { class: 'ql-input', rows: '2', placeholder: 'Start a conversation…', style: 'width:100%' }) as HTMLTextAreaElement;
    el.append(input, h('div', { class: 'ql-row' }, h('button', { class: 'ql-btn ql-primary', onclick: () => { const t = input.value.trim(); if (t && addComment(app, t, app.selected[0]?.id)) { input.value = ''; input.blur(); redraw(); } } }, 'Post'),
      h('button', { class: 'ql-btn', onclick: () => app.exec('review.prevComment') }, icon('chevron_left')), h('button', { class: 'ql-btn', onclick: () => app.exec('review.nextComment') }, icon('chevron_right'))));
    const list = s.comments || [];
    if (!list.length) el.appendChild(h('p', { class: 'ql-help' }, 'No comments on this slide.'));
    for (const c of list) {
      const target = c.target ? s.elements.find((e) => e.id === c.target) : undefined;
      const reply = h('input', { class: 'ql-input', placeholder: 'Reply…', style: 'width:100%' }) as HTMLInputElement;
      reply.addEventListener('keydown', (e) => { if (e.key === 'Enter' && reply.value.trim()) { e.preventDefault(); if (!canEdit(app)) return; const t = reply.value.trim(); reply.value = ''; reply.blur(); app.deck.transact('Reply', () => { const cc = s.comments!.find((x) => x.id === c.id)!; (cc.replies ||= []).push({ id: newId('cm'), author: app.prefs.author, initials: app.prefs.initials, time: Date.now(), text: t }); }, [s.id]); redraw(); } });
      el.appendChild(h('div', { class: 'qs-comment' + (c.resolved ? ' qs-resolved' : ''), style: `border:1px solid var(--line,#ccc);border-radius:6px;padding:6px;margin:6px 0;${c.resolved ? 'opacity:.6' : ''}` },
        h('div', null, h('b', null, c.author), h('span', { class: 'ql-help' }, ` · ${new Date(c.time).toLocaleString()}${target ? ` · on ${target.name || target.kind}` : ''}`)),
        h('div', { style: 'white-space:pre-wrap' }, c.text),
        ...(c.replies || []).map((r) => h('div', { style: 'margin-left:12px;border-left:2px solid var(--line,#ccc);padding-left:6px' }, h('b', null, r.author), h('span', { class: 'ql-help' }, ` · ${new Date(r.time).toLocaleString()}`), h('div', null, r.text))),
        reply,
        h('div', { class: 'ql-row' },
          target ? h('button', { class: 'ql-btn ql-sm', onclick: () => app.tab.ui.select([target.id]) }, 'Show') : null,
          h('button', { class: 'ql-btn ql-sm', onclick: () => canEdit(app) && app.deck.transact(c.resolved ? 'Reopen Comment' : 'Resolve Comment', () => { const cc = s.comments!.find((x) => x.id === c.id)!; cc.resolved = !cc.resolved || undefined; }, [s.id]) }, c.resolved ? 'Reopen' : 'Resolve'),
          h('button', { class: 'ql-btn ql-sm', onclick: () => canEdit(app) && app.deck.transact('Delete Comment', () => { s.comments = s.comments!.filter((x) => x.id !== c.id); }, [s.id]) }, 'Delete'))));
    }
  },
});

function stepComment(app: App, dir: 1 | -1): void {
  const d = app.deck;
  const n = d.slides.length;
  const i = Math.max(0, d.slideIndex(app.tab.current));
  for (let k = 1; k <= n; k++) {
    const s = d.slides[(i + dir * k + n * 2) % n];
    if (s.comments?.length) { app.goToSlide(s.id); app.ui.openPane('comments'); const t = s.comments[0].target; if (t) app.tab.ui.select([t]); return; }
  }
  const cur = d.slides[i];
  if (cur?.comments?.length) { app.ui.openPane('comments'); return; }
  toast('There are no comments in this presentation.');
}

// ------------------------------------------------------------------------------------------
// Compare

async function compare(app: App): Promise<void> {
  const { pickFile } = await import('../ui/dom');
  const f = (await pickFile('.pptx,.pptm,.ppsx,.potx,.odp,.fodp,.qsp,.json,.md'))[0];
  if (!f) return;
  const { importDeck } = await import('../io');
  const other = (await importDeck(new Uint8Array(await f.arrayBuffer()), f.name)).deck;
  const d = app.deck;
  const textOfSlide = (s: Slide) => [slideTitle(s), ...s.elements.map(shapeText)].join('\n').trim();
  const n = Math.max(d.slides.length, other.slides.length);
  const rows: { i: number; kind: string; mine?: Slide; theirs?: Slide }[] = [];
  for (let i = 0; i < n; i++) {
    const a = d.slides[i], b = other.slides[i];
    if (a && b) { if (textOfSlide(a) !== textOfSlide(b) || JSON.stringify(a.notes) !== JSON.stringify(b.notes)) rows.push({ i, kind: 'changed', mine: a, theirs: b }); }
    else if (b) rows.push({ i, kind: 'added', theirs: b });
    else if (a) rows.push({ i, kind: 'missing', mine: a });
  }
  if (!rows.length) { toast(`No text differences between this presentation and "${f.name}".`); return; }
  const r = await openDialog({ title: `Compare with ${f.name}`, wide: true, fields: [
    { key: 'i', type: 'info', html: `<p>${rows.length} slide(s) differ. Choose the changes to accept from "${esc(f.name)}" (applied as one step you can undo).</p>` },
    { key: 'take', label: 'Accept', type: 'list', multiple: true, rows: Math.min(12, rows.length), options: rows.map((x, k) => ({ value: String(k), label: `Slide ${x.i + 1}: ${x.kind === 'changed' ? `changed — "${(slideTitle(x.theirs!) || '(untitled)').slice(0, 50)}"` : x.kind === 'added' ? `only in the other file — "${(slideTitle(x.theirs!) || '(untitled)').slice(0, 50)}"` : 'only in this presentation (accepting deletes it)'}` })), value: [] },
  ] });
  if (!r || !r.take?.length) return;
  const take = (r.take as string[]).map((k) => rows[+k]);
  d.transact('Accept Changes', () => {
    Object.assign(d.media, other.media);
    const layoutFor = (s: Slide) => (d.layoutByType(other.layout(s.layout).type || 'obj') || d.data.layouts[0]).id;
    for (const x of take) {
      if (x.kind === 'changed') { const at = d.slideIndex(x.mine!.id); d.data.slides[at] = { ...clone(x.theirs!), id: x.mine!.id, layout: layoutFor(x.theirs!) }; }
      else if (x.kind === 'added') d.data.slides.splice(Math.min(x.i, d.slides.length), 0, { ...clone(x.theirs!), id: newId('sld'), layout: layoutFor(x.theirs!) });
    }
    const del = new Set(take.filter((x) => x.kind === 'missing').map((x) => x.mine!.id));
    d.data.slides = d.data.slides.filter((s) => !del.has(s.id));
  });
}

// ------------------------------------------------------------------------------------------

def([
  { id: 'review.spelling', label: 'Spelling', icon: 'spellcheck', tab: 'Review', group: 'Proofing', keys: ['F7'], edits: true, popular: true, isEnabled: hasSlides, tip: 'Check spelling on the slides and in the notes', run: (app) => spelling(app) },
  { id: 'review.dictionaries', label: 'Spelling Dictionaries', icon: 'translate', tab: 'Review', group: 'Proofing', edits: false, noRecord: true, tip: 'Download dictionaries for other languages', run: async (app) => { const { openDictionaryWizard } = await import('../ui/dictWizard'); await openDictionaryWizard(app); } },
  {
    id: 'review.statistics', label: 'Presentation Statistics', icon: 'analytics', tab: 'Review', group: 'Proofing', edits: false, noRecord: true,
    run: async (app) => { const st = deckStats(app); await openDialog({ title: 'Presentation Statistics', ok: 'Close', cancel: false, content: h('table', { class: 'ql-stats' }, ...Object.entries(st).map(([k, v]) => h('tr', null, h('td', null, k), h('td', null, v.toLocaleString())))) }); },
  },
  { id: 'review.checkAccessibility', label: 'Check Accessibility', icon: 'accessibility_new', tab: 'Review', group: 'Accessibility', edits: false, noRecord: true, run: (app) => app.ui.togglePane('accessibility'), isActive: (app) => app.ui.paneOpen('accessibility') },
  {
    id: 'review.altText', label: 'Alt Text', icon: 'image_search', tab: 'Review', group: 'Accessibility', edits: true, isEnabled: (app) => app.selected.length === 1,
    tip: 'Describe the selected object for people who cannot see it',
    run: async (app) => {
      const e = app.selected[0];
      const r = await openDialog({ title: 'Alt Text', fields: [{ key: 'alt', label: 'How would you describe this object and its context to someone who is blind?', type: 'textarea', rows: 4, value: e.alt || '' }, { key: 'dec', label: 'Mark as decorative', type: 'checkbox', value: !!e.decorative }] });
      if (!r) return;
      edit(app, 'Alt Text', (o) => { const x = o.elements.find((q) => q.id === e.id)!; x.alt = r.alt || undefined; x.decorative = r.dec || undefined; });
    },
  },
  { id: 'review.readingOrder', label: 'Reading Order Pane', icon: 'format_list_numbered', tab: 'Review', group: 'Accessibility', edits: false, noRecord: true, run: (app) => app.ui.togglePane('readingOrder'), isActive: (app) => app.ui.paneOpen('readingOrder') },
  { id: 'review.designCheck', label: 'Design Checker', icon: 'rule', tab: 'Review', group: 'Insights', edits: false, noRecord: true, origin: 'Harvard Graphics advisor; Tufte', run: (app) => app.ui.togglePane('designCheck'), isActive: (app) => app.ui.paneOpen('designCheck') },
  {
    id: 'review.lookUp', label: 'Look Up', icon: 'travel_explore', tab: 'Review', group: 'Insights', edits: false, noRecord: true,
    tip: 'Search the web for the selected text (opens your browser)',
    run: async (app) => {
      let q = (window.getSelection()?.toString() || '').trim();
      if (!q && app.selected[0]) q = shapeText(app.selected[0]).trim().split('\n')[0];
      if (!q) q = (await promptDialog('Look Up', 'Search for', '')) || '';
      if (!q) return;
      const { openExternal } = await import('../platform/native');
      openExternal(`https://duckduckgo.com/?q=${encodeURIComponent(q.slice(0, 200))}`);
    },
  },
  { id: 'review.translate', label: 'Translate', icon: 'g_translate', tab: 'Review', group: 'Language', edits: true, tip: 'Translate the selected text or slide with your AI provider', run: (app) => app.exec('ai.translate') },
  {
    id: 'review.language', label: 'Language', icon: 'language', tab: 'Review', group: 'Language', edits: true,
    tip: 'Set the proofing language of the selected text (or of the whole presentation)',
    run: async (app) => {
      const langs = ['en-US', 'en-GB', 'en-CA', 'en-AU', 'fr-FR', 'de-DE', 'es-ES', 'it-IT', 'pt-BR', 'pt-PT', 'nl-NL', 'sv-SE', 'da-DK', 'nb-NO', 'fi-FI', 'pl-PL', 'cs-CZ', 'ru-RU', 'uk-UA', 'el-GR', 'tr-TR', 'he-IL', 'ar-SA', 'ja-JP', 'zh-CN', 'ko-KR'];
      const r = await openDialog({ title: 'Language', fields: [{ key: 'lang', label: 'Mark text as', type: 'combo', options: langs, value: app.prefs.language }, { key: 'scope', label: 'Apply to', type: 'radio', options: [{ value: 'sel', label: 'Selected text or objects' }, { value: 'all', label: 'All text in the presentation' }], value: app.selected.length ? 'sel' : 'all' }, { key: 'def', label: 'Also make it the default for spelling', type: 'checkbox', value: true }] });
      if (!r) return;
      const lang = String(r.lang);
      if (r.scope === 'sel') { const { applyRun } = await import('../edit/ops'); applyRun(app, { lang }, 'Language'); }
      else app.deck.transact('Language', () => forEachText(app.deck.slides, (ps) => { for (const p of ps) for (const run of p.runs) run.lang = lang; }));
      if (r.def) { app.prefs.language = lang; app.savePrefs(); }
    },
  },
  {
    id: 'review.newComment', label: 'New Comment', icon: 'add_comment', tab: 'Review', group: 'Comments', keys: ['Mod-Alt-m'], edits: true, isEnabled: (app) => !!slideOf(app),
    run: async (app, text?: string) => {
      if (typeof text === 'string' && text) { addComment(app, text, app.selected[0]?.id); return; }
      app.ui.openPane('comments');
      setTimeout(() => (document.querySelector('.ql-pane textarea') as HTMLElement | null)?.focus(), 50);
    },
  },
  {
    id: 'review.deleteComment', label: 'Delete Comment', icon: 'comments_disabled', tab: 'Review', group: 'Comments', kind: 'menu', edits: true, isEnabled: (app) => allComments(app).length > 0,
    run: (app, which?: 'slide' | 'all') => {
      const d = app.deck;
      if (which === 'all') { d.transact('Delete All Comments', () => { for (const s of d.slides) delete s.comments; }, d.slides.map((s) => s.id)); return; }
      const s = slideOf(app);
      if (!s?.comments?.length) return;
      d.transact(which === 'slide' ? 'Delete Comments on Slide' : 'Delete Comment', () => { if (which === 'slide') delete s.comments; else { s.comments!.pop(); if (!s.comments!.length) delete s.comments; } }, [s.id]);
    },
    menu: () => [{ id: 'review.deleteComment', label: 'Delete Last Comment on Slide' }, { id: 'review.deleteSlideComments', label: 'Delete All Comments on Slide' }, { id: 'review.deleteAllComments', label: 'Delete All Comments in Presentation' }],
  },
  { id: 'review.deleteSlideComments', label: 'Delete All Comments on Slide', icon: 'comments_disabled', tab: 'Review', group: 'Comments', edits: true, isEnabled: (app) => !!slideOf(app)?.comments?.length, run: (app) => app.exec('review.deleteComment', 'slide') },
  { id: 'review.deleteAllComments', label: 'Delete All Comments in Presentation', icon: 'comments_disabled', tab: 'Review', group: 'Comments', edits: true, isEnabled: (app) => allComments(app).length > 0, run: async (app) => { if (await confirmDialog('Delete All Comments', 'Delete every comment in this presentation?', 'Delete')) app.exec('review.deleteComment', 'all'); } },
  { id: 'review.prevComment', label: 'Previous Comment', icon: 'navigate_before', tab: 'Review', group: 'Comments', edits: false, noRecord: true, run: (app) => stepComment(app, -1) },
  { id: 'review.nextComment', label: 'Next Comment', icon: 'navigate_next', tab: 'Review', group: 'Comments', edits: false, noRecord: true, run: (app) => stepComment(app, 1) },
  { id: 'review.commentsPane', label: 'Show Comments', icon: 'forum', tab: 'Review', group: 'Comments', edits: false, noRecord: true, run: (app) => app.ui.togglePane('comments'), isActive: (app) => app.ui.paneOpen('comments') },
  { id: 'review.compare', label: 'Compare', icon: 'compare', tab: 'Review', group: 'Compare', edits: true, tip: 'Compare with another version of this presentation and accept its changes slide by slide', run: (app) => compare(app) },
]);

