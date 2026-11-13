/**
 * Outlines: plain text (indentation = level), Word documents (Heading 1 starts a slide) and RTF
 * (\outlinelevel), plus the reverse (outline as text, Markdown or RTF). Also "Text to Deck": each
 * blank-line-separated paragraph of a text becomes a slide.
 */
import JSZip from 'jszip';
import { Deck, textOf } from '../model/deck';
import type { Paragraph, Run, ShapeElement, Slide } from '../model/types';
import { attr, decodeXml, desc, kid, kids, parseXml } from './xml';
import { inflateCapped, ZipBudget } from './zip';

export interface OutlineItem { title: string; titleRuns?: Run[]; bullets: Paragraph[]; notes?: string; section?: string; layout?: 'title' | 'obj' | 'secHead' | 'titleOnly' | 'blank' }

/** Builds a deck: the first item uses the Title Slide layout when it has no bullets. */
export function deckFromOutline(items: OutlineItem[], opts: { themePreset?: number; size?: { w: number; h: number }; titleFirst?: boolean } = {}): Deck {
  const deck = new Deck(Deck.blankData(opts.size, opts.themePreset));
  const d = deck.data;
  const lay = (t: string) => deck.layoutByType(t)?.id || d.layouts[0].id;
  items.forEach((it, i) => {
    const kind = it.layout || (i === 0 && opts.titleFirst !== false && it.bullets.length <= 1 && !it.bullets.some((b) => b.level > 0) ? 'title' : it.bullets.length ? 'obj' : 'titleOnly');
    const s = deck.makeSlide(lay(kind));
    const title = s.elements.find((e) => e.ph?.type === 'title' || e.ph?.type === 'ctrTitle') as ShapeElement | undefined;
    if (title) title.text = { paras: [{ level: 0, runs: it.titleRuns || (it.title ? [{ text: it.title }] : []) }] };
    const body = s.elements.find((e) => e.ph && e.ph.type !== 'title' && e.ph.type !== 'ctrTitle') as ShapeElement | undefined;
    if (body && it.bullets.length) {
      const paras = kind === 'title' ? it.bullets.map((b) => ({ ...b, level: 0 })) : it.bullets;
      body.text = { paras };
    }
    if (it.notes) s.notes = it.notes.split(/\r?\n/).map((l) => ({ level: 0, runs: l ? [{ text: l }] : [] }));
    d.slides.push(s);
    if (it.section) {
      const last = d.sections[d.sections.length - 1];
      if (!last || last.name !== it.section || i === 0) d.sections.push({ id: `sec${d.sections.length + 1}`, name: it.section, slides: [s.id] });
      else last.slides.push(s.id);
    } else if (d.sections.length) d.sections[d.sections.length - 1].slides.push(s.id);
  });
  if (!d.slides.length) d.slides.push(deck.makeSlide(d.layouts[0].id));
  deck.clearHistory();
  return deck;
}

const para = (text: string, level = 0, extra: Partial<Paragraph> = {}): Paragraph => ({ level: Math.min(8, Math.max(0, level)), runs: text ? [{ text }] : [], ...extra });

/** Plain-text outline: unindented lines are slide titles, indented lines are bullets by depth. */
export function outlineFromText(text: string): OutlineItem[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const indentOf = (l: string) => { let n = 0; for (const ch of l) { if (ch === '\t') n += 4; else if (ch === ' ') n++; else break; } return n; };
  const nonEmpty = lines.filter((l) => l.trim());
  const indents = nonEmpty.map(indentOf).filter((n) => n > 0);
  if (!indents.length) {
    // No indentation: blank-line-separated paragraphs become slides, else one slide per line.
    return /\n\s*\n/.test(text.trim()) ? textToDeckItems(text) : nonEmpty.map((l) => ({ title: l.trim(), bullets: [] }));
  }
  const unit = Math.max(1, Math.min(...indents));
  const items: OutlineItem[] = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    const lv = Math.round(indentOf(l) / unit);
    const t = l.trim().replace(/^([-*+•–]|\d+[.)])\s+/, '');
    if (lv === 0 || !items.length) items.push({ title: t, bullets: [] });
    else items[items.length - 1].bullets.push(para(t, lv - 1));
  }
  return items;
}

/** Text to Deck: each paragraph becomes a slide; its first line is the title. */
export function textToDeckItems(text: string): OutlineItem[] {
  return text.replace(/\r\n?/g, '\n').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((p) => {
    const [first, ...rest] = p.split('\n');
    return { title: first.trim(), bullets: rest.map((l) => para(l.trim().replace(/^([-*+•–]|\d+[.)])\s+/, ''))).filter((b) => b.runs.length) };
  });
}

