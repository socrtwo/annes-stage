/**
 * AI tab: setup, providers, several AIs, and the presentation features (draft a deck, rewrite text,
 * speaker notes, alt text, charts, quizzes, assistant). Only the text a command needs is sent, results
 * are previewed, and changes apply as one undoable step.
 */
import { def, type MenuEntry } from './registry';
import type { App } from '../app';
import type { ChartElement, Paragraph, PictureElement, ShapeElement, Slide, TableElement } from '../model/types';
import { newId } from '../model/deck';
import { aiSettings, saveAiSettings, resolveProvider } from '../ai/store';
import { providerById } from '../ai/providers';
import { chat, activeEnsemble, type ChatMessage, type ContentPart } from '../ai/client';
import { outcomeLine, type EnsembleMode } from '../ai/ensemble';
import { SLIDES_SYSTEM, TEXT_TASKS, addSlidePrompt, docToDeckPrompt, draftDeckPrompt, linesOf, outlineToSlidesPrompt, parseJsonLoose, parseOutline, parseQuiz, quizOutline, cleanText, type OutlineSlide } from '../ai/slides';
import { edit, shapeText, textTargets } from '../edit/ops';
import { openDialog, toast, confirmDialog, promptDialog } from '../ui/dialog';
import { h, pickFile } from '../ui/dom';
import { slideTitle } from '../render/slide';
import { titleShape, bodyShape, notesToText, textToNotes } from '../edit/workspace';
import { paraText } from '../edit/textEdit';

// ------------------------------------------------------------------------------------------
// Readiness, privacy, requests

