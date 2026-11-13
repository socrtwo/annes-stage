/** Tools tab: Fit Text to Slide, off-slide content, unused layouts, reset, speaking time, media, numbering, fonts, OCR clean-up, notes script. */
import { def } from './registry';
import type { App } from '../app';
import type { Element, Paragraph, ShapeElement, Slide } from '../model/types';
import { newId } from '../model/deck';
import { edit, forEachText, textTargets } from '../edit/ops';
import { openDialog, toast, confirmDialog } from '../ui/dialog';
import { download, h, esc } from '../ui/dom';
import { resolveBox, levelStyle } from '../model/inherit';
import { themeFont } from '../model/theme';
import { FACES } from '../fonts';
import { slideTitle } from '../render/slide';
import { paraText } from '../edit/textEdit';
import { titleShape, bodyShape } from '../edit/workspace';

const hasSlides = (app: App) => app.deck.slides.length > 0;

/** OCR clean-up of a paragraph's text: ligatures, hyphenation at line ends, doubled spaces, odd quotes. */
export function ocrClean(t: string): string {
  return t
    .replace(/ﬀ/g, 'ff').replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl').replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl')
    .replace(/(\p{L})-\s*\n\s*(\p{Ll})/gu, '$1$2')
    .replace(/(\p{L})¬\s*(\p{Ll})/gu, '$1$2')
    .replace(/[ \t]*\n[ \t]*(?=\p{Ll})/gu, ' ')
    .replace(/[   ]/g, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(/ +([,.;:!?])/g, '$1')
    .replace(/,,/g, '„').replace(/''/g, '"')
    .trim();
}

function cleanParas(paras: Paragraph[]): number {
  let n = 0;
  for (const p of paras) {
    const raw = p.runs.map((r) => (r.br ? '\n' : r.text)).join('');
    const out = ocrClean(raw);
    if (out === raw.trim() && !/\n/.test(raw)) continue;
    if (out === raw) continue;
    const first = p.runs.find((r) => !r.br) || {};
    p.runs = [{ ...first, text: out, br: undefined } as any];
    n++;
  }
  return n;
}

function usedLayouts(app: App): Set<string> {
  return new Set(app.deck.slides.map((s) => s.layout));
}