export function importTextOutline(text: string): Deck { return deckFromOutline(outlineFromText(text)); }
export function textToDeck(text: string): Deck { return deckFromOutline(textToDeckItems(text), { titleFirst: false }); }

// ------------------------------------------------------------------------------------------
// Word (.docx)

export async function importDocxOutline(data: Uint8Array): Promise<Deck> {
  const zip = await JSZip.loadAsync(data);
  const budget = new ZipBudget();
  const docF = zip.file('word/document.xml');
  if (!docF) throw new Error('This Word document has no main part (word/document.xml).');
  const doc = parseXml(decodeXml(await inflateCapped(docF, budget)));
  if (!doc) throw new Error('The Word document could not be read.');
  const stylesF = zip.file('word/styles.xml');
  const styles = stylesF ? parseXml(decodeXml(await inflateCapped(stylesF, budget))) : null;
  const styleLevel = new Map<string, number>();
  for (const st of desc(styles, 'style')) {
    const id = attr(st, 'styleId') || '';
    const name = (attr(kid(st, 'name'), 'val') || '').toLowerCase();
    const ol = attr(kid(kid(st, 'pPr'), 'outlineLvl'), 'val');
    const m = /^heading\s*(\d)$/.exec(name);
    if (m) styleLevel.set(id, +m[1] - 1);
    else if (ol != null) styleLevel.set(id, +ol);
    else if (name === 'title') styleLevel.set(id, 0);
  }
  const items: OutlineItem[] = [];
  for (const p of desc(doc, 'p')) {
    const pPr = kid(p, 'pPr');
    const sid = attr(kid(pPr, 'pStyle'), 'val') || '';
    const ol = attr(kid(pPr, 'outlineLvl'), 'val');
    let level = styleLevel.get(sid) ?? (/^heading(\d)$/i.test(sid) ? +/(\d)$/.exec(sid)![1] - 1 : ol != null ? +ol : -1);
    const numPr = kid(pPr, 'numPr');
    const ilvl = numPr ? +(attr(kid(numPr, 'ilvl'), 'val') || 0) : -1;
    const runs: Run[] = [];
    for (const r of desc(p, 'r')) {
      const rPr = kid(r, 'rPr');
      let t = '';
      for (const c of kids(r)) t += c.localName === 't' ? c.textContent || '' : c.localName === 'tab' ? '\t' : c.localName === 'br' ? ' ' : '';
      if (!t) continue;
      const run: Run = { text: t };
      if (kid(rPr, 'b') && attr(kid(rPr, 'b'), 'val') !== '0') run.b = true;
      if (kid(rPr, 'i') && attr(kid(rPr, 'i'), 'val') !== '0') run.i = true;
      runs.push(run);
    }
    const text = runs.map((r) => r.text).join('').trim();
    if (!text) continue;
    if (level === 0) { items.push({ title: text, titleRuns: runs.map((r) => ({ ...r, b: undefined })), bullets: [] }); continue; }
    if (!items.length) items.push({ title: '', bullets: [] });
    const it = items[items.length - 1];
    if (level > 0) it.bullets.push({ level: Math.min(8, level - 1), runs });
    else it.bullets.push({ level: Math.max(0, ilvl), runs });
  }
  return deckFromOutline(items);
}

// ------------------------------------------------------------------------------------------
// RTF