const cloudId = (id: string) => { const p = providerById(id); return !!p && p.kind !== 'local' && p.kind !== 'builtin'; };
function aiRecipients(): string[] {
  const plan = activeEnsemble();
  if (!plan) { const a = aiSettings().active; return a ? [a] : []; }
  return [...new Set([...plan.members.map((m) => m.provider), plan.master.provider])];
}
const names = (ids: string[]) => { const n = ids.map((id) => providerById(id)?.name || id); return n.length < 2 ? n.join('') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`; };

export async function ensureAiReady(app: App, reason = 'This command needs an AI provider. Choose one below; free options, including one that runs on this device, are at the top.'): Promise<boolean> {
  const s = aiSettings();
  if (!s.enabled) { toast('AI features are turned off (AI ▸ AI Settings).', { action: 'Settings', onAction: () => app.exec('ai.settings') }); return false; }
  if (!(s.active && (await resolveProvider()))) {
    const { openAiSetup } = await import('../ui/aiWizard');
    if (!(await openAiSetup(app, { reason }))) return false;
  }
  const ids = aiRecipients().filter((id) => cloudId(id) && !aiSettings().privacyAck.includes(id));
  if (!ids.length) return true;
  const free = ids.some((id) => providerById(id)?.free === 'free');
  const ok = await confirmDialog('Sending Text to an AI Service', `AI commands send only the slide text they need directly from this device to ${names(ids)}. Anne\'s Stage has no server and keeps no copy. The service's terms and privacy policy apply${free ? ', and free tiers may use what you send to improve their models' : ''}. For confidential presentations, use the on-device model. Continue?`, 'Continue', 'Cancel');
  if (ok) saveAiSettings((x) => { for (const id of ids) if (!x.privacyAck.includes(id)) x.privacyAck.push(id); });
  return ok;
}

let controller: AbortController | null = null;

/** "Ask before sending a whole deck or long document": the size from which a whole-deck or document command asks first. */
export const LARGE_SEND_CHARS = 5000;

const promptChars = (p: string | ContentPart[]) => (typeof p === 'string' ? p.length : p.reduce((n, x) => n + (x.type === 'text' ? x.text.length : 0), 0));

/** AI Settings ▸ "Ask before sending a whole deck or long document": true when the command may go ahead. */
async function confirmLargeSend(prompt: string | ContentPart[], what: 'deck' | 'document'): Promise<boolean> {
  if (!aiSettings().confirmDocument) return true;
  const chars = promptChars(prompt);
  if (chars < LARGE_SEND_CHARS) return true;
  const cloud = aiRecipients().filter(cloudId);
  if (!cloud.length) return true;
  return confirmDialog('Send to a Cloud Service?',
    `This command sends ${what === 'deck' ? 'the text of the whole presentation' : 'the document'} (about ${chars.toLocaleString()} characters) to ${names(cloud)}.\nYou can turn this question off in AI ▸ AI Settings.`,
    'Send', 'Cancel');
}

function system(): string {
  const s = aiSettings();
  return [SLIDES_SYSTEM, s.language && s.language !== 'auto' ? `Write in ${s.language}.` : '', s.styleGuide ? `Style guide: ${s.styleGuide}` : ''].filter(Boolean).join('\n');
}

/** Sends a prompt and returns the answer text (with a status toast while waiting). */
export async function ask(app: App, prompt: string | ContentPart[], opts: { tier?: 'fast' | 'quality'; maxTokens?: number; /** A whole-deck or document command: may ask first (confirmDocument). */ whole?: 'deck' | 'document' } = {}): Promise<string | null> {
  if (!(await ensureAiReady(app))) return null;
  if (opts.whole && !(await confirmLargeSend(prompt, opts.whole))) return null;
  controller?.abort();
  controller = new AbortController();
  const ctl = controller;
  app.ui.status?.('● AI is working… (AI ▸ Stop AI to cancel)');
  try {
    const messages: ChatMessage[] = [{ role: 'system', content: system() }, { role: 'user', content: prompt }];
    const r = await chat({ messages, tier: opts.tier || 'quality', maxTokens: opts.maxTokens || 2000, signal: ctl.signal, onStatus: (t) => app.ui.status?.(`● ${t}`) });
    if (r.ensemble && aiSettings().ensemble.showDeliberation) toast(outcomeLine(r.ensemble, (id) => providerById(id)?.name || id), { ms: 8000 });
    if (r.truncated) toast('The AI answer was cut short; the result may be incomplete.');
    return r.text;
  } catch (e: any) {
    if (e?.code === 'aborted' || ctl.signal.aborted) toast('AI stopped.');
    else toast(`AI: ${e?.message || e}`, { ms: 7000 });
    return null;
  } finally {
    if (controller === ctl) controller = null;
    app.ui.status?.('');
  }
}

async function previewText(title: string, text: string, ok = 'Apply'): Promise<string | null> {
  const r = await openDialog({ title, wide: true, ok, fields: [{ key: 't', label: 'Result (you can edit it before applying)', type: 'textarea', rows: Math.min(18, Math.max(5, text.split('\n').length + 1)), value: text }] });
  return r ? String(r.t) : null;
}

// ------------------------------------------------------------------------------------------
// Building slides

function deckContext(app: App, max = 30): string {
  return app.deck.slides.slice(0, max).map((s, i) => `${i + 1}. ${slideTitle(s) || '(untitled)'}`).join('; ');
}

function deckText(app: App, maxChars = 24000): string {
  const out: string[] = [];
  app.deck.slides.forEach((s, i) => {
    if (s.hidden) return;
    const body = s.elements.filter((e) => e !== titleShape(s)).map(shapeText).filter(Boolean).join('\n');
    out.push(`Slide ${i + 1}: ${slideTitle(s)}\n${body}${s.notes.length ? `\nNotes: ${notesToText(s.notes)}` : ''}`);
  });
  return out.join('\n\n').slice(0, maxChars);
}

function paraLines(lines: string[]): Paragraph[] {
  return lines.map((l) => { const m = /^( *)/.exec(l)![1].length; return { level: Math.min(4, Math.floor(m / 2)), runs: [{ text: l.trim() }] }; });
}

/** Makes slides from an outline; the first may become a title slide. */
export function slidesFromOutline(app: App, outline: OutlineSlide[], opts: { titleSlide?: boolean } = {}): Slide[] {
  const d = app.deck;
  const titleLay = d.layoutByType('title') || d.data.layouts[0];
  const objLay = d.layoutByType('obj') || d.data.layouts[1] || d.data.layouts[0];
  return outline.map((o, i) => {
    const s = d.makeSlide((i === 0 && opts.titleSlide ? titleLay : objLay).id);
    const t = titleShape(s);
    if (t) t.text = { ...(t.text || {}), paras: [{ level: 0, runs: [{ text: o.title }] }] };
    const b = bodyShape(s);
    if (b && o.bullets.length) b.text = { ...(b.text || {}), paras: paraLines(o.bullets) };
    if (o.notes) s.notes = textToNotes(o.notes);
    return s;
  });
}

/** A slide with nothing on it, or only placeholders with no text (the blank slide of a new deck). */
function isBlankSlide(s: Slide): boolean {
  return s.elements.every((e) => !!(e as ShapeElement).ph && e.kind === 'shape' && !shapeText(e).trim()) && !notesToText(s.notes).trim();
}

async function addOutlineSlides(app: App, outline: OutlineSlide[], label: string, titleSlide = false, newDeck = false): Promise<void> {
  if (!outline.length) { toast('The AI answer had no slides in it.'); return; }
  const preview = outline.map((o, i) => `${i + 1}. ${o.title}\n${o.bullets.map((b) => `   • ${b.trim()}`).join('\n')}`).join('\n');
  const ok = await previewText(`${label}: ${outline.length} slide(s)`, preview, newDeck ? 'Create Presentation' : 'Insert Slides');
  if (ok == null) return;
  const edited = ok !== preview ? parseOutline(ok.replace(/^\s*\d+\.\s+/gm, '## ').replace(/^\s*•\s*/gm, '- ')) : outline;
  if (newDeck) {
    app.createTab();
    const d = app.deck;
    d.transact(label, () => { d.data.slides = slidesFromOutline(app, edited, { titleSlide }); });
    app.tab.current = d.slides[0]?.id || '';
    app.tab.ui.layout();
    return;
  }
  const d = app.deck;
  const slides = slidesFromOutline(app, edited, { titleSlide });
  d.transact(label, () => { const at = Math.max(-1, d.slideIndex(app.tab.current)) + 1; d.data.slides.splice(at, 0, ...slides); });
  app.goToSlide(slides[0].id);
}

// ------------------------------------------------------------------------------------------
// Text features

/** The text a writing command works on: selected text being edited, the selected shapes, or the current slide's body. */
function textInput(app: App): { text: string; apply: (lines: string[], label: string) => void } | null {
  const ed = (window as any).__qsTextEditor;
  if (app.tab.ui.editingText && ed?.selectedText?.()) {
    const t = ed.selectedText();
    return { text: t, apply: (lines) => document.execCommand('insertText', false, lines.join('\n')) };
  }
  let shapes = textTargets(app).filter((s) => s.text?.paras.some((p) => paraText(p).trim()));
  if (!shapes.length && app.slide) { const b = bodyShape(app.slide); if (b?.text?.paras.some((p) => paraText(p).trim())) shapes = [b]; }
  if (!shapes.length) return null;
  const s = shapes[0];
  return {
    text: s.text!.paras.map((p) => '  '.repeat(p.level) + paraText(p)).join('\n'),
    apply: (lines, label) => edit(app, label, (o) => {
      const t = o.elements.find((e) => e.id === s.id) as ShapeElement;
      const first = t.text!.paras[0]?.runs[0] || {};
      const { text: _x, ...fmt } = first as any;
      t.text = { ...t.text!, paras: lines.map((l) => { const m = /^( *)/.exec(l)![1].length; return { ...(t.text!.paras[0] ? { ...t.text!.paras[0], runs: [] } : {}), level: Math.min(8, Math.floor(m / 2)), runs: [{ ...fmt, text: l.trim() }] } as Paragraph; }) };
    }),
  };
}

async function textTask(app: App, key: keyof typeof TEXT_TASKS, arg?: string): Promise<void> {
  const inp = textInput(app);
  if (!inp) { toast('Select some text or a text box first.'); return; }
  const task = TEXT_TASKS[key];
  if (key === 'tone' && !arg) {
    const r = await openDialog({ title: 'Change Tone', fields: [{ key: 't', label: 'Tone', type: 'combo', options: ['more formal', 'more casual', 'more persuasive', 'more confident', 'friendlier', 'simpler (plain language)', 'more technical'], value: 'more formal' }] });
    if (!r) return; arg = r.t;
  }
  if (key === 'translate' && !arg) {
    const r = await openDialog({ title: 'Translate', fields: [{ key: 'l', label: 'Into', type: 'combo', options: ['English', 'Spanish', 'French', 'German', 'Italian', 'Portuguese', 'Dutch', 'Polish', 'Russian', 'Ukrainian', 'Chinese (Simplified)', 'Japanese', 'Korean', 'Arabic', 'Hebrew', 'Hindi', 'Turkish', 'Greek', 'Swedish'], value: 'Spanish' }] });
    if (!r) return; arg = r.l;
  }
  const ans = await ask(app, task.prompt(inp.text, arg));
  if (ans == null) return;
  const lines = key === 'assertionHeadline' ? [cleanText(ans).split('\n')[0]] : cleanText(ans).split(/\r?\n/).filter((l) => l.trim()).map((l) => l.replace(/^(\s*)(?:[-*•]|\d+[.)])\s+/, '$1'));
  const out = await previewText(task.label, lines.join('\n'));
  if (out == null) return;
  const final = out.split('\n').filter((l) => l.trim());
  if (key === 'assertionHeadline' && app.slide) {
    const t = titleShape(app.slide);
    if (t) { edit(app, task.label, (o) => { const x = o.elements.find((e) => e.id === t.id) as ShapeElement; x.text = { ...(x.text || {}), paras: [{ level: 0, runs: [{ text: final.join(' ') }] }] }; }); return; }
  }
  inp.apply(final, task.label);
}

async function notesTask(app: App, key: 'writeNotes' | 'notesToSlide' | 'slideToNotes'): Promise<void> {
  const s = app.slide;
  if (!s) return;
  const slideText = [slideTitle(s), ...s.elements.filter((e) => e !== titleShape(s)).map(shapeText)].filter(Boolean).join('\n');
  const src = key === 'notesToSlide' ? notesToText(s.notes) : slideText;
  if (!src.trim()) { toast(key === 'notesToSlide' ? 'This slide has no speaker notes.' : 'This slide has no text.'); return; }
  const ans = await ask(app, TEXT_TASKS[key].prompt(src));
  if (ans == null) return;
  const out = await previewText(TEXT_TASKS[key].label, key === 'notesToSlide' ? linesOf(ans).join('\n') : cleanText(ans));
  if (out == null) return;
  app.deck.transact(TEXT_TASKS[key].label, () => {
    if (key === 'notesToSlide') {
      let b = bodyShape(s);
      if (!b) { b = { id: newId('sp'), kind: 'shape', geom: 'rect', ph: { type: 'body', idx: 1 }, text: { paras: [] } } as ShapeElement; s.elements.push(b); }
      b.text = { ...(b.text || {}), paras: paraLines(out.split('\n').filter((l) => l.trim())) };
    } else s.notes = textToNotes(out);
  }, [s.id]);
}

// ------------------------------------------------------------------------------------------

const ENSEMBLE_MODES: { value: EnsembleMode; label: string }[] = [
  { value: 'single', label: 'Single AI' },
  { value: 'master', label: 'Master Combines Answers' },
  { value: 'consensus', label: 'Quaker Consensus' },
];

async function setEnsembleMode(app: App, mode?: string): Promise<void> {
  const pick = ENSEMBLE_MODES.find((o) => o.value === mode);
  const { openAiSettings } = await import('../ui/aiWizard');
  if (!pick) { await openAiSettings(app, { section: 'ensemble' }); return; }
  if (pick.value !== 'single' && Object.keys(aiSettings().providers).length < 2) {
    toast('Set up at least two AI providers to use several AIs.', { action: 'Set Up AI', onAction: () => app.exec('ai.setup'), ms: 7000 });
    return;
  }
  saveAiSettings((s) => { s.ensemble.mode = pick.value; });
  if (pick.value !== 'single' && (aiSettings().ensemble.members?.length || 0) < 2) await openAiSettings(app, { section: 'ensemble', mode: pick.value });
  app.ui.refresh?.();
  toast(pick.value === 'single' ? 'AI: one AI answers (the active provider)' : `AI: ${pick.label}`);
}

const esc = (t: string) => t.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));

def([
  {
    id: 'ai.setup', label: 'Set Up AI', icon: 'auto_awesome', tab: 'AI', group: 'Setup', popular: true, noRecord: true, edits: false,
    tip: 'Choose a free or paid AI: on this device, free cloud tiers, your own computer, or a paid key', keywords: 'api key openai anthropic gemini mistral groq openrouter ollama wizard',
    run: async (app) => { const { openAiSetup } = await import('../ui/aiWizard'); await openAiSetup(app); },
  },
  { id: 'ai.providers', label: 'Providers & Models', icon: 'tune', tab: 'AI', group: 'Setup', noRecord: true, edits: false, tip: 'Switch AI provider, choose models, test or remove keys', run: async (app) => { const { openAiProviders } = await import('../ui/aiWizard'); await openAiProviders(app); } },
  {
    id: 'ai.active', label: 'Active AI', icon: 'swap_horiz', tab: 'AI', group: 'Setup', kind: 'menu', noRecord: true, edits: false, tip: 'Switch between the AI providers you have set up',
    run: async (app, id?: string) => {
      if (!id) { const { openAiProviders } = await import('../ui/aiWizard'); await openAiProviders(app); return; }
      if (!aiSettings().providers[id]) return;
      saveAiSettings((s) => { s.active = id; });
      toast(`AI: ${providerById(id)?.name}`);
    },
    menu: () => { const s = aiSettings(); const items: MenuEntry[] = Object.keys(s.providers).map((id) => ({ id: 'ai.active', arg: id, label: `${providerById(id)?.name || id} · ${s.providers[id].model}`, checked: s.active === id })); return [...items, ...(items.length ? [{ separator: true }] : []), { id: 'ai.setup', label: 'Add a Provider…' }]; },
  },
  { id: 'ai.settings', label: 'AI Settings', icon: 'settings_suggest', tab: 'AI', group: 'Setup', noRecord: true, edits: false, tip: 'Turn AI on or off, language for generated text, style guide, usage', run: async (app) => { const { openAiSettings } = await import('../ui/aiWizard'); await openAiSettings(app); } },
  {
    id: 'ai.privacy', label: 'AI & Privacy', icon: 'shield', tab: 'AI', group: 'Setup', noRecord: true, edits: false, tip: 'Where your text goes when you use AI',
    run: async () => {
      const p = providerById(aiSettings().active || '');
      await openDialog({ title: 'AI & Privacy', ok: 'Close', cancel: false, fields: [{ key: 'i', type: 'info', html: [
        '<p><b>Anne\'s Stage has no server.</b> AI requests go directly from this device to the provider you choose, using your own key. Nothing is sent until you run an AI command.</p>',
        `<p><b>Active provider:</b> ${p ? esc(p.name) : 'none'}${p && (p.kind === 'local' || p.kind === 'builtin') ? ' — runs on this device; your presentation does not leave it.' : p ? ' — the text a command needs (the selection, the slide, or the deck\'s text for whole-deck commands) is sent to this service; its terms apply.' : ''}</p>`,
        activeEnsemble() ? `<p><b>Several AIs are on.</b> Each AI command sends the same text to every one of these services: ${esc(names(aiRecipients()))}.</p>` : '',
        '<p><b>Pictures</b> are sent only by Generate Alt Text, and only the selected picture.</p>',
        '<p><b>Keys</b> are stored on this device only. They are never placed in presentations, drafts or exported settings.</p>',
        '<p><b>Changes are previewed</b> and applied as one step you can undo.</p>',
      ].join('') }] });
    },
  },
  { id: 'ai.stop', label: 'Stop AI', icon: 'stop_circle', tab: 'AI', group: 'Setup', noRecord: true, edits: false, isEnabled: () => !!controller, tip: 'Stop the AI request in progress', run: () => { controller?.abort(); controller = null; } },
  {
    id: 'ai.deleteModels', label: 'Delete Downloaded Models', icon: 'delete_sweep', tab: 'AI', group: 'Setup', noRecord: true, edits: false, tip: 'Free the storage used by the on-device AI model',
    run: async () => { const { clearLocalModels, localStorageEstimate } = await import('../ai/local'); if (!(await confirmDialog('Delete Downloaded Models', `Delete the on-device AI model files? (${await localStorageEstimate()}). They download again the next time you use the on-device model.`, 'Delete'))) return; const n = await clearLocalModels(); toast(`Deleted ${n} cached file(s).`); },
  },
  {
    id: 'ai.ensembleMode', label: 'Several AIs', icon: 'groups', tab: 'AI', group: 'Several AIs', kind: 'menu', edits: false,
    tip: 'Ask one AI, or several at once: one AI combines their answers (master), or they deliberate until they agree (Quaker consensus)',
    run: (app, mode?: string) => setEnsembleMode(app, mode),
    menu: () => { const e = aiSettings().ensemble; return [...ENSEMBLE_MODES.map((o) => ({ id: 'ai.ensembleMode', arg: o.value, label: o.label, checked: e.mode === o.value })), { separator: true }, { id: 'ai.ensembleMembers', label: 'Choose AIs…' }, { id: 'ai.showDeliberation', label: 'Show AI Discussion', checked: e.showDeliberation }]; },
    isActive: () => aiSettings().ensemble.mode !== 'single',
  },
  { id: 'ai.ensembleMembers', label: 'Choose AIs', icon: 'checklist', tab: 'AI', group: 'Several AIs', noRecord: true, edits: false, tip: 'Choose which AIs answer together, the master or clerk, and the rounds of discussion', run: async (app) => { const { openAiSettings } = await import('../ui/aiWizard'); await openAiSettings(app, { section: 'ensemble' }); } },
  { id: 'ai.showDeliberation', label: 'Show AI Discussion', icon: 'forum', tab: 'AI', group: 'Several AIs', kind: 'toggle', edits: false, tip: 'Show the outcome of the discussion when several AIs answer', run: (app, on?: boolean) => { saveAiSettings((s) => { s.ensemble.showDeliberation = typeof on === 'boolean' ? on : !s.ensemble.showDeliberation; }); app.ui.refresh?.(); }, isActive: () => aiSettings().ensemble.showDeliberation },

  {
    id: 'ai.draftDeck', label: 'Draft Presentation', icon: 'auto_awesome_motion', tab: 'AI', group: 'Create', edits: true, popular: true, origin: 'Tome, Gamma',
    tip: 'Describe a topic; the AI writes an outline you review, then Anne\'s Stage builds the slides',
    run: async (app) => {
      const r = await openDialog({ title: 'Draft Presentation', fields: [
        { key: 'topic', label: 'Topic or purpose', type: 'textarea', rows: 3, value: '' },
        { key: 'n', label: 'About how many slides', type: 'number', value: 8, min: 2, max: 40 },
        { key: 'aud', label: 'Audience', type: 'text', value: '' },
        { key: 'tone', label: 'Tone', type: 'combo', options: ['clear and professional', 'friendly', 'persuasive', 'academic', 'inspirational'], value: 'clear and professional' },
        { key: 'where', label: 'Put the slides', type: 'radio', options: [{ value: 'new', label: 'In a new presentation' }, { value: 'here', label: 'After the current slide' }], value: app.deck.slides.length > 1 ? 'new' : 'here' },
      ] });
      if (!r || !String(r.topic).trim()) return;
      const ans = await ask(app, draftDeckPrompt(r.topic, +r.n || 8, r.aud, r.tone), { maxTokens: 4000 });
      if (ans == null) return;
      if (r.where === 'here' && app.deck.slides.length === 1 && !slideTitle(app.deck.slides[0])) {
        const outline = parseOutline(ans);
        const d = app.deck;
        // Only the one blank slide the deck started with is removed, and only if it is still blank.
        const originalId = d.slides[0].id;
        const before = d.slides.length;
        await addOutlineSlides(app, outline, 'Draft Presentation', true);
        const orig = d.slides.find((s) => s.id === originalId);
        if (orig && d.slides.length > before && isBlankSlide(orig)) d.transact('Remove Empty Slide', () => { d.data.slides = d.data.slides.filter((s) => s.id !== originalId); });
        return;
      }
      await addOutlineSlides(app, parseOutline(ans), 'Draft Presentation', true, r.where === 'new');
    },
  },
  {
    id: 'ai.docToDeck', label: 'Document to Deck', icon: 'article', tab: 'AI', group: 'Create', edits: true, origin: 'Gamma',
    tip: 'Turn a document (.txt, .md, .docx, .odt, .rtf, .html) into slides',
    run: async (app) => {
      const f = (await pickFile('.txt,.md,.markdown,.docx,.odt,.rtf,.html,.htm'))[0];
      if (!f) return;
      let text = '';
      const bytes = new Uint8Array(await f.arrayBuffer());
      if (/\.(txt|md|markdown|html?|rtf)$/i.test(f.name)) {
        text = new TextDecoder().decode(bytes);
        if (/\.html?$/i.test(f.name)) text = new DOMParser().parseFromString(text, 'text/html').body.textContent || '';
        if (/\.rtf$/i.test(f.name)) text = text.replace(/\\par[d]?/g, '\n').replace(/\{\\\*[^}]*\}|\\[a-z]+-?\d* ?|[{}]/gi, '');
      } else {
        const { importDeck } = await import('../io');
        const src = (await importDeck(bytes, f.name)).deck;
        text = src.slides.map((s) => [slideTitle(s), ...s.elements.map(shapeText)].join('\n')).join('\n\n');
      }
      text = text.trim();
      if (!text) { toast('That file has no text.'); return; }
      if (text.length > 60000) { text = text.slice(0, 60000); toast('The document is long; only its first 60,000 characters are used.'); }
      const n = Math.max(4, Math.min(30, Math.round(text.split(/\s+/).length / 180)));
      const ans = await ask(app, docToDeckPrompt(text, n), { maxTokens: 6000, whole: 'document' });
      if (ans != null) await addOutlineSlides(app, parseOutline(ans), 'Document to Deck', true, true);
    },
  },
  {
    id: 'ai.outlineToSlides', label: 'Outline to Slides', icon: 'format_list_bulleted_add', tab: 'AI', group: 'Create', edits: true,
    tip: 'Paste notes or an outline (or select a text box); the AI groups it into slides',
    run: async (app) => {
      const sel = textTargets(app)[0];
      const r = await openDialog({ title: 'Outline to Slides', wide: true, fields: [{ key: 't', label: 'Notes or outline', type: 'textarea', rows: 12, value: sel ? shapeText(sel) : '' }] });
      if (!r || !String(r.t).trim()) return;
      const ans = await ask(app, outlineToSlidesPrompt(r.t), { maxTokens: 4000 });
      if (ans != null) await addOutlineSlides(app, parseOutline(ans), 'Outline to Slides');
    },
  },
  {
    id: 'ai.addSlide', label: 'Add Slide About', icon: 'add_circle', tab: 'AI', group: 'Create', edits: true,
    run: async (app) => {
      const topic = await promptDialog('Add Slide About…', 'What should the slide be about?', '');
      if (!topic) return;
      const ans = await ask(app, addSlidePrompt(topic, deckContext(app)));
      if (ans != null) await addOutlineSlides(app, parseOutline(ans).slice(0, 1), 'Add Slide About');
    },
  },
  ...(['rewrite', 'shorten', 'expand', 'tone', 'assertionHeadline', 'proofread', 'translate'] as const).map((k) => ({
    id: `ai.${k}`, label: TEXT_TASKS[k].label, icon: ({ rewrite: 'edit_note', shorten: 'compress', expand: 'expand', tone: 'theater_comedy', assertionHeadline: 'title', proofread: 'spellcheck', translate: 'g_translate' } as Record<string, string>)[k],
    tab: 'AI', group: 'Write', edits: true, ...(k === 'assertionHeadline' ? { origin: 'Assertion–evidence slides' } : {}),
    tip: k === 'assertionHeadline' ? 'Replace the slide title with one sentence stating the point the bullets support' : `${TEXT_TASKS[k].label} the selected text, text box, or the slide's body text`,
    run: (app: App, arg?: string) => textTask(app, k, arg),
  })),
  { id: 'ai.writeNotes', label: 'Write Speaker Notes', icon: 'speaker_notes', tab: 'AI', group: 'Notes', edits: true, isEnabled: (app) => !!app.slide, run: (app) => notesTask(app, 'writeNotes') },
  { id: 'ai.notesToSlide', label: 'Notes to Slide Text', icon: 'notes', tab: 'AI', group: 'Notes', edits: true, isEnabled: (app) => !!app.slide, run: (app) => notesTask(app, 'notesToSlide') },
  { id: 'ai.slideToNotes', label: 'Slide Text to Notes', icon: 'sticky_note_2', tab: 'AI', group: 'Notes', edits: true, isEnabled: (app) => !!app.slide, run: (app) => notesTask(app, 'slideToNotes') },
  {
    id: 'ai.summarize', label: 'Summarize Deck', icon: 'summarize', tab: 'AI', group: 'Notes', edits: true, isEnabled: (app) => app.deck.slides.length > 1,
    tip: 'Add a summary slide at the end',
    run: async (app) => {
      const ans = await ask(app, TEXT_TASKS.summarize.prompt(deckText(app)), { whole: 'deck' });
      if (ans == null) return;
      const out = await previewText('Summary Slide', linesOf(ans).join('\n'), 'Add Summary Slide');
      if (out == null) return;
      const s = slidesFromOutline(app, [{ title: 'Summary', bullets: out.split('\n').filter((l) => l.trim()) }])[0];
      app.deck.transact('Summarize Deck', () => app.deck.data.slides.push(s));
      app.goToSlide(s.id);
    },
  },
  {
    id: 'ai.anticipateQuestions', label: 'Anticipate Questions', icon: 'contact_support', tab: 'AI', group: 'Notes', edits: false, isEnabled: (app) => app.deck.slides.length > 0,
    tip: 'Questions the audience is likely to ask, with suggested answers (added to the last slide\'s notes if you choose)',
    run: async (app) => {
      const ans = await ask(app, TEXT_TASKS.anticipateQuestions.prompt(deckText(app)), { whole: 'deck' });
      if (ans == null) return;
      const r = await openDialog({ title: 'Anticipated Questions', wide: true, ok: 'Add to Last Slide\'s Notes', cancel: 'Close', fields: [{ key: 't', type: 'textarea', rows: 16, value: cleanText(ans), label: 'Questions and answers' }] });
      if (!r) return;
      const last = app.deck.slides[app.deck.slides.length - 1];
      app.deck.transact('Anticipated Questions', () => { last.notes = [...last.notes, { level: 0, runs: [{ text: 'Anticipated questions:' }] }, ...textToNotes(String(r.t))]; }, [last.id]);
    },
  },
  {
    id: 'ai.altText', label: 'Generate Alt Text', icon: 'image_search', tab: 'AI', group: 'More', edits: true, isEnabled: (app) => app.selected.length === 1 && ['picture', 'chart', 'shape', 'group'].includes(app.selected[0].kind),
    tip: 'Describe the selected picture (the picture itself is sent; models without vision use its name and the slide text)',
    run: async (app) => {
      const e = app.selected[0];
      const s = app.slide;
      const ctx = `slide title "${s ? slideTitle(s) : ''}"; object name "${e.name || ''}"`;
      let content: string | ContentPart[] = TEXT_TASKS.altText.prompt(ctx);
      if (e.kind === 'picture') content = [{ type: 'text', text: TEXT_TASKS.altText.prompt(ctx) }, { type: 'image', dataUrl: app.deck.mediaUrl((e as PictureElement).media) }];
      else if (e.kind === 'chart') { const c = (e as ChartElement).chart; content = TEXT_TASKS.altText.prompt(`${ctx}; it is a ${c.type} chart titled "${c.title || ''}" of ${c.series.map((x) => x.name).join(', ')} across ${c.categories.join(', ')}`); }
      const ans = await ask(app, content, { tier: 'fast', maxTokens: 200 });
      if (ans == null) return;
      const out = await previewText('Alt Text', cleanText(ans).replace(/^"|"$/g, ''));
      if (out == null) return;
      edit(app, 'Alt Text', (o) => { const x = o.elements.find((q) => q.id === e.id); if (x) x.alt = out.trim(); });
    },
  },
  {
    id: 'ai.suggestChart', label: 'Suggest Chart from Data', icon: 'insights', tab: 'AI', group: 'More', edits: true, isEnabled: (app) => app.selected.length === 1 && app.selected[0].kind === 'table',
    tip: 'Make a chart from the selected table; the AI chooses the chart type',
    run: async (app) => {
      const t = app.selected[0] as TableElement;
      const rows = t.rows.map((r) => r.cells.map((c) => c.text.paras.map(paraText).join(' ').trim()));
      const tsv = rows.map((r) => r.join('\t')).join('\n');
      const ans = await ask(app, TEXT_TASKS.suggestChart.prompt(tsv), { tier: 'fast', maxTokens: 200 });
      if (ans == null) return;
      const spec = parseJsonLoose<{ type?: string; title?: string }>(ans) || {};
      const { parseTsv } = await import('./insert');
      const { categories, series } = parseTsv(tsv);
      if (!series.length) { toast('The table needs a header row and numbers.'); return; }
      const type = (['column', 'bar', 'line', 'pie', 'area', 'scatter'].includes(spec.type || '') ? spec.type : 'column') as ChartElement['chart']['type'];
      const b = { x: (t.x ?? 0), y: (t.y ?? 0), w: t.w ?? 400, h: Math.max(200, t.h ?? 200) };
      const el: ChartElement = { id: newId('cht'), kind: 'chart', name: 'Chart', x: b.x + 24, y: b.y + 24, w: b.w, h: b.h, chart: { type, title: spec.title, categories, series, legend: 'b' } };
      edit(app, 'Suggest Chart', (o) => { o.elements.push(el); });
      app.tab.ui.select([el.id]);
    },
  },
  {
    id: 'ai.quizFromDeck', label: 'Generate Quiz from Deck', icon: 'quiz', tab: 'AI', group: 'More', edits: true, isEnabled: (app) => app.deck.slides.length > 0,
    tip: 'Add question slides (answers in the speaker notes) at the end',
    run: async (app) => {
      const ans = await ask(app, TEXT_TASKS.quizFromDeck.prompt(deckText(app)), { maxTokens: 2500, whole: 'deck' });
      if (ans == null) return;
      try {
        const qs = parseQuiz(ans);
        if (!qs.length) { toast('The AI answer was not a list of questions.'); return; }
        const slides = slidesFromOutline(app, quizOutline(qs));
        app.deck.transact('Generate Quiz', () => app.deck.data.slides.push(...slides));
        app.goToSlide(slides[0].id);
      } catch (e: any) {
        toast(`Generate Quiz: the questions could not be added (${e?.message || e}).`, { ms: 7000 });
      }
    },
  },
  {
    id: 'ai.assistant', label: 'AI Assistant', icon: 'chat', tab: 'AI', group: 'More', edits: false, noRecord: true,
    tip: 'Ask questions about this presentation (its text is sent with your question)',
    run: async (app) => {
      const log = h('div', { class: 'ql-ai-log', style: 'max-height:45vh;overflow:auto;white-space:pre-wrap;min-width:min(80vw,640px)' });
      const history: ChatMessage[] = [];
      const ctx = deckText(app, 16000);
      for (;;) {
        const r = await openDialog({ title: 'AI Assistant', wide: true, content: log, ok: 'Ask', cancel: 'Close', fields: [{ key: 'q', label: 'Your question', type: 'textarea', rows: 3, value: '' }] });
        if (!r || !String(r.q).trim()) return;
        const q = String(r.q).trim();
        const prompt = history.length ? q : `Presentation text:\n"""\n${ctx}\n"""\n\nQuestion: ${q}`;
        const ans = await ask(app, history.length ? [{ type: 'text', text: `${history.map((m) => `${m.role === 'user' ? 'Q' : 'A'}: ${typeof m.content === 'string' ? m.content : ''}`).join('\n')}\nQ: ${prompt}` }] : prompt, history.length ? {} : { whole: 'deck' });
        if (ans == null) return;
        history.push({ role: 'user', content: prompt }, { role: 'assistant', content: ans });
        log.append(h('p', null, h('b', null, 'You: '), q), h('p', null, h('b', null, 'AI: '), cleanText(ans)));
      }
    },
  },
  {
    id: 'ai.prompts', label: 'Prompt Library', icon: 'library_books', tab: 'AI', group: 'More', kind: 'menu', edits: true,
    tip: 'Run one of your saved prompts on the selected text',
    run: async (app, id?: string) => {
      const s = aiSettings();
      if (id === '__new') {
        const r = await openDialog({ title: 'New Prompt', fields: [{ key: 'name', label: 'Name', type: 'text', value: '' }, { key: 'prompt', label: 'Prompt (the selected text is added after it)', type: 'textarea', rows: 5, value: '' }] });
        if (!r?.name || !r.prompt) return;
        saveAiSettings((x) => { x.prompts.push({ id: newId('pr'), name: r.name, prompt: r.prompt, input: 'selection', output: 'replace' } as any); });
        return;
      }
      const p = s.prompts.find((x) => x.id === id);
      if (!p) return;
      const inp = textInput(app);
      if (!inp && p.input === 'selection') { toast('Select some text or a text box first.'); return; }
      const ans = await ask(app, `${p.prompt}\n"""\n${p.input === 'document' ? deckText(app) : inp?.text || ''}\n"""`, p.input === 'document' ? { whole: 'deck' } : {});
      if (ans == null) return;
      const out = await previewText(p.name, cleanText(ans), inp ? 'Replace Selection' : 'Close');
      if (out != null && inp) inp.apply(out.split('\n'), p.name);
    },
    menu: () => [...aiSettings().prompts.map((p) => ({ id: 'ai.prompts', arg: p.id, label: p.name })), ...(aiSettings().prompts.length ? [{ separator: true }] : []), { id: 'ai.prompts', arg: '__new', label: 'New Prompt…' }],
  },
]);