def([
  {
    id: 'fmt.fitTextToSlide', label: 'Fit Text to Slide', icon: 'format_size', tab: 'Tools', group: 'Text', edits: true, isEnabled: (app) => !!app.slide, origin: 'Takahashi method',
    tip: 'One huge statement filling the slide: the selected text box, or the slide\'s title',
    run: (app) => {
      const s = app.slide!;
      const target = (textTargets(app)[0] || titleShape(s)) as ShapeElement | undefined;
      if (!target?.text?.paras.some((p) => paraText(p).trim())) { toast('Select a text box or give the slide a title first.'); return; }
      const { w, h: hh } = app.deck.size;
      edit(app, 'Fit Text to Slide', (o) => {
        const t = o.elements.find((e) => e.id === target.id) as ShapeElement;
        Object.assign(t, { x: w * 0.05, y: hh * 0.08, w: w * 0.9, h: hh * 0.84 });
        const words = t.text!.paras.map(paraText).join(' ').split(/\s+/).filter(Boolean).length;
        const size = Math.max(40, Math.min(200, Math.round(400 / Math.sqrt(Math.max(1, words)))));
        t.text = { ...t.text!, anchor: 'ctr', autofit: 'shrink', fontScale: undefined, paras: t.text!.paras.map((p) => ({ ...p, align: 'ctr', bullet: { kind: 'none' }, marL: 0, indent: 0, runs: p.runs.map((r) => ({ ...r, size, b: true })) })) };
        o.elements = o.elements.filter((e) => e === t || !(e.ph && e.kind === 'shape' && !(e as ShapeElement).text?.paras.some((p) => paraText(p).trim())));
      });
    },
  },
  {
    id: 'tools.offSlide', label: 'Find Off-Slide Content', icon: 'crop_free', tab: 'Tools', group: 'Clean Up', edits: true, isEnabled: hasSlides,
    tip: 'Objects that lie entirely outside the slide: select them, move them onto the slide, or delete them',
    run: async (app) => {
      const d = app.deck;
      const found: { s: Slide; e: Element }[] = [];
      for (const s of d.slides) for (const e of s.elements) { const b = resolveBox(d, s, e); if (b.x + b.w <= 0 || b.y + b.h <= 0 || b.x >= d.size.w || b.y >= d.size.h) found.push({ s, e }); }
      if (!found.length) { toast('Nothing lies outside the slides.'); return; }
      const r = await openDialog({ title: 'Off-Slide Content', fields: [
        { key: 'i', type: 'info', html: `<p>${found.length} object(s) outside the slide:</p><ul>${found.slice(0, 15).map((f) => `<li>Slide ${d.slideIndex(f.s.id) + 1}: ${esc(f.e.name || f.e.kind)}</li>`).join('')}</ul>` },
        { key: 'act', label: 'Action', type: 'radio', options: [{ value: 'show', label: 'Go to the first one' }, { value: 'move', label: 'Move them onto their slides' }, { value: 'delete', label: 'Delete them' }], value: 'show' },
      ] });
      if (!r) return;
      if (r.act === 'show') { app.goToSlide(found[0].s.id); app.tab.ui.select([found[0].e.id]); return; }
      d.transact(r.act === 'move' ? 'Move onto Slide' : 'Delete Off-Slide Content', () => {
        for (const f of found) {
          if (r.act === 'delete') { f.s.elements = f.s.elements.filter((x) => x.id !== f.e.id); continue; }
          const b = resolveBox(d, f.s, f.e);
          f.e.x = Math.min(Math.max(0, b.x), d.size.w - Math.min(b.w, d.size.w)); f.e.y = Math.min(Math.max(0, b.y), d.size.h - Math.min(b.h, d.size.h)); f.e.w = b.w; f.e.h = b.h;
        }
      }, [...new Set(found.map((f) => f.s.id))]);
    },
  },
  {
    id: 'tools.unusedLayouts', label: 'Find Unused Masters and Layouts', icon: 'search', tab: 'Tools', group: 'Clean Up', edits: false, noRecord: true,
    run: async (app) => {
      const d = app.deck, used = usedLayouts(app);
      const lays = d.data.layouts.filter((l) => !used.has(l.id));
      const masters = d.data.masters.filter((m) => !d.layoutsOf(m.id).some((l) => used.has(l.id)));
      await openDialog({ title: 'Unused Masters and Layouts', ok: 'Close', cancel: false, buttons: lays.length ? [{ label: 'Remove Them', onClick: (_v, ctl) => { ctl.close(null); app.exec('tools.removeUnusedLayouts'); } }] : [], fields: [{ key: 'i', type: 'info', html: lays.length || masters.length ? `<p>Masters with no slides: ${masters.map((m) => esc(m.name || '')).join(', ') || 'none'}</p><p>Layouts with no slides (${lays.length}): ${lays.map((l) => esc(l.name || '')).join(', ')}</p>` : '<p>Every master and layout is used.</p>' }] });
    },
  },
  {
    id: 'tools.removeUnusedLayouts', label: 'Remove Unused Masters and Layouts', icon: 'cleaning_services', tab: 'Tools', group: 'Clean Up', edits: true,
    tip: 'Delete layouts and slide masters no slide uses (preserved masters are kept)',
    run: (app) => {
      const d = app.deck, used = usedLayouts(app);
      const keepMasters = d.data.masters.filter((m) => (m.keep as any)?.preserve || d.layoutsOf(m.id).some((l) => used.has(l.id)));
      if (!keepMasters.length) keepMasters.push(d.data.masters[0]);
      const before = d.data.layouts.length + d.data.masters.length;
      d.transact('Remove Unused Layouts', () => {
        const km = new Set(keepMasters.map((m) => m.id));
        d.data.masters = keepMasters;
        d.data.layouts = d.data.layouts.filter((l) => km.has(l.master) && (used.has(l.id) || (d.master(l.master).keep as any)?.preserve));
        for (const m of d.data.masters) if (!d.layoutsOf(m.id).length) d.data.layouts.push({ id: newId('lay'), name: 'Blank', master: m.id, type: 'blank', elements: [] });
      });
      toast(`Removed ${before - d.data.layouts.length - d.data.masters.length} unused master(s) and layout(s).`);
    },
  },
  {
    id: 'tools.resetAll', label: 'Reset All Slides to Layout', icon: 'restart_alt', tab: 'Tools', group: 'Clean Up', edits: true, isEnabled: hasSlides,
    tip: 'Placeholders go back to their layout position and formatting; text is kept',
    run: (app) => app.deck.transact('Reset All Slides', () => {
      for (const s of app.deck.slides) for (const e of s.elements) {
        if (!e.ph) continue;
        delete e.x; delete e.y; delete e.w; delete e.h; delete e.rot; delete e.flipH; delete e.flipV;
        if (e.kind === 'shape') {
          delete e.fill; delete e.line; delete e.effects;
          if (e.text) e.text = { paras: e.text.paras.map((p) => ({ level: p.level, runs: p.runs.map((r) => ({ text: r.text, ...(r.br ? { br: true } : {}), ...(r.field ? { field: r.field } : {}), ...(r.link ? { link: r.link } : {}) })) })) };
        }
      }
    }),
  },
  {
    id: 'tools.speakingTime', label: 'Estimate Speaking Time', icon: 'timer', tab: 'Tools', group: 'Reports', edits: false, noRecord: true, isEnabled: hasSlides,
    tip: 'From the words in the speaker notes (or on the slide when a slide has no notes)',
    run: async (app) => {
      const r0 = await openDialog({ title: 'Estimate Speaking Time', fields: [{ key: 'wpm', label: 'Speaking rate (words per minute)', type: 'number', value: 130, min: 60, max: 250 }] });
      if (!r0) return;
      const wpm = +r0.wpm || 130;
      let total = 0;
      const rows = app.deck.slides.map((s, i) => {
        let words = s.notes.map(paraText).join(' ').split(/\s+/).filter(Boolean).length;
        let src = 'notes';
        if (!words) { forEachText([s], (ps, el) => { if (el) words += ps.map(paraText).join(' ').split(/\s+/).filter(Boolean).length; }, false); src = 'slide text'; }
        const sec = Math.max(s.hidden ? 0 : 10, (words / wpm) * 60);
        if (!s.hidden) total += sec;
        return h('tr', null, h('td', null, `${i + 1}. ${(slideTitle(s) || '(untitled)').slice(0, 40)}${s.hidden ? ' (hidden)' : ''}`), h('td', null, `${words} words (${src})`), h('td', null, `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`));
      });
      await openDialog({ title: `Speaking Time: about ${Math.round(total / 60)} min`, wide: true, ok: 'Close', cancel: false, content: h('table', { class: 'ql-stats' }, ...rows) });
    },
  },
  {
    id: 'tools.extractMedia', label: 'Extract All Media', icon: 'perm_media', tab: 'Tools', group: 'Clean Up', edits: false, noRecord: true,
    tip: 'Save every picture, video and sound in the presentation as a ZIP file',
    run: async (app) => {
      const entries = Object.entries(app.deck.media);
      if (!entries.length) { toast('This presentation has no pictures or media.'); return; }
      const { default: JSZip } = await import('jszip');
      const zip = new JSZip();
      const names = new Set<string>();
      entries.forEach(([id, m], i) => {
        const ext = (m.mime.split('/')[1] || 'bin').replace('jpeg', 'jpg').replace('svg+xml', 'svg').replace(/[^\w]/g, '');
        let base = (m.name || `media${i + 1}`).replace(/\.[^.]+$/, '').replace(/[^\w -]/g, '') || id;
        while (names.has(base)) base += '_';
        names.add(base);
        zip.file(`${base}.${ext}`, m.b64, { base64: true });
      });
      const blob = await zip.generateAsync({ type: 'blob' });
      download(blob, `${(app.tab.displayName || 'presentation').replace(/\.[^.]+$/, '')} media.zip`);
    },
  },
  {
    id: 'tools.numbering', label: 'Slide Numbering Options', icon: 'format_list_numbered', tab: 'Tools', group: 'Numbering', edits: true,
    run: async (app) => {
      const d = app.deck;
      const r = await openDialog({ title: 'Slide Numbering', fields: [{ key: 'first', label: 'Number slides from', type: 'number', value: d.data.firstNumber ?? 1, min: 0 }, { key: 'show', label: 'Show slide numbers', type: 'checkbox', value: !!d.data.hf?.slideNum }, { key: 'title', label: "Don't number the title slide", type: 'checkbox', value: !!d.data.hf?.hideOnTitle }] });
      if (!r) return;
      d.transact('Slide Numbering', () => { d.data.firstNumber = +r.first === 1 ? undefined : +r.first; d.data.hf = { ...(d.data.hf || {}), slideNum: !!r.show, hideOnTitle: !!r.title }; });
    },
  },
  {
    id: 'tools.fontsUsed', label: 'Compare Fonts Used', icon: 'font_download', tab: 'Tools', group: 'Reports', edits: false, noRecord: true,
    tip: 'Fonts the presentation uses, and which open font stands in where the original is not installed',
    run: async (app) => {
      const d = app.deck;
      const uses = new Map<string, number>();
      for (const s of d.slides) {
        const theme = d.themeOf(s);
        const walk = (els: Element[]) => { for (const e of els) { if (e.kind === 'group') walk(e.children); if (e.kind !== 'shape' || !e.text) continue; for (const p of e.text.paras) { const st = levelStyle(d, s, e, p.level); for (const r of p.runs) if (r.text.trim()) { const f = themeFont(r.font ?? st.run?.font, theme) || theme.fonts.minor; uses.set(f, (uses.get(f) || 0) + 1); } } } };
        walk(s.elements);
      }
      const bundled = new Set(FACES.map((f) => f[0]));
      const alias = new Map<string, string>();
      for (const f of FACES) for (const a of f[1]) alias.set(a.toLowerCase(), f[0]);
      const check = (f: string) => { try { return (document as any).fonts?.check?.(`12px "${f}"`) ?? false; } catch { return false; } };
      const rows = [...uses].sort((a, b) => b[1] - a[1]).map(([f, n]) => h('tr', null, h('td', null, f), h('td', null, `${n} run(s)`), h('td', null, bundled.has(f) ? 'Included with Anne\'s Stage' : alias.has(f.toLowerCase()) ? `Installed original, otherwise ${alias.get(f.toLowerCase())} (same metrics)` : check(f) ? 'Installed on this device' : 'Not available: a similar font is used')));
      await openDialog({ title: 'Fonts Used', wide: true, ok: 'Close', cancel: false, content: rows.length ? h('table', { class: 'ql-stats' }, ...rows) : h('p', null, 'No text in this presentation.') });
    },
  },
  {
    id: 'tools.ocrCleanup', label: 'OCR Clean-up', icon: 'document_scanner', tab: 'Tools', group: 'Text', edits: true,
    tip: 'Fix scanned or pasted text: join hyphenated words, remove stray line breaks and doubled spaces, expand ligatures (selected objects, or all slides)',
    run: async (app) => {
      const sel = textTargets(app);
      let n = 0;
      if (sel.length) edit(app, 'OCR Clean-up', () => { for (const s of sel) if (s.text) n += cleanParas(s.text.paras); });
      else {
        if (!(await confirmDialog('OCR Clean-up', 'Clean up the text on all slides and in the notes?', 'Clean Up'))) return;
        app.deck.transact('OCR Clean-up', () => forEachText(app.deck.slides, (ps) => { n += cleanParas(ps); }));
      }
      toast(n ? `Cleaned ${n} paragraph(s).` : 'Nothing needed cleaning.');
    },
  },
  {
    id: 'tools.notesToDoc', label: 'Speaker Notes to Script', icon: 'description', tab: 'Tools', group: 'Reports', edits: false, noRecord: true, isEnabled: hasSlides,
    tip: 'Download the speaker notes as a script (Markdown, opens in Anne\'s Pen)',
    run: (app) => {
      const md = app.deck.slides.map((s, i) => {
        const title = slideTitle(s) || `Slide ${i + 1}`;
        const notes = s.notes.map((p) => '  '.repeat(p.level) + paraText(p)).join('\n').trim();
        const body = bodyShape(s)?.text?.paras.map((p) => `${'  '.repeat(p.level)}- ${paraText(p)}`).filter((l) => l.trim() !== '-').join('\n');
        return `## ${i + 1}. ${title}\n\n${notes || (body ? `*(no notes; slide text:)*\n\n${body}` : '*(no notes)*')}\n`;
      }).join('\n');
      download(new Blob([`# ${app.deck.data.props.title || app.tab.displayName} — Script\n\n${md}`], { type: 'text/markdown' }), `${(app.tab.displayName || 'presentation').replace(/\.[^.]+$/, '')} script.md`);
    },
  },
]);

