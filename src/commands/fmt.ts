/** Character and paragraph formatting (Home ▸ Font and Paragraph). */
import { def } from './registry';
import type { App } from '../app';
import type { Bullet, NumScheme, Paragraph, RunProps } from '../model/types';
import { applyRun, applyPara, applyBody, currentRun, currentPara, textTargets, edit } from '../edit/ops';
import { activeTextEditor } from '../edit/textEdit';
import { levelStyle } from '../model/inherit';
import { themeColorMenu } from '../ui/themeColors';
import { openDialog, toast } from '../ui/dialog';
import { FONT_LIST } from '../fonts';
import { forEachText } from '../edit/ops';

const SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 44, 48, 54, 60, 66, 72, 80, 88, 96];

/** The effective font size at the caret or of the selected shape's first run (inherited when not set). */
function effectiveSize(app: App): number | null {
  const r = currentRun(app);
  if (r.size) return r.size;
  const s = textTargets(app)[0];
  if (!s || !app.owner) return null;
  const p = currentPara(app);
  return levelStyle(app.deck, app.owner, s, (p as Paragraph).level || 0).run?.size ?? null;
}

const hasText = (app: App) => !!app.tab?.ui && (app.tab.ui.editingText || textTargets(app).length > 0 || app.selected.some((e) => e.kind === 'table'));

function toggleRun(app: App, key: 'b' | 'i' | 'u' | 'strike', label: string): void {
  const cur = !!currentRun(app)[key];
  applyRun(app, { [key]: !cur } as Partial<RunProps>, label);
}

function stepSize(app: App, dir: 1 | -1): void {
  applyRun(app, (r) => {
    const base = r.size ?? effectiveSize(app) ?? 18;
    const i = dir > 0 ? SIZES.findIndex((s) => s > base) : SIZES.length - 1 - [...SIZES].reverse().findIndex((s) => s < base);
    return { size: i >= 0 && i < SIZES.length ? SIZES[i] : Math.max(1, base + dir * 4) };
  }, dir > 0 ? 'Increase Font Size' : 'Decrease Font Size');
}

