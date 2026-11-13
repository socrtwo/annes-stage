/**
 * Printing: slides, handouts (1–9 per page, with frames), notes pages and the outline, printed from
 * the renderer's SVG so the result is vector ("Save as PDF" in the print dialog gives a vector PDF).
 * The pages are placed in a print-only container in this document, so the system print service on
 * Android and the desktop prints them too.
 */
import type { App } from '../app';
import type { Deck } from '../model/deck';
import type { Slide } from '../model/types';
import { slideSvg } from '../render/slide';
import { buildSteps, stateAt } from '../render/animate';
import { slideOutline } from './outline';
import { printDocument } from '../platform/native';
import { openDialog } from '../ui/dialog';

export interface PrintOptions {
  what: 'slides' | 'handouts' | 'notes' | 'outline';
  perPage?: number;
  frame?: boolean;
  grayscale?: boolean;
  /** Include hidden slides. */
  hidden?: boolean;
  /** Slide numbers, such as "1-3, 5, 8". Empty = all. */
  range?: string;
  /** One page per build step (slides). */
  buildSteps?: boolean;
  paper?: 'letter' | 'a4';
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Parses "1-3, 5" into 1-based slide numbers; empty or invalid parts are ignored. */
export function parseRange(range: string | undefined, count: number): Set<number> | null {
  if (!range || !range.trim()) return null;
  const out = new Set<number>();
  for (const part of range.split(/[,;]/)) {
    const m = /^\s*(\d+)\s*(?:[-–]\s*(\d+)\s*)?$/.exec(part);
    if (!m) continue;
    const a = +m[1], b = m[2] ? +m[2] : a;
    for (let i = Math.max(1, Math.min(a, b)); i <= Math.min(count, Math.max(a, b)); i++) out.add(i);
  }
  return out;
}

function chosenSlides(deck: Deck, o: PrintOptions): Slide[] {
  const r = parseRange(o.range, deck.slides.length);
  return deck.slides.filter((s, i) => (o.hidden || !s.hidden) && (!r || r.has(i + 1)));
}

const PAPER_CSS = { letter: ['8.5in', '11in'], a4: ['210mm', '297mm'] } as const;

/** The pages to print as HTML (each page a .qs-pp-page) plus the @page size CSS. */
export function printPages(deck: Deck, o: PrintOptions): { css: string; pages: string[] } {
  const slides = chosenSlides(deck, o);
  const { w, h } = deck.size;
  const num = (s: Slide) => deck.slideIndex(s.id) + (deck.data.firstNumber ?? 1);
  const svg = (s: Slide, step?: number) => {
    const st = stateAt(s, step ?? buildSteps(s).length);
    return slideSvg(deck, s, { mode: 'print', hide: st.hide, paraVisible: st.paraVisible, number: num(s), grayscale: o.grayscale });
  };
  const [pw, ph] = PAPER_CSS[o.paper || 'letter'];
  const pages: string[] = [];
  let css: string;
  if (o.what === 'slides') {
    css = `@page { size: ${w}pt ${h}pt; margin: 0 } .qs-pp-page { width: ${w}pt; height: ${h}pt }`;
    for (const s of slides) {
      const steps = o.buildSteps ? Math.max(1, buildSteps(s).length) : 1;
      for (let k = 1; k <= steps; k++) pages.push(`<div class="qs-pp-page qs-pp-slide">${svg(s, o.buildSteps ? k : undefined)}</div>`);
    }
  } else if (o.what === 'handouts') {
    const per = [1, 2, 3, 4, 6, 9].includes(o.perPage || 0) ? o.perPage! : 6;
    const cols = per === 4 || per === 6 ? 2 : per === 9 ? 3 : 1;
    css = `@page { size: ${pw} ${ph}; margin: 0.5in } .qs-pp-page { width: calc(${pw} - 1in); height: calc(${ph} - 1in) }
      .qs-pp-handout { display: grid; grid-template-columns: ${per === 3 ? '1fr 1fr' : `repeat(${cols}, 1fr)`}; grid-auto-rows: 1fr; gap: 0.25in; align-items: center }
      .qs-pp-cell svg { width: 100%; height: auto; display: block; ${o.frame !== false ? 'outline: 0.75pt solid #777;' : ''} }
      .qs-pp-lines { height: 100%; background: repeating-linear-gradient(to bottom, transparent 0 0.3in, #999 0.3in calc(0.3in + 0.5pt)) }`;
    for (let i = 0; i < slides.length; i += per) {
      const cells = slides.slice(i, i + per).map((s) => `<div class="qs-pp-cell">${svg(s)}</div>${per === 3 ? '<div class="qs-pp-lines"></div>' : ''}`).join('');
      pages.push(`<div class="qs-pp-page qs-pp-handout">${cells}</div>`);
    }
  } else if (o.what === 'notes') {
    css = `@page { size: ${pw} ${ph}; margin: 0.6in } .qs-pp-page { width: calc(${pw} - 1.2in) } .qs-pp-notes svg { width: 85%; height: auto; display: block; margin: 0 auto 0.3in; outline: 0.75pt solid #777 }
      .qs-pp-notes p { font: 12pt/1.4 Carlito, Arimo, sans-serif; margin: 0 0 0.6em; white-space: pre-wrap } .qs-pp-num { text-align: center; font: 9pt sans-serif; color: #555 }`;
    for (const s of slides) {
      const notes = slideOutline(s).notes.map((t) => `<p>${esc(t) || '&nbsp;'}</p>`).join('');
      pages.push(`<div class="qs-pp-page qs-pp-notes">${svg(s)}${notes}<div class="qs-pp-num">${num(s)}</div></div>`);
    }
  } else {
    css = `@page { size: ${pw} ${ph}; margin: 0.75in } .qs-pp-outline { font: 12pt/1.4 Carlito, Arimo, sans-serif } .qs-pp-outline h2 { font-size: 14pt; margin: 0.8em 0 0.2em } .qs-pp-outline li { margin: 0.1em 0 }`;
    const body = slides.map((s) => {
      const o2 = slideOutline(s);
      return `<h2>${num(s)}. ${esc(o2.title || '(untitled slide)')}</h2>${o2.body.length ? `<ul>${o2.body.map((b) => `<li style="margin-left:${b.level * 1.5}em">${esc(b.text)}</li>`).join('')}</ul>` : ''}`;
    }).join('');
    pages.push(`<div class="qs-pp-outline">${deck.data.props.title ? `<h1>${esc(deck.data.props.title)}</h1>` : ''}${body}</div>`);
  }
  css += ' .qs-pp-page { page-break-after: always; break-after: page; overflow: hidden; box-sizing: border-box } .qs-pp-page:last-child { page-break-after: auto; break-after: auto } .qs-pp-slide svg { width: 100%; height: 100%; display: block }';
  return { css, pages };
}

/** Prints the presentation through the system print dialog. */
export async function printDeck(app: App, o: PrintOptions): Promise<void> {
  const { css, pages } = printPages(app.deck, o);
  if (!pages.length) {
    const r = parseRange(o.range, app.deck.slides.length);
    if (r && !r.size) throw new Error(`No slides match "${o.range}": this presentation has ${app.deck.slides.length} slide${app.deck.slides.length === 1 ? '' : 's'}.`);
    throw new Error(r ? 'Every slide in that range is hidden; turn on "Print hidden slides" to print them.' : 'There are no slides to print.');
  }
  const style = document.createElement('style');
  style.id = 'qs-print-css';
  style.textContent = `@media screen { .qs-print-root { display: none } }
    @media print { body > *:not(.qs-print-root) { display: none !important } .qs-print-root { display: block } html, body { margin: 0; background: #fff } ${css} }`;
  const root = document.createElement('div');
  root.className = 'qs-print-root';
  root.innerHTML = pages.join('');
  document.getElementById('qs-print-css')?.remove();
  document.querySelector('.qs-print-root')?.remove();
  document.head.appendChild(style);
  document.body.appendChild(root);
  const cleanup = () => { style.remove(); root.remove(); window.removeEventListener('afterprint', cleanup); };
  window.addEventListener('afterprint', cleanup);
  try {
    // Let fonts and pictures settle before the print snapshot.
    await (document as any).fonts?.ready;
    await new Promise((r) => setTimeout(r, 50));
    await printDocument(app.tab.displayName || 'Presentation');
  } finally {
    // Browsers that print synchronously have printed by now; others clean up on afterprint.
    setTimeout(cleanup, 60000);
  }
}

/** Print screen: what to print, layout options and a live preview, then print. */
export async function printPreviewDialog(app: App): Promise<void> {
  const deck = app.deck;
  const previewOf = (v: Record<string, any>) => {
    const { css, pages } = printPages(deck, toOptions(v));
    const scoped = css.replace(/@page[^}]*\}/g, '');
    return `<style>.qs-pp-preview .qs-pp-page{transform-origin:0 0;background:#fff;box-shadow:0 1px 4px #0004;margin:0 auto 12px} ${scoped.replace(/\.qs-pp-/g, '.qs-pp-preview .qs-pp-')}</style>
      <div class="qs-pp-preview" style="zoom:0.35">${pages.slice(0, 3).join('')}</div><p class="ql-help">${pages.length} page${pages.length === 1 ? '' : 's'}</p>`;
  };
  const r = await openDialog({
    title: 'Print', wide: true, ok: 'Print', preview: true,
    fields: [
      { key: 'what', label: 'Print what', type: 'select', value: 'slides', options: [{ value: 'slides', label: 'Full Page Slides' }, { value: 'handouts', label: 'Handouts' }, { value: 'notes', label: 'Notes Pages' }, { value: 'outline', label: 'Outline' }] },
      { key: 'perPage', label: 'Slides per page', type: 'select', value: '6', options: ['1', '2', '3', '4', '6', '9'], visibleIf: (v) => v.what === 'handouts' },
      { key: 'frame', label: 'Frame slides', type: 'checkbox', value: true, visibleIf: (v) => v.what === 'handouts' },
      { key: 'range', label: 'Slides (e.g. 1-3, 5)', type: 'text', value: '', placeholder: 'All slides' },
      { key: 'hidden', label: 'Print hidden slides', type: 'checkbox', value: false },
      { key: 'buildSteps', label: 'One page per animation step', type: 'checkbox', value: false, visibleIf: (v) => v.what === 'slides' },
      { key: 'grayscale', label: 'Grayscale', type: 'checkbox', value: false },
      { key: 'paper', label: 'Paper', type: 'select', value: 'letter', options: [{ value: 'letter', label: 'Letter' }, { value: 'a4', label: 'A4' }], visibleIf: (v) => v.what !== 'slides' },
    ],
    onOpen: (ctl) => ctl.setPreview(previewOf(ctl.values())),
    onChange: (v, ctl) => ctl.setPreview(previewOf(v)),
  });
  if (r) await printDeck(app, toOptions(r));
}

function toOptions(v: Record<string, any>): PrintOptions {
  return { what: v.what || 'slides', perPage: +v.perPage || 6, frame: !!v.frame, range: v.range || '', hidden: !!v.hidden, buildSteps: !!v.buildSteps, grayscale: !!v.grayscale, paper: v.paper === 'a4' ? 'a4' : 'letter' };
}
