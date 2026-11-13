/**
 * Markdown slides, compatible with the common conventions of Marp, reveal.js, Slidev, Deckset and
 * remark: `---` separates slides, front matter sets size and theme, `# heading` is the title,
 * lists become bullets, images become pictures, fenced code becomes a monospace text box, and
 * `Note:`, `???` or HTML comments hold speaker notes. `<!-- section: Name -->` starts a section.
 */
import { Deck, newId } from '../model/deck';
import type { Paragraph, PictureElement, Run, ShapeElement, Slide } from '../model/types';
import { THEME_PRESETS } from '../model/theme';
import { deckFromOutline, type OutlineItem } from './outline';

/** Parses inline Markdown (bold, italic, strike, code, links) into runs. */
export function inlineRuns(text: string): Run[] {
  const runs: Run[] = [];
  // Delimiters preceded by a backslash are literal; underscores only emphasise at word boundaries
  // (snake_case_names stay as they are), as in CommonMark.
  const re = /(?<!\\)\*\*(.+?)(?<!\\)\*\*|(?<![\p{L}\p{N}_\\])__(?!\s)(.+?)__(?![\p{L}\p{N}_])|(?<!\\)\*(?![\s*])(.+?)(?<!\\)\*|(?<![\p{L}\p{N}_\\])_(?![\s_])(.+?)_(?![\p{L}\p{N}_])|(?<!\\)~~(.+?)~~|(?<!\\)`([^`]+)`|(?<!\\)\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) runs.push({ text: unescapeMd(text.slice(last, m.index)) });
    if (m[1] != null || m[2] != null) for (const r of inlineRuns((m[1] ?? m[2])!)) runs.push({ ...r, b: true });
    else if (m[3] != null || m[4] != null) for (const r of inlineRuns((m[3] ?? m[4])!)) runs.push({ ...r, i: true });
    else if (m[5] != null) runs.push({ text: unescapeMd(m[5]), strike: true });
    else if (m[6] != null) runs.push({ text: m[6], font: 'Cousine' });
    else if (m[7] != null) runs.push({ text: unescapeMd(m[7]), link: m[8], u: true, color: 'hlink' });
    last = re.lastIndex;
  }
  if (last < text.length) runs.push({ text: unescapeMd(text.slice(last)) });
  return runs.filter((r) => r.text);
}

/** Backslash escapes: any ASCII punctuation (CommonMark). */
const unescapeMd = (s: string) => s.replace(/\\([!-/:-@[-`{-~])/g, '$1');

/** Lines of speaker notes are taken verbatim, except the escapes that keep them from ending the slide. */
const NOTE_ESCAPED = /^(\s*)\\(?=(---|\*\*\*|___)\s*$|```|~~~)/;
const NOTE_NEEDS_ESCAPE = /^(\s*)(?=(---|\*\*\*|___)\s*$|```|~~~)/;

interface MdSlide { item: OutlineItem; images: { alt: string; src: string }[]; code: string[]; codeLang?: string }