/** Reduces RTF to lines tagged with their outline level (null when the paragraph has none). */
export function rtfLines(rtf: string): { text: string; level: number | null; list: number | null }[] {
  const out: { text: string; level: number | null; list: number | null }[] = [];
  let buf = '';
  let level: number | null = null, list: number | null = null;
  const stack: { skip: boolean; uc: number }[] = [{ skip: false, uc: 1 }];
  let i = 0;
  let skipChars = 0;
  const SKIP = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'header', 'footer', 'footnote', 'listtable', 'listoverridetable', 'rsidtbl', 'generator', 'themedata', 'colorschememapping', 'latentstyles', 'datastore', 'xmlnstbl', 'pgdsctbl', 'filetbl', 'revtbl', 'bkmkstart', 'bkmkend', 'fldinst', 'pntext', 'pntxta', 'pntxtb', 'listtext']);
  const flush = () => { const t = buf.replace(/\s+$/, ''); out.push({ text: t, level, list }); buf = ''; };
  while (i < rtf.length) {
    const ch = rtf[i];
    const top = stack[stack.length - 1];
    if (ch === '{') { stack.push({ ...top }); i++; continue; }
    if (ch === '}') { if (stack.length > 1) stack.pop(); i++; continue; }
    if (ch === '\\') {
      const m = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(rtf.slice(i, i + 40));
      if (m) {
        i += m[0].length;
        const w = m[1], n = m[2] != null ? +m[2] : null;
        if (SKIP.has(w)) { top.skip = true; continue; }
        if (top.skip) continue;
        switch (w) {
          case 'par': case 'line': flush(); break;
          case 'pard': level = null; list = null; break;
          case 'outlinelevel': level = n; break;
          case 'ilvl': list = n; break;
          case 'tab': buf += '\t'; break;
          case 'u': { let c = n ?? 0; if (c < 0) c += 65536; buf += String.fromCharCode(c); skipChars = top.uc; break; }
          case 'uc': top.uc = n ?? 1; break;
          case 'emdash': buf += '—'; break;
          case 'endash': buf += '–'; break;
          case 'bullet': buf += '•'; break;
          case 'lquote': buf += '‘'; break;
          case 'rquote': buf += '’'; break;
          case 'ldblquote': buf += '“'; break;
          case 'rdblquote': buf += '”'; break;
        }
        continue;
      }
      const nx = rtf[i + 1];
      if (nx === '*') { top.skip = true; i += 2; continue; }
      if (nx === "'") {
        const hex = rtf.slice(i + 2, i + 4);
        i += 4;
        if (top.skip) continue;
        if (skipChars > 0) { skipChars--; continue; }
        const b = parseInt(hex, 16);
        buf += b >= 0x80 && b < 0xa0 ? new TextDecoder('windows-1252').decode(new Uint8Array([b])) : String.fromCharCode(b);
        continue;
      }
      if (!top.skip && (nx === '\\' || nx === '{' || nx === '}')) buf += nx;
      if (!top.skip && nx === '~') buf += ' ';
      i += 2;
      continue;
    }
    if (ch === '\r' || ch === '\n') { i++; continue; }
    if (!top.skip) { if (skipChars > 0) skipChars--; else buf += ch; }
    i++;
  }
  if (buf.trim()) flush();
  return out;
}

export function importRtfOutline(rtf: string): Deck {
  const lines = rtfLines(rtf).filter((l) => l.text.trim());
  if (lines.some((l) => l.level != null)) {
    const items: OutlineItem[] = [];
    for (const l of lines) {
      const lv = l.level ?? 9;
      if (lv === 0) items.push({ title: l.text.trim(), bullets: [] });
      else {
        if (!items.length) items.push({ title: '', bullets: [] });
        items[items.length - 1].bullets.push(para(l.text.trim(), lv === 9 ? (l.list ?? 0) : lv - 1));
      }
    }
    return deckFromOutline(items);
  }
  return importTextOutline(lines.map((l) => (l.list != null ? '\t'.repeat(l.list + 1) : '') + l.text).join('\n'));
}

// ------------------------------------------------------------------------------------------
// Export

function slideOutline(s: Slide): { title: string; body: Paragraph[] } {
  let title = '';
  const body: Paragraph[] = [];
  for (const e of s.elements) {
    if (e.kind !== 'shape' || !e.text) continue;
    if (e.ph && (e.ph.type === 'title' || e.ph.type === 'ctrTitle')) title = textOf(e.text.paras).replace(/\n/g, ' ');
    else if (!e.ph || !['dt', 'ftr', 'sldNum', 'hdr'].includes(e.ph.type)) body.push(...e.text.paras.filter((p) => p.runs.some((r) => r.text)));
  }
  return { title, body };
}

export function outlineToText(deck: Deck): string {
  return deck.slides.map((s) => {
    const { title, body } = slideOutline(s);
    return [title || '(Untitled)', ...body.map((p) => '\t'.repeat(p.level + 1) + p.runs.map((r) => (r.br ? ' ' : r.text)).join(''))].join('\n');
  }).join('\n');
}

const rtfEsc = (s: string) => s.replace(/[\\{}]/g, (c) => '\\' + c).replace(/\t/g, '\\tab ').replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0) > 32767 ? c.charCodeAt(0) - 65536 : c.charCodeAt(0)}?`);

export function outlineToRtf(deck: Deck): string {
  const parts = ['{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Calibri;}}\\viewkind4\\uc1'];
  for (const s of deck.slides) {
    const { title, body } = slideOutline(s);
    parts.push(`\\pard\\outlinelevel0\\sb240\\b\\fs32 ${rtfEsc(title || '(Untitled)')}\\b0\\par`);
    for (const p of body) {
      const t = p.runs.map((r) => (r.br ? ' ' : r.text)).join('');
      parts.push(`\\pard\\outlinelevel${Math.min(8, p.level + 1)}\\li${360 * (p.level + 1)}\\fs24 ${rtfEsc(t)}\\par`);
    }
  }
  parts.push('}');
  return parts.join('\n');
}