const caseFns: Record<string, (t: string, start: boolean) => string> = {
  sentence: (t, start) => (start ? t.charAt(0).toUpperCase() + t.slice(1).toLowerCase() : t.toLowerCase()),
  lower: (t) => t.toLowerCase(),
  upper: (t) => t.toUpperCase(),
  title: (t) => t.toLowerCase().replace(/(^|[\s(\-"“])(\p{L})/gu, (_m, a, b) => a + b.toUpperCase()),
  toggle: (t) => [...t].map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join(''),
};

function changeCase(app: App, mode: string): void {
  const fn = caseFns[mode];
  if (!fn) return;
  const ed = activeTextEditor();
  if (ed) {
    const t = ed.selectedText();
    if (!t) { toast('Select some text first.'); return; }
    document.execCommand('insertText', false, mode === 'sentence' ? t.split(/(?<=[.!?]\s+)/).map((s) => fn(s, true)).join('') : fn(t, true));
    return;
  }
  const shapes = textTargets(app);
  if (!shapes.length) { toast('Select a shape or text first.'); return; }
  edit(app, 'Change Case', () => {
    forEachText([{ elements: shapes }], (paras) => {
      for (const p of paras) { let first = true; for (const r of p.runs) { if (!r.text) continue; r.text = mode === 'sentence' ? r.text.split(/(?<=[.!?]\s+)/).map((s, i) => fn(s, first && i === 0)).join('') : fn(r.text, first); first = false; } }
    }, false);
  });
}

const NUM_SCHEMES: { scheme: NumScheme; label: string }[] = [
  { scheme: 'arabicPeriod', label: '1. 2. 3.' }, { scheme: 'arabicParenR', label: '1) 2) 3)' }, { scheme: 'romanUcPeriod', label: 'I. II. III.' },
  { scheme: 'alphaUcPeriod', label: 'A. B. C.' }, { scheme: 'alphaLcParenR', label: 'a) b) c)' }, { scheme: 'alphaLcPeriod', label: 'a. b. c.' }, { scheme: 'romanLcPeriod', label: 'i. ii. iii.' },
];
const BULLET_CHARS = ['•', '◦', '▪', '■', '◆', '➢', '✓', '–', '→', '★'];

function setBullet(app: App, b: Bullet | null, label: string): void {
  applyPara(app, (p) => {
    if (!b) return { bullet: { kind: 'none' } as Bullet, indent: 0, marL: p.level * 36 };
    const marL = 18 + 36 * p.level;
    return { bullet: b, marL, indent: -18 };
  }, label);
}

function currentBulletKind(app: App): string {
  const p = currentPara(app) as Paragraph;
  if (p.bullet) return p.bullet.kind;
  const s = textTargets(app)[0];
  if (!s || !app.owner) return 'none';
  return levelStyle(app.deck, app.owner, s, p.level || 0).bullet?.kind || 'none';
}

def([
  {
    id: 'fmt.font', label: 'Font', icon: 'font_download', tab: 'Home', group: 'Font', kind: 'font', keys: ['Mod-Shift-f'], edits: true,
    run: (app, font?: string) => { if (!font) { app.ui.anchorFor('fmt.font').click(); return; } applyRun(app, { font }, 'Font'); },
    menu: () => FONT_LIST.map((f) => ({ id: 'fmt.font', arg: f, label: f, preview: `font-family:"${f}"` })),
    value: (app) => currentRun(app).font || null,
  },
  {
    id: 'fmt.fontSize', label: 'Font Size', icon: 'format_size', tab: 'Home', group: 'Font', kind: 'size', keys: ['Mod-Shift-p'], edits: true,
    run: (app, size?: number) => { if (typeof size !== 'number' || !(size > 0)) { (app.ui.root.querySelector('input[data-combo="fmt.fontSize"]') as HTMLInputElement | null)?.focus(); return; } applyRun(app, { size: Math.min(4000, Math.round(size * 2) / 2) }, 'Font Size'); },
    menu: () => SIZES.map((s) => ({ id: 'fmt.fontSize', arg: s, label: String(s) })),
    value: (app) => (hasText(app) ? effectiveSize(app) : null),
  },
  { id: 'fmt.growFont', label: 'Increase Font Size', icon: 'text_increase', tab: 'Home', group: 'Font', keys: ['Mod-Shift-.'], edits: true, run: (app) => stepSize(app, 1) },
  { id: 'fmt.shrinkFont', label: 'Decrease Font Size', icon: 'text_decrease', tab: 'Home', group: 'Font', keys: ['Mod-Shift-,'], edits: true, run: (app) => stepSize(app, -1) },
  {
    id: 'fmt.clearFormatting', label: 'Clear All Formatting', icon: 'format_clear', tab: 'Home', group: 'Font', keys: ['Mod-Space'], edits: true,
    tip: 'Remove character formatting so the text follows its placeholder and theme',
    run: (app) => applyRun(app, (r) => Object.fromEntries(Object.keys(r).filter((k) => !['text', 'br', 'field', 'link', 'lang'].includes(k)).map((k) => [k, undefined])), 'Clear Formatting'),
  },
  { id: 'fmt.bold', label: 'Bold', icon: 'format_bold', tab: 'Home', group: 'Font', keys: ['Mod-b'], kind: 'toggle', edits: true, isActive: (app) => !!currentRun(app).b, run: (app) => toggleRun(app, 'b', 'Bold') },
  { id: 'fmt.italic', label: 'Italic', icon: 'format_italic', tab: 'Home', group: 'Font', keys: ['Mod-i'], kind: 'toggle', edits: true, isActive: (app) => !!currentRun(app).i, run: (app) => toggleRun(app, 'i', 'Italic') },
  {
    id: 'fmt.underline', label: 'Underline', icon: 'format_underlined', tab: 'Home', group: 'Font', keys: ['Mod-u'], kind: 'split', edits: true, isActive: (app) => !!currentRun(app).u,
    menu: () => [{ id: 'fmt.underline', arg: 'single', label: 'Single' }, { id: 'fmt.underline', arg: 'dbl', label: 'Double' }, { id: 'fmt.underline', arg: 'wavy', label: 'Wavy' }, { id: 'fmt.underline', arg: 'none', label: 'None' }],
    run: (app, arg?: string) => { if (!arg) return toggleRun(app, 'u', 'Underline'); applyRun(app, { u: arg === 'none' ? undefined : arg === 'single' ? true : (arg as any) }, 'Underline'); },
  },
  { id: 'fmt.strike', label: 'Strikethrough', icon: 'strikethrough_s', tab: 'Home', group: 'Font', kind: 'toggle', edits: true, isActive: (app) => !!currentRun(app).strike, run: (app) => toggleRun(app, 'strike', 'Strikethrough') },
  { id: 'fmt.doubleStrike', label: 'Double Strikethrough', icon: 'format_strikethrough', tab: 'Home', group: 'Font', kind: 'toggle', edits: true, isActive: (app) => currentRun(app).strike === 'dbl', run: (app) => applyRun(app, { strike: currentRun(app).strike === 'dbl' ? undefined : 'dbl' }, 'Double Strikethrough') },
  { id: 'fmt.superscript', label: 'Superscript', icon: 'superscript', tab: 'Home', group: 'Font', keys: ['Mod-Shift-='], kind: 'toggle', edits: true, isActive: (app) => (currentRun(app).baseline || 0) > 0, run: (app) => applyRun(app, { baseline: (currentRun(app).baseline || 0) > 0 ? undefined : 30 }, 'Superscript') },
  { id: 'fmt.subscript', label: 'Subscript', icon: 'subscript', tab: 'Home', group: 'Font', keys: ['Mod-='], kind: 'toggle', edits: true, isActive: (app) => (currentRun(app).baseline || 0) < 0, run: (app) => applyRun(app, { baseline: (currentRun(app).baseline || 0) < 0 ? undefined : -25 }, 'Subscript') },
  { id: 'fmt.smallCaps', label: 'Small Caps', icon: 'text_fields', tab: 'Home', group: 'Font', kind: 'toggle', edits: true, isActive: (app) => currentRun(app).caps === 'small', run: (app) => applyRun(app, { caps: currentRun(app).caps === 'small' ? undefined : 'small' }, 'Small Caps') },
  { id: 'fmt.allCaps', label: 'All Caps', icon: 'title', tab: 'Home', group: 'Font', keys: ['Mod-Shift-a'], kind: 'toggle', edits: true, isActive: (app) => currentRun(app).caps === 'all', run: (app) => applyRun(app, { caps: currentRun(app).caps === 'all' ? undefined : 'all' }, 'All Caps') },
  {
    id: 'fmt.shadow', label: 'Text Shadow', icon: 'texture', tab: 'Home', group: 'Font', kind: 'toggle', edits: true,
    tip: 'A soft shadow behind the selected shapes (text and fill)',
    isActive: (app) => textTargets(app).some((s) => !!s.effects?.shadow),
    run: (app) => { const on = textTargets(app).some((s) => !!s.effects?.shadow); edit(app, 'Text Shadow', () => { for (const s of textTargets(app)) s.effects = on ? { ...(s.effects || {}), shadow: undefined } : { ...(s.effects || {}), shadow: { color: '#000000', blur: 3, dist: 2, dir: 45, alpha: 0.45 } }; }); },
  },
  {
    id: 'fmt.charSpacing', label: 'Character Spacing', icon: 'format_letter_spacing', tab: 'Home', group: 'Font', kind: 'menu', edits: true,
    menu: () => [{ id: 'fmt.charSpacing', arg: -3, label: 'Very Tight' }, { id: 'fmt.charSpacing', arg: -1.5, label: 'Tight' }, { id: 'fmt.charSpacing', arg: 0, label: 'Normal' }, { id: 'fmt.charSpacing', arg: 3, label: 'Loose' }, { id: 'fmt.charSpacing', arg: 6, label: 'Very Loose' }, { separator: true }, { id: 'fmt.fontDialog', label: 'More Spacing…' }],
    run: (app, n?: number) => { if (typeof n !== 'number') { app.exec('fmt.fontDialog'); return; } applyRun(app, { spc: n || undefined }, 'Character Spacing'); },
  },
  {
    id: 'fmt.changeCase', label: 'Change Case', icon: 'match_case', tab: 'Home', group: 'Font', kind: 'menu', keys: ['Shift-F3'], edits: true,
    menu: () => [{ id: 'fmt.changeCase', arg: 'sentence', label: 'Sentence case.' }, { id: 'fmt.changeCase', arg: 'lower', label: 'lowercase' }, { id: 'fmt.changeCase', arg: 'upper', label: 'UPPERCASE' }, { id: 'fmt.changeCase', arg: 'title', label: 'Capitalize Each Word' }, { id: 'fmt.changeCase', arg: 'toggle', label: 'tOGGLE cASE' }],
    run: (app, mode?: string) => {
      if (mode) { changeCase(app, mode); return; }
      // Shift+F3 cycles: lower → UPPER → Sentence (based on the selected text).
      const t = activeTextEditor()?.selectedText() || textTargets(app).map((s) => s.text?.paras.map((p) => p.runs.map((r) => r.text).join('')).join('')).join('');
      changeCase(app, t === t.toLowerCase() ? 'upper' : t === t.toUpperCase() ? 'sentence' : 'lower');
    },
  },
  {
    id: 'fmt.fontColor', label: 'Font Color', icon: 'format_color_text', tab: 'Home', group: 'Font', kind: 'color', edits: true,
    run: async (app, arg) => {
      if (arg === 'menu' || arg === undefined) {
        const c = await themeColorMenu(app, app.ui.anchorFor('fmt.fontColor'), { auto: 'Automatic' });
        if (c === undefined) return;
        applyRun(app, { color: c ?? undefined }, 'Font Color');
        (app as any).lastFontColor = c;
        return;
      }
      applyRun(app, { color: arg }, 'Font Color');
    },
  },
  {
    id: 'fmt.highlight', label: 'Text Highlight Color', icon: 'ink_highlighter', tab: 'Home', group: 'Font', kind: 'color', edits: true,
    run: async (app, arg) => {
      if (arg === 'menu' || arg === undefined) {
        const c = await themeColorMenu(app, app.ui.anchorFor('fmt.highlight'), { none: 'No Color' });
        if (c === undefined) return;
        applyRun(app, { highlight: c ?? undefined }, 'Highlight');
        return;
      }
      applyRun(app, { highlight: arg }, 'Highlight');
    },
  },
  {
    id: 'fmt.fontDialog', label: 'Font…', icon: 'text_format', tab: 'Home', group: 'Font', keys: ['Mod-t'], edits: true,
    run: async (app) => {
      const r = currentRun(app);
      const v = await openDialog({ title: 'Font', fields: [
        { key: 'font', label: 'Latin text font', type: 'combo', options: ['(theme body)', '(theme headings)', ...FONT_LIST], value: r.font === '+mn-lt' ? '(theme body)' : r.font === '+mj-lt' ? '(theme headings)' : r.font || '', half: true },
        { key: 'size', label: 'Size', type: 'number', value: r.size ?? effectiveSize(app) ?? 18, min: 1, max: 4000, step: 0.5, half: true },
        { key: 'b', label: 'Bold', type: 'checkbox', value: !!r.b, half: true }, { key: 'i', label: 'Italic', type: 'checkbox', value: !!r.i, half: true },
        { key: 'u', label: 'Underline', type: 'select', options: [{ value: '', label: '(none)' }, { value: 'single', label: 'Single' }, { value: 'dbl', label: 'Double' }, { value: 'wavy', label: 'Wavy' }], value: r.u === true ? 'single' : r.u || '', half: true },
        { key: 'strike', label: 'Strikethrough', type: 'select', options: [{ value: '', label: '(none)' }, { value: 'single', label: 'Single' }, { value: 'dbl', label: 'Double' }], value: r.strike === true ? 'single' : r.strike || '', half: true },
        { key: 'baseline', label: 'Offset (% of size: + superscript, − subscript)', type: 'number', value: r.baseline || 0, min: -100, max: 100, half: true },
        { key: 'caps', label: 'Capitals', type: 'select', options: [{ value: '', label: 'Normal' }, { value: 'small', label: 'Small caps' }, { value: 'all', label: 'All caps' }], value: r.caps || '', half: true },
        { key: 'spc', label: 'Character spacing (points)', type: 'number', value: r.spc || 0, step: 0.1, min: -20, max: 100, half: true },
      ] });
      if (!v) return;
      const font = v.font === '(theme body)' ? '+mn-lt' : v.font === '(theme headings)' ? '+mj-lt' : v.font || undefined;
      applyRun(app, { font, size: +v.size || undefined, b: v.b || undefined, i: v.i || undefined, u: v.u === 'single' ? true : v.u || undefined, strike: v.strike === 'single' ? true : v.strike || undefined, baseline: +v.baseline || undefined, caps: v.caps || undefined, spc: +v.spc || undefined }, 'Font');
    },
  },
]);

// Paragraph ------------------------------------------------------------------------------------

def([
  {
    id: 'fmt.bullets', label: 'Bullets', icon: 'format_list_bulleted', tab: 'Home', group: 'Paragraph', kind: 'split', edits: true,
    isActive: (app) => currentBulletKind(app) === 'char',
    menu: () => [{ id: 'fmt.bullets', arg: 'none', label: 'None' }, ...BULLET_CHARS.map((c) => ({ id: 'fmt.bullets', arg: c, label: `${c}  Bullet` })), { separator: true }, { id: 'fmt.bulletsDialog', label: 'Bullets and Numbering…' }],
    run: (app, arg?: string) => {
      if (arg === 'none') return setBullet(app, null, 'Bullets');
      if (arg) return setBullet(app, { kind: 'char', char: arg }, 'Bullets');
      setBullet(app, currentBulletKind(app) === 'char' ? null : { kind: 'char', char: '•' }, 'Bullets');
    },
  },
  {
    id: 'fmt.numbering', label: 'Numbering', icon: 'format_list_numbered', tab: 'Home', group: 'Paragraph', kind: 'split', edits: true,
    isActive: (app) => currentBulletKind(app) === 'num',
    menu: () => [{ id: 'fmt.numbering', arg: 'none', label: 'None' }, ...NUM_SCHEMES.map((s) => ({ id: 'fmt.numbering', arg: s.scheme, label: s.label })), { separator: true }, { id: 'fmt.bulletsDialog', label: 'Bullets and Numbering…' }],
    run: (app, arg?: string) => {
      if (arg === 'none') return setBullet(app, null, 'Numbering');
      if (arg) return setBullet(app, { kind: 'num', scheme: arg as NumScheme }, 'Numbering');
      setBullet(app, currentBulletKind(app) === 'num' ? null : { kind: 'num', scheme: 'arabicPeriod' }, 'Numbering');
    },
  },
  {
    id: 'fmt.bulletsDialog', label: 'Bullets and Numbering…', icon: 'list', tab: 'Home', group: 'Paragraph', edits: true,
    run: async (app) => {
      const p = currentPara(app) as Paragraph;
      const b = p.bullet;
      const v = await openDialog({ title: 'Bullets and Numbering', fields: [
        { key: 'kind', label: 'Type', type: 'radio', options: [{ value: 'none', label: 'None' }, { value: 'char', label: 'Bulleted' }, { value: 'num', label: 'Numbered' }], value: b?.kind || 'char' },
        { key: 'char', label: 'Bullet character', type: 'combo', options: BULLET_CHARS, value: b?.char || '•', visibleIf: (x) => x.kind === 'char', half: true },
        { key: 'scheme', label: 'Numbering', type: 'select', options: NUM_SCHEMES.map((s) => ({ value: s.scheme, label: s.label })), value: b?.scheme || 'arabicPeriod', visibleIf: (x) => x.kind === 'num', half: true },
        { key: 'start', label: 'Start at', type: 'number', min: 1, max: 32767, value: b?.startAt || 1, visibleIf: (x) => x.kind === 'num', half: true },
        { key: 'size', label: 'Size (% of text)', type: 'number', min: 25, max: 400, value: b?.size || 100, half: true },
      ] });
      if (!v) return;
      if (v.kind === 'none') return setBullet(app, null, 'Bullets and Numbering');
      const bullet: Bullet = v.kind === 'num' ? { kind: 'num', scheme: v.scheme, startAt: +v.start > 1 ? +v.start : undefined, size: +v.size !== 100 ? +v.size : undefined } : { kind: 'char', char: String(v.char || '•').slice(0, 2), size: +v.size !== 100 ? +v.size : undefined };
      setBullet(app, bullet, 'Bullets and Numbering');
    },
  },
  { id: 'fmt.indent', label: 'Increase List Level', icon: 'format_indent_increase', tab: 'Home', group: 'Paragraph', keys: ['Alt-Shift-ArrowRight'], edits: true, tip: 'In Outline view, demotes the slide or paragraph', run: (app, arg) => app.tab.view === 'outline' && !app.tab.ui.editingText && arg !== 'para' ? app.exec('outline.demote') : applyPara(app, (p) => ({ level: Math.min(8, p.level + 1), ...(p.marL != null ? { marL: p.marL + 36 } : {}) }), 'Increase List Level') },
  { id: 'fmt.outdent', label: 'Decrease List Level', icon: 'format_indent_decrease', tab: 'Home', group: 'Paragraph', keys: ['Alt-Shift-ArrowLeft'], edits: true, tip: 'In Outline view, promotes the slide or paragraph', run: (app, arg) => app.tab.view === 'outline' && !app.tab.ui.editingText && arg !== 'para' ? app.exec('outline.promote') : applyPara(app, (p) => ({ level: Math.max(0, p.level - 1), ...(p.marL != null ? { marL: Math.max(0, p.marL - 36) } : {}) }), 'Decrease List Level') },
  {
    id: 'fmt.lineSpacing', label: 'Line Spacing', icon: 'format_line_spacing', tab: 'Home', group: 'Paragraph', kind: 'menu', edits: true,
    menu: () => [...[1, 1.15, 1.5, 2, 2.5, 3].map((x) => ({ id: 'fmt.lineSpacing', arg: x * 100, label: String(x) })), { separator: true }, { id: 'fmt.paragraphDialog', label: 'Line Spacing Options…' }],
    run: (app, pct?: number) => { if (typeof pct !== 'number') { app.exec('fmt.paragraphDialog'); return; } applyPara(app, { lineSpacing: pct, lineSpacingPt: undefined }, 'Line Spacing'); },
  },
  { id: 'fmt.alignLeft', label: 'Align Left', icon: 'format_align_left', tab: 'Home', group: 'Paragraph', keys: ['Mod-l'], kind: 'toggle', edits: true, isActive: (app) => hasText(app) && ((currentPara(app).align || 'l') === 'l'), run: (app) => applyPara(app, { align: 'l' }, 'Align Left') },
  { id: 'fmt.alignCenter', label: 'Center', icon: 'format_align_center', tab: 'Home', group: 'Paragraph', keys: ['Mod-e'], kind: 'toggle', edits: true, isActive: (app) => currentPara(app).align === 'ctr', run: (app) => applyPara(app, { align: 'ctr' }, 'Center') },
  { id: 'fmt.alignRight', label: 'Align Right', icon: 'format_align_right', tab: 'Home', group: 'Paragraph', keys: ['Mod-r'], kind: 'toggle', edits: true, isActive: (app) => currentPara(app).align === 'r', run: (app) => applyPara(app, { align: 'r' }, 'Align Right') },
  { id: 'fmt.justify', label: 'Justify', icon: 'format_align_justify', tab: 'Home', group: 'Paragraph', keys: ['Mod-j'], kind: 'toggle', edits: true, isActive: (app) => currentPara(app).align === 'just', run: (app) => applyPara(app, { align: 'just' }, 'Justify') },
  { id: 'fmt.distribute', label: 'Distributed', icon: 'format_align_justify', tab: 'Home', group: 'Paragraph', keys: ['Mod-Shift-j'], kind: 'toggle', edits: true, isActive: (app) => currentPara(app).align === 'dist', run: (app) => applyPara(app, { align: 'dist' }, 'Distributed') },
  {
    id: 'fmt.columns', label: 'Columns', icon: 'view_column', tab: 'Home', group: 'Paragraph', kind: 'menu', edits: true,
    tip: 'Text columns in the selected text box',
    menu: () => [1, 2, 3].map((n) => ({ id: 'fmt.columns', arg: n, label: `${n} Column${n > 1 ? 's' : ''}` })),
    run: (app, n?: number) => applyBody(app, { columns: (n || 1) > 1 ? n : undefined }, 'Columns'),
  },
  {
    id: 'fmt.textDirection', label: 'Text Direction', icon: 'text_rotate_vertical', tab: 'Home', group: 'Paragraph', kind: 'menu', edits: true,
    menu: () => [{ id: 'fmt.textDirection', arg: 'horz', label: 'Horizontal' }, { id: 'fmt.textDirection', arg: 'vert', label: 'Rotate all text 90°' }, { id: 'fmt.textDirection', arg: 'vert270', label: 'Rotate all text 270°' }],
    run: (app, d?: 'horz' | 'vert' | 'vert270') => applyBody(app, { vert: d && d !== 'horz' ? d : undefined }, 'Text Direction'),
  },
  {
    id: 'fmt.verticalAlign', label: 'Align Text', icon: 'vertical_align_center', tab: 'Home', group: 'Paragraph', kind: 'menu', edits: true,
    menu: () => [{ id: 'fmt.verticalAlign', arg: 't', label: 'Top', icon: 'vertical_align_top' }, { id: 'fmt.verticalAlign', arg: 'ctr', label: 'Middle', icon: 'vertical_align_center' }, { id: 'fmt.verticalAlign', arg: 'b', label: 'Bottom', icon: 'vertical_align_bottom' }],
    run: (app, a?: 't' | 'ctr' | 'b') => applyBody(app, { anchor: a || 'ctr' }, 'Align Text'),
  },
  { id: 'fmt.rtl', label: 'Right-to-Left Text Direction', icon: 'format_textdirection_r_to_l', tab: 'Home', group: 'Paragraph', edits: true, run: (app) => applyPara(app, { rtl: true, align: 'r' }, 'Right-to-Left') },
  { id: 'fmt.ltr', label: 'Left-to-Right Text Direction', icon: 'format_textdirection_l_to_r', tab: 'Home', group: 'Paragraph', edits: true, run: (app) => applyPara(app, { rtl: undefined, align: 'l' }, 'Left-to-Right') },
  {
    id: 'fmt.paragraphDialog', label: 'Paragraph…', icon: 'format_paragraph', tab: 'Home', group: 'Paragraph', edits: true,
    run: async (app) => {
      const p = currentPara(app) as Paragraph;
      const s = textTargets(app)[0];
      const st = s && app.owner ? levelStyle(app.deck, app.owner, s, p.level || 0) : {};
      const v = await openDialog({ title: 'Paragraph', fields: [
        { key: 'h1', type: 'heading', label: 'General' },
        { key: 'align', label: 'Alignment', type: 'select', options: [{ value: 'l', label: 'Left' }, { value: 'ctr', label: 'Centered' }, { value: 'r', label: 'Right' }, { value: 'just', label: 'Justified' }, { value: 'dist', label: 'Distributed' }], value: p.align || st.align || 'l' },
        { key: 'h2', type: 'heading', label: 'Indentation' },
        { key: 'marL', label: 'Before text (pt)', type: 'number', value: p.marL ?? st.marL ?? 0, step: 1, half: true },
        { key: 'indent', label: 'First line / hanging (pt; negative = hanging)', type: 'number', value: p.indent ?? st.indent ?? 0, step: 1, half: true },
        { key: 'h3', type: 'heading', label: 'Spacing' },
        { key: 'before', label: 'Before (pt)', type: 'number', min: 0, value: p.spaceBefore ?? st.spaceBefore ?? 0, half: true },
        { key: 'after', label: 'After (pt)', type: 'number', min: 0, value: p.spaceAfter ?? st.spaceAfter ?? 0, half: true },
        { key: 'mode', label: 'Line spacing', type: 'select', options: [{ value: 'mult', label: 'Multiple' }, { value: 'exact', label: 'Exactly (pt)' }], value: (p.lineSpacingPt ?? st.lineSpacingPt) ? 'exact' : 'mult', half: true },
        { key: 'ls', label: 'At', type: 'number', min: 0, step: 0.05, value: (p.lineSpacingPt ?? st.lineSpacingPt) ? (p.lineSpacing ?? st.lineSpacing ?? 20) : ((p.lineSpacing ?? st.lineSpacing ?? 100) / 100), half: true },
      ] });
      if (!v) return;
      applyPara(app, { align: v.align, marL: +v.marL, indent: +v.indent, spaceBefore: +v.before, spaceAfter: +v.after, lineSpacingPt: v.mode === 'exact' ? true : undefined, lineSpacing: v.mode === 'exact' ? +v.ls : Math.round(+v.ls * 100) }, 'Paragraph');
    },
  },
]);