export function parseMarkdown(md: string): { slides: MdSlide[]; front: Record<string, string> } {
  let text = md.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const front: Record<string, string> = {};
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (fm && /^[\w-]+\s*:/m.test(fm[1]) && fm[1].split('\n').every((l) => !l.trim() || /^[\w-]+\s*:/.test(l) || /^\s/.test(l))) {
    for (const l of fm[1].split('\n')) { const m = /^([\w-]+)\s*:\s*(.*)$/.exec(l); if (m) front[m[1].toLowerCase()] = m[2].replace(/^["']|["']$/g, '').trim(); }
    text = text.slice(fm[0].length);
  }
  // Split on --- lines outside fenced code.
  const chunks: string[] = [];
  let cur: string[] = [];
  let fence = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence && /^\s*(---|\*\*\*|___)\s*$/.test(line) && !/^\s*$/.test(cur.join(''))) { chunks.push(cur.join('\n')); cur = []; continue; }
    if (!fence && /^\s*---\s*$/.test(line)) continue;
    cur.push(line);
  }
  if (cur.join('').trim()) chunks.push(cur.join('\n'));
  const slides: MdSlide[] = [];
  let section: string | undefined;
  for (const chunk of chunks) {
    const s: MdSlide = { item: { title: '', bullets: [] }, images: [], code: [] };
    const notes: string[] = [];
    let inNotes = false, inCode = false;
    let body = chunk.replace(/<!--([\s\S]*?)-->/g, (_m, c: string) => {
      const t = c.trim();
      const sec = /^section\s*:\s*(.+)$/i.exec(t);
      if (sec) { section = sec[1].trim(); return ''; }
      if (/^(_?[\w-]+\s*:)/.test(t) && !/^notes?\s*:/i.test(t)) return '';
      notes.push(t.replace(/^notes?\s*:\s*/i, ''));
      return '';
    });
    const lines = body.split('\n');
    let headingSeen = false;
    for (const raw of lines) {
      const line = raw.replace(/\s+$/, '');
      if (inNotes) { notes.push(line.replace(NOTE_ESCAPED, '$1').replace(/<\\!--/g, '<!--')); continue; }
      if (/^\s*(```|~~~)/.test(line)) {
        if (!inCode) s.codeLang = line.replace(/^\s*(```|~~~)/, '').trim() || undefined;
        inCode = !inCode; continue;
      }
      if (inCode) { s.code.push(raw); continue; }
      if (/^\s*(Notes?:|\?\?\?)\s*/i.test(line)) { inNotes = true; const rest = line.replace(/^\s*(Notes?:|\?\?\?)\s*/i, ''); if (rest) notes.push(rest); continue; }
      if (!line.trim()) continue;
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) {
        if (!headingSeen) { s.item.title = h[2].replace(/\s+#+\s*$/, ''); s.item.titleRuns = inlineRuns(s.item.title); headingSeen = true; if (h[1].length === 1) s.item.layout = 'title'; }
        else s.item.bullets.push({ level: 0, runs: inlineRuns(h[2]), bullet: { kind: 'none' } });
        continue;
      }
      const img = /^\s*!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/.exec(line);
      if (img) { s.images.push({ alt: img[1], src: img[2] }); continue; }
      const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
      if (li) {
        const ind = li[1].replace(/\t/g, '  ').length;
        const level = Math.min(8, Math.floor(ind / 2));
        const p: Paragraph = { level, runs: inlineRuns(li[3]) };
        if (/\d/.test(li[2])) p.bullet = { kind: 'num', scheme: li[2].endsWith(')') ? 'arabicParenR' : 'arabicPeriod' };
        s.item.bullets.push(p);
        continue;
      }
      const quote = /^\s*>\s?(.*)$/.exec(line);
      s.item.bullets.push({ level: 0, runs: inlineRuns(quote ? quote[1] : line.trim()), bullet: { kind: 'none' }, ...(quote ? { align: 'ctr' as const } : {}) });
    }
    // A slide that only has a level-1 heading and plain lines is a title slide; with lists it is title and content.
    if (s.item.layout === 'title' && (s.item.bullets.length > 1 || s.item.bullets.some((b) => !b.bullet || b.bullet.kind !== 'none') || s.code.length)) s.item.layout = undefined;
    if (s.item.layout === 'title' && slides.length > 0 && !s.item.bullets.length) s.item.layout = 'secHead';
    if (!s.item.layout) s.item.layout = s.item.bullets.length || s.images.length || s.code.length ? (s.item.title ? 'obj' : 'blank') : s.item.title ? 'titleOnly' : 'blank';
    if (s.item.layout === 'blank' && s.item.bullets.length) s.item.layout = 'obj';
    if (notes.length) s.item.notes = notes.join('\n').trim();
    if (section) s.item.section = section;
    slides.push(s);
  }
  return { slides, front };
}

export function importMarkdown(md: string): Deck {
  const { slides, front } = parseMarkdown(md);
  const size = /4\s*:\s*3/.test(front.size || '') ? { w: 720, h: 540 } : undefined;
  const themeIdx = Math.max(0, THEME_PRESETS.findIndex((t) => t.name.toLowerCase() === (front.theme || '').toLowerCase()));
  const deck = deckFromOutline(slides.map((s) => s.item), { size, themePreset: themeIdx, titleFirst: false });
  if (front.title) deck.data.props.title = front.title;
  if (front.author) deck.data.props.author = front.author;
  // Pictures and code blocks go in the body area.
  slides.forEach((ms, i) => {
    const slide = deck.slides[i];
    if (!slide) return;
    const lay = deck.layout(slide.layout);
    const area = lay.elements.find((e) => e.ph && (e.ph.type === 'obj' || e.ph.type === 'body')) || { x: 66, y: 144, w: deck.size.w - 132, h: deck.size.h - 200 };
    let { x = 66, y = 144, w = 828, h = 340 } = area as any;
    const body = slide.elements.find((e) => e.ph && (e.ph.type === 'obj' || e.ph.type === 'body')) as ShapeElement | undefined;
    const hasText = !!body?.text?.paras.some((p) => p.runs.length);
    const extras = ms.images.length + (ms.code.length ? 1 : 0);
    if (!extras) return;
    if (hasText) { const half = h / 2; body!.x = x; body!.y = y; body!.w = w; body!.h = half - 6; y += half; h = half; }
    else if (body) slide.elements = slide.elements.filter((e) => e !== body);
    const slotW = w / extras;
    let k = 0;
    for (const im of ms.images) {
      const bx = x + slotW * k++;
      const m = /^data:([^;,]+);base64,(.*)$/.exec(im.src);
      if (m) {
        const media = deck.addMedia({ mime: m[1], b64: m[2] });
        const pic: PictureElement = { id: newId('pic'), kind: 'picture', media, x: bx + 6, y, w: slotW - 12, h, alt: im.alt || undefined };
        slide.elements.push(pic);
      } else {
        slide.elements.push({ id: newId('sp'), kind: 'shape', geom: 'rect', textbox: true, x: bx + 6, y, w: slotW - 12, h, alt: im.alt, fill: { type: 'solid', color: { s: 'bg2', lum: 0 } }, text: { anchor: 'ctr', paras: [{ level: 0, align: 'ctr', runs: [{ text: `Picture: ${im.alt || im.src}`, i: true }] }, { level: 0, align: 'ctr', runs: [{ text: im.src, link: /^https?:/.test(im.src) ? im.src : undefined, size: 12 }] }] } } as ShapeElement);
      }
    }
    if (ms.code.length) {
      const bx = x + slotW * k;
      slide.elements.push({
        id: newId('code'), kind: 'shape', geom: 'rect', textbox: true, name: `Code${ms.codeLang ? ` (${ms.codeLang})` : ''}`, x: bx + 6, y, w: slotW - 12, h,
        fill: { type: 'solid', color: '#1E1E1E' }, line: { fill: { type: 'none' } },
        text: { insets: [10, 8, 10, 8], autofit: 'shrink', wrap: false, paras: ms.code.map((l) => ({ level: 0, runs: l ? [{ text: l, font: 'Cousine', size: 16, color: '#E8E8E8' }] : [], end: { size: 16 } })) },
        keep: { code: ms.codeLang || '' },
      } as ShapeElement);
    }
  });
  deck.clearHistory();
  return deck;
}

// ------------------------------------------------------------------------------------------
// Export

/**
 * Escapes what would read back as structure at the start of a line: headings, rules, list
 * markers, quotes, notes markers ("Note:", "???"). Inline markers are escaped by mdInline.
 */
function escapeLead(t: string): string {
  if (/^#{1,6}(\s|$)/.test(t)) return '\\' + t;
  if (/^(-{3,}|_{3,}|(\\\*){3,})\s*$/.test(t) || /^[-+](\s|$)/.test(t) || /^>/.test(t)) return '\\' + t;
  const n = /^(\d+)([.)])(\s|$)/.exec(t);
  if (n) return `${n[1]}\\${t.slice(n[1].length)}`;
  if (/^\?\?\?/.test(t)) return '\\' + t;
  const note = /^(notes?)(:)/i.exec(t);
  if (note) return `${note[1]}\\${t.slice(note[1].length)}`;
  return t;
}

function mdInline(runs: Run[]): string {
  return runs.map((r) => {
    if (r.br) return '  \n';
    let t = r.text.replace(/([\\`*_[\]~])/g, '\\$1').replace(/<!--/g, '<\\!--');
    if (!t.trim()) return t;
    if (r.font && /cousine|courier|mono|consolas/i.test(r.font)) t = '`' + r.text + '`';
    if (r.strike) t = `~~${t}~~`;
    if (r.i) t = `*${t}*`;
    if (r.b) t = `**${t}**`;
    if (r.link) t = `[${t}](${r.link})`;
    return t;
  }).join('');
}

export function exportMarkdown(deck: Deck, opts: { embedImages?: boolean } = {}): string {
  const embed = opts.embedImages !== false;
  const out: string[] = [];
  const front = [`marp: true`, `size: ${Math.abs(deck.size.w / deck.size.h - 4 / 3) < 0.05 ? '4:3' : '16:9'}`];
  if (deck.data.props.title) front.push(`title: ${deck.data.props.title}`);
  if (deck.data.props.author) front.push(`author: ${deck.data.props.author}`);
  out.push(`---\n${front.join('\n')}\n---\n`);
  let lastSection: string | undefined;
  deck.slides.forEach((s: Slide, i) => {
    const lines: string[] = [];
    const sec = deck.sectionOf(s.id);
    if (sec && sec.name !== lastSection) { lines.push(`<!-- section: ${sec.name} -->`, ''); lastSection = sec.name; }
    const lay = deck.layout(s.layout);
    const title = s.elements.find((e) => e.ph && (e.ph.type === 'title' || e.ph.type === 'ctrTitle')) as ShapeElement | undefined;
    const ttext = title?.text ? title.text.paras.map((p) => mdInline(p.runs)).join(' ').trim() : '';
    // A title ending in #s would lose them as a closing sequence.
    if (ttext) lines.push(`${lay.type === 'title' || lay.type === 'secHead' || title?.ph?.type === 'ctrTitle' ? '#' : '##'} ${ttext.replace(/(#+)$/, (h) => '\\' + h.split('').join('\\'))}`, '');
    for (const e of s.elements) {
      if (e === title) continue;
      if (e.kind === 'shape' && e.text && !(e.ph && ['dt', 'ftr', 'sldNum'].includes(e.ph.type))) {
        if (e.keep?.code != null) { lines.push('```' + e.keep.code, ...e.text.paras.map((p) => p.runs.map((r) => r.text).join('')), '```', ''); continue; }
        const isList = !!e.ph && (e.ph.type === 'body' || e.ph.type === 'obj');
        const counters: number[] = [];
        for (const p of e.text.paras) {
          const t = mdInline(p.runs).trim();
          if (!t) continue;
          const kind = p.bullet?.kind ?? (isList ? 'char' : 'none');
          if (kind === 'none') { lines.push(escapeLead(t), ''); continue; }
          counters[p.level] = kind === 'num' ? (counters[p.level] || 0) + 1 : 0;
          lines.push(`${'  '.repeat(p.level)}${kind === 'num' ? `${counters[p.level]}.` : '-'} ${t}`);
        }
        lines.push('');
      } else if (e.kind === 'picture' && e.media) {
        const m = deck.media[e.media];
        if (m) lines.push(`![${(e.alt || e.name || '').replace(/[[\]]/g, '')}](${embed ? `data:${m.mime};base64,${m.b64}` : `media/${e.media}`})`, '');
      } else if (e.kind === 'table') {
        const rows = e.rows.map((r) => r.cells.map((c) => (c.text?.paras || []).map((p) => mdInline(p.runs)).join(' ').replace(/\|/g, '\\|')));
        if (rows.length) {
          lines.push(`| ${rows[0].join(' | ')} |`, `|${rows[0].map(() => ' --- ').join('|')}|`, ...rows.slice(1).map((r) => `| ${r.join(' | ')} |`), '');
        }
      }
    }
    const notes = s.notes.map((p) => p.runs.map((r) => (r.br ? '\n' : r.text)).join('')).join('\n').trim();
    if (notes) lines.push('Note:', notes.split('\n').map((l) => l.replace(NOTE_NEEDS_ESCAPE, '$1\\').replace(/<!--/g, '<\\!--')).join('\n'), '');
    out.push(lines.join('\n').trim() + '\n');
    if (i < deck.slides.length - 1) out.push('\n---\n\n');
  });
  return out.join('');
}
