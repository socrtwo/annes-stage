/**
 * In-place text editing: a contenteditable island laid over the shape, bound to the model. The
 * paragraphs are read back from the DOM on every change of formatting and when editing ends, so the
 * browser's own editing (typing, IME, spell checking, undo inside the island) is kept.
 *
 * Positions are character offsets per paragraph (a line break counts as one character), so
 * formatting is applied by splitting runs in the model and re-rendering the island.
 */
import type { App } from '../app';
import type { Paragraph, ParaProps, Run, RunProps, ShapeElement, LevelStyle } from '../model/types';
import { levelStyle, resolveBody, masterOfOwner, type Owner } from '../model/inherit';
import { cssColor, themeFont, type ColorContext } from '../model/theme';
import { bulletText } from '../render/text';
import { fontFamilyCss } from '../fonts';

let active: TextEditor | null = null;
export function activeTextEditor(): TextEditor | null { return active; }

interface Pos { para: number; off: number }

const RUN_KEYS: (keyof RunProps)[] = ['b', 'i', 'u', 'strike', 'size', 'font', 'color', 'highlight', 'baseline', 'caps', 'spc', 'link', 'lang'];

export class TextEditor {
  root: HTMLDivElement;
  private cc: ColorContext;
  private styles = new Map<number, LevelStyle>();
  onDone: ((commit: boolean) => void) | null = null;
  changed = false;

  constructor(public app: App, public owner: Owner, public el: ShapeElement, host: HTMLElement, box: { x: number; y: number; w: number; h: number; rot: number }, private selectAll = false) {
    const deck = app.deck;
    const master = masterOfOwner(deck, owner);
    this.cc = { theme: deck.theme(master.theme), master };
    const body = resolveBody(deck, owner, el);
    const ins = body.insets || [7.2, 3.6, 7.2, 3.6];
    this.root = document.createElement('div');
    this.root.className = 'qs-textedit';
    this.root.contentEditable = 'true';
    this.root.spellcheck = app.prefs.spellcheck;
    this.root.setAttribute('role', 'textbox');
    this.root.setAttribute('aria-multiline', 'true');
    this.root.setAttribute('aria-label', el.name || 'Text');
    const s = this.root.style;
    s.left = `${box.x}px`; s.top = `${box.y}px`; s.width = `${box.w}px`; s.minHeight = `${box.h}px`;
    s.padding = `${ins[1]}px ${ins[2]}px ${ins[3]}px ${ins[0]}px`;
    if (box.rot) s.transform = `rotate(${box.rot}deg)`;
    s.display = 'flex'; s.flexDirection = 'column';
    s.justifyContent = body.anchor === 'ctr' ? 'center' : body.anchor === 'b' ? 'flex-end' : 'flex-start';
    if (body.fontScale && body.fontScale < 1) s.setProperty('--qs-font-scale', String(body.fontScale));
    this.render(el.text?.paras?.length ? el.text.paras : [{ level: 0, runs: [] }]);
    host.appendChild(this.root);
    this.root.addEventListener('keydown', (e) => this.onKey(e));
    this.root.addEventListener('input', (e) => this.onInput(e as InputEvent));
    this.root.addEventListener('paste', (e) => this.onPaste(e));
    active = this;
    // Focus and place the caret right away (not in a later frame) so keys typed immediately after
    // the double-click or type-to-edit keystroke land in the editor.
    this.root.focus({ preventScroll: true });
    if (this.selectAll) { const r = document.createRange(); r.selectNodeContents(this.root); setSel(r); }
    else this.setPos({ para: this.root.children.length - 1, off: Infinity });
  }

  private style(level: number): LevelStyle {
    let s = this.styles.get(level);
    if (!s) { s = levelStyle(this.app.deck, this.owner, this.el, level); this.styles.set(level, s); }
    return s;
  }

  // ------------------------------------------------------------------------------------------
  // Model → DOM

  render(paras: Paragraph[], sel?: [Pos, Pos]): void {
    this.root.textContent = '';
    const counters: number[] = [];
    paras.forEach((p) => {
      const st = this.style(p.level);
      const d = document.createElement('div');
      d.className = 'qs-tp';
      d.dataset.level = String(p.level);
      const pp = { ...st, ...stripUndef(p) } as LevelStyle & Paragraph;
      if (Object.keys(paraOnly(p)).length) d.dataset.p = JSON.stringify(paraOnly(p));
      const marL = pp.marL ?? 0, indent = pp.indent ?? 0;
      d.style.paddingLeft = `${marL}px`;
      d.style.textIndent = `${indent}px`;
      d.style.textAlign = ({ l: 'left', ctr: 'center', r: 'right', just: 'justify', dist: 'justify' } as any)[pp.align || 'l'];
      if (pp.spaceBefore) d.style.marginTop = `${pp.spaceBefore}px`;
      if (pp.spaceAfter) d.style.marginBottom = `${pp.spaceAfter}px`;
      d.style.lineHeight = pp.lineSpacingPt ? `${pp.lineSpacing}px` : `${1.2 * ((pp.lineSpacing ?? 100) / 100)}`;
      const base = st.run || {};
      d.style.fontSize = `calc(${base.size ?? 18}px * var(--qs-font-scale, 1))`;
      d.style.fontFamily = fontFamilyCss(themeFont(base.font, this.cc.theme) || this.cc.theme.fonts.minor);
      d.style.color = cssColor(base.color, this.cc);
      const bullet = p.bullet ?? st.bullet;
      const hasText = p.runs.some((r) => r.text);
      // Empty paragraphs show no bullet and neither consume nor restart the numbering.
      if (hasText) {
        counters.length = Math.max(counters.length, p.level + 1);
        for (let k = p.level + 1; k < counters.length; k++) counters[k] = 0;
        if (bullet?.kind === 'num') counters[p.level] = (counters[p.level] || 0) + 1; else counters[p.level] = 0;
      }
      const bt = bullet && bullet.kind !== 'none' && hasText ? bulletText(bullet, Math.max(0, (counters[p.level] || 1) - 1)) : '';
      if (bt) { d.dataset.bullet = bt; d.style.setProperty('--qs-hang', `${Math.max(0, -indent)}px`); }
      for (const r of p.runs) {
        if (r.br) { d.appendChild(document.createElement('br')); continue; }
        if (!r.text) continue;
        const sp = document.createElement('span');
        sp.textContent = r.text;
        const props = runOnly(r);
        if (Object.keys(props).length) sp.dataset.r = JSON.stringify(props);
        this.styleSpan(sp, props);
        d.appendChild(sp);
      }
      if (p.end && Object.keys(p.end).length) d.dataset.end = JSON.stringify(p.end);
      // A trailing <br> keeps empty paragraphs (and a last line break) visible and editable.
      if (!d.lastChild || d.lastChild.nodeName === 'BR') d.appendChild(document.createElement('br'));
      this.root.appendChild(d);
    });
    if (sel) this.setRange(sel[0], sel[1]);
  }

  private styleSpan(sp: HTMLElement, r: RunProps): void {
    const s = sp.style;
    if (r.b) s.fontWeight = 'bold';
    if (r.b === false) s.fontWeight = 'normal';
    if (r.i) s.fontStyle = 'italic';
    if (r.i === false) s.fontStyle = 'normal';
    const dec = [r.u ? 'underline' : '', r.strike ? 'line-through' : ''].filter(Boolean).join(' ');
    if (dec) s.textDecoration = dec;
    if (r.size) s.fontSize = `calc(${r.size}px * var(--qs-font-scale, 1))`;
    if (r.font) s.fontFamily = fontFamilyCss(themeFont(r.font, this.cc.theme) || r.font);
    if (r.color) s.color = cssColor(r.color, this.cc);
    if (r.highlight) s.backgroundColor = cssColor(r.highlight, this.cc);
    if (r.baseline) { s.verticalAlign = r.baseline > 0 ? 'super' : 'sub'; s.fontSize = '0.67em'; }
    if (r.caps === 'all') s.textTransform = 'uppercase';
    if (r.caps === 'small') s.fontVariant = 'small-caps';
    if (r.spc) s.letterSpacing = `${r.spc}px`;
    if (r.link) { s.textDecoration = 'underline'; s.color = cssColor('hlink', this.cc); }
  }

  // ------------------------------------------------------------------------------------------
  // DOM → model

  read(): Paragraph[] {
    const out: Paragraph[] = [];
    const blocks = [...this.root.childNodes];
    // Stray text directly under the root (some browsers after select-all + type) becomes a paragraph.
    let loose: Node[] = [];
    const flushLoose = () => { if (loose.length) { const d = document.createElement('div'); loose.forEach((n) => d.appendChild(n.cloneNode(true))); out.push(this.readPara(d)); loose = []; } };
    for (const b of blocks) {
      if (b.nodeType === 1 && /^(DIV|P)$/.test((b as Element).tagName)) { flushLoose(); out.push(this.readPara(b as HTMLElement)); }
      else loose.push(b);
    }
    flushLoose();
    return out.length ? out : [{ level: 0, runs: [] }];
  }

  private readPara(d: HTMLElement): Paragraph {
    const level = Math.max(0, Math.min(8, +(d.dataset.level || 0)));
    const p: Paragraph = { level, runs: [], ...(d.dataset.p ? JSON.parse(d.dataset.p) : {}) };
    if (d.dataset.end) p.end = JSON.parse(d.dataset.end);
    const walk = (n: Node, props: RunProps) => {
      if (n.nodeType === 3) { const t = (n.nodeValue || '').replace(/ /g, ' ').replace(/​/g, ''); if (t) pushRun(p.runs, { ...props, text: t }); return; }
      if (n.nodeType !== 1) return;
      const e = n as HTMLElement;
      if (e.tagName === 'BR') { p.runs.push({ text: '', br: true }); return; }
      if (/^(DIV|P)$/.test(e.tagName) && e !== d) { p.runs.push({ text: '', br: true }); }
      const np = { ...props, ...this.propsOf(e) };
      for (const c of e.childNodes) walk(c, np);
    };
    for (const c of d.childNodes) walk(c, {});
    // Drop the trailing placeholder <br> (and a single trailing line break the browser adds).
    while (p.runs.length && p.runs[p.runs.length - 1].br) p.runs.pop();
    return p;
  }

  private propsOf(e: HTMLElement): RunProps {
    const r: RunProps = e.dataset.r ? JSON.parse(e.dataset.r) : {};
    const t = e.tagName;
    if (t === 'B' || t === 'STRONG') r.b = true;
    if (t === 'I' || t === 'EM') r.i = true;
    if (t === 'U') r.u = true;
    if (t === 'S' || t === 'STRIKE' || t === 'DEL') r.strike = true;
    if (t === 'SUP') r.baseline = 30;
    if (t === 'SUB') r.baseline = -25;
    if (t === 'A' && e.getAttribute('href')) r.link = e.getAttribute('href')!;
    // Inline styles from pasted or browser-generated markup (only when the span is not ours).
    if (!e.dataset.r && e.style) {
      const s = e.style;
      if (s.fontWeight) r.b = s.fontWeight === 'bold' || +s.fontWeight >= 600;
      if (s.fontStyle) r.i = s.fontStyle === 'italic';
      if (/underline/.test(s.textDecoration)) r.u = true;
      if (/line-through/.test(s.textDecoration)) r.strike = true;
      const fs = /^([\d.]+)(px|pt)$/.exec(s.fontSize);
      if (fs) r.size = Math.round(+fs[1] * (fs[2] === 'px' ? 0.75 : 1) * 2) / 2;
      if (s.color && /^#|^rgb/.test(s.color)) r.color = toHex(s.color);
      if (s.fontFamily) r.font = s.fontFamily.split(',')[0].replace(/["']/g, '').trim();
    }
    if (t === 'FONT') { const c = e.getAttribute('color'); if (c) r.color = toHex(c); const f = e.getAttribute('face'); if (f) r.font = f; }
    return r;
  }

  // ------------------------------------------------------------------------------------------
  // Positions

  private posOf(node: Node, offset: number): Pos {
    const blocks = [...this.root.children];
    let block: Node | null = node;
    while (block && block.parentNode !== this.root) block = block.parentNode;
    let para = block ? blocks.indexOf(block as Element) : 0;
    if (para < 0) para = 0;
    if (node === this.root) { para = Math.min(offset, blocks.length - 1); return { para: Math.max(0, para), off: offset >= blocks.length ? Infinity : 0 }; }
    let off = 0;
    let found = false;
    const walk = (n: Node): boolean => {
      if (n === node && n.nodeType === 3) { off += offset; return true; }
      if (n === node) { for (let i = 0; i < offset && i < n.childNodes.length; i++) off += lengthOf(n.childNodes[i]); return true; }
      if (n.nodeType === 3) { off += (n.nodeValue || '').length; return false; }
      if ((n as Element).tagName === 'BR') { if (n.nextSibling || n.parentNode !== block) off += 1; return false; }
      for (const c of n.childNodes) if (walk(c)) return true;
      return false;
    };
    if (block) found = walk(block);
    return { para, off: found ? off : 0 };
  }

  private nodeAt(pos: Pos): [Node, number] {
    const block = this.root.children[Math.max(0, Math.min(pos.para, this.root.children.length - 1))];
    if (!block) return [this.root, 0];
    let left = pos.off;
    let res: [Node, number] | null = null;
    const walk = (n: Node): boolean => {
      if (n.nodeType === 3) {
        const len = (n.nodeValue || '').length;
        if (left <= len) { res = [n, left]; return true; }
        left -= len;
        return false;
      }
      if ((n as Element).tagName === 'BR') {
        if (left === 0) { res = [n.parentNode!, [...n.parentNode!.childNodes].indexOf(n as ChildNode)]; return true; }
        if (n.nextSibling) left -= 1;
        return false;
      }
      for (const c of n.childNodes) if (walk(c)) return true;
      return false;
    };
    walk(block);
    if (res) return res;
    // End of paragraph: before the trailing <br>.
    const last = block.lastChild;
    if (last && last.nodeName === 'BR') return [block, block.childNodes.length - 1];
    return [block, block.childNodes.length];
  }

  getRange(): [Pos, Pos] | null {
    const s = window.getSelection();
    if (!s || !s.rangeCount) return null;
    const r = s.getRangeAt(0);
    if (!this.root.contains(r.startContainer)) return null;
    const a = this.posOf(r.startContainer, r.startOffset), b = this.posOf(r.endContainer, r.endOffset);
    return [a, b];
  }

  setRange(a: Pos, b: Pos): void {
    const r = document.createRange();
    const [n1, o1] = this.nodeAt(a);
    const [n2, o2] = this.nodeAt(b);
    try { r.setStart(n1, o1); r.setEnd(n2, o2); setSel(r); } catch { /* */ }
  }

  setPos(p: Pos): void { this.setRange(p, p); }

  // ------------------------------------------------------------------------------------------
  // Formatting

  /** Applies character formatting to the selection (or the word at the caret). */
  applyRun(props: Partial<RunProps> | ((cur: RunProps) => Partial<RunProps>)): void {
    const rng = this.getRange();
    const paras = this.read();
    if (!rng) return;
    let [a, b] = rng;
    // A collapsed caret formats the word around it and stays where it was.
    let restore: [Pos, Pos] | null = null;
    if (a.para === b.para && a.off === b.off) {
      restore = [a, a];
      // Collapsed: the word at the caret, or the paragraph's end mark for new typing.
      const text = paraText(paras[a.para]);
      let s = a.off, e = a.off;
      while (s > 0 && /\w/.test(text[s - 1])) s--;
      while (e < text.length && /\w/.test(text[e])) e++;
      if (s === e) {
        const p = paras[a.para];
        p.end = { ...(p.end || {}), ...(typeof props === 'function' ? props(p.end || {}) : props) };
        this.pendingRun = { ...(this.pendingRun || {}), ...(typeof props === 'function' ? props({}) : props) };
        this.render(paras, [a, a]);
        this.changed = true;
        return;
      }
      a = { para: a.para, off: s }; b = { para: a.para, off: e };
    }
    for (let pi = a.para; pi <= b.para; pi++) {
      const p = paras[pi];
      if (!p) continue;
      const from = pi === a.para ? a.off : 0;
      const to = pi === b.para ? b.off : Infinity;
      p.runs = splitRuns(p.runs, from, to, (r) => Object.assign(r, typeof props === 'function' ? props(r) : props));
      if (to === Infinity || to >= paraText(p).length) p.end = { ...(p.end || {}), ...(typeof props === 'function' ? props(p.end || {}) : props) };
    }
    this.render(paras, restore || [a, b]);
    this.changed = true;
  }

  private pendingRun: RunProps | null = null;

  /** Applies paragraph formatting to the paragraphs touched by the selection. */
  applyPara(props: Partial<ParaProps> | ((p: Paragraph) => Partial<Paragraph>)): void {
    const rng = this.getRange();
    const paras = this.read();
    const [a, b] = rng || [{ para: 0, off: 0 }, { para: paras.length - 1, off: Infinity }];
    for (let i = a.para; i <= b.para; i++) if (paras[i]) Object.assign(paras[i], typeof props === 'function' ? props(paras[i]) : props);
    this.render(paras, [a, b]);
    this.changed = true;
  }

  caretRun(): RunProps {
    const rng = this.getRange();
    const paras = this.read();
    if (!rng) return {};
    const p = paras[rng[0].para];
    if (!p) return {};
    let off = rng[0].off;
    for (const r of p.runs) {
      const len = r.br ? 1 : r.text.length;
      if (off <= len && !r.br) return runOnly(r);
      off -= len;
    }
    return { ...(p.end || {}) };
  }

  caretPara(): Partial<Paragraph> {
    const rng = this.getRange();
    const paras = this.read();
    return paras[rng?.[0].para ?? 0] || {};
  }

  /** Selected plain text. */
  selectedText(): string { return window.getSelection()?.toString() || ''; }

  // ------------------------------------------------------------------------------------------
  // Input

  private onKey(e: KeyboardEvent): void {
    if (e.key === 'Tab') {
      e.preventDefault();
      const rng = this.getRange();
      const atStart = rng && rng[0].off === 0;
      const multi = rng && rng[0].para !== rng[1].para;
      if (atStart || multi || e.shiftKey) this.applyPara((p) => ({ level: Math.max(0, Math.min(8, p.level + (e.shiftKey ? -1 : 1))) }));
      else document.execCommand('insertText', false, '\t');
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.finish(true); return; }
    e.stopPropagation();
  }

  private onInput(e: InputEvent): void {
    this.changed = true;
    if (this.pendingRun && e.inputType === 'insertText' && e.data) {
      // Typing after a formatting change at a collapsed caret: format the typed characters.
      const rng = this.getRange();
      if (rng) {
        const end = rng[0];
        const start = { para: end.para, off: Math.max(0, end.off - e.data.length) };
        const props = this.pendingRun;
        this.pendingRun = null;
        const paras = this.read();
        paras[end.para].runs = splitRuns(paras[end.para].runs, start.off, end.off, (r) => Object.assign(r, props));
        this.render(paras, [end, end]);
      }
    }
    if (e.inputType === 'insertText' && e.data && /[\s.,;:!?)]/.test(e.data)) this.autoCorrect(e.data);
    // Numbering and bullets refresh when paragraphs change.
    if (e.inputType === 'insertParagraph' || e.inputType === 'deleteContentBackward' || e.inputType === 'deleteContentForward') {
      const rng = this.getRange();
      const paras = this.read();
      if (this.app.prefs.autoLists && e.inputType === 'insertParagraph') this.autoList(paras, rng);
      this.render(paras, rng || undefined);
    }
  }

  private autoList(paras: Paragraph[], rng: [Pos, Pos] | null): void {
    if (!rng) return;
    const prev = paras[rng[0].para - 1];
    if (!prev || prev.bullet) return;
    const t = paraText(prev);
    const m = /^(\*|-|•)\s+/.exec(t) || /^(1)[.)]\s+/.exec(t);
    if (!m || this.el.ph) return;
    const num = m[1] === '1';
    for (const p of [prev, paras[rng[0].para]]) {
      p.bullet = num ? { kind: 'num', scheme: t.includes(')') ? 'arabicParenR' : 'arabicPeriod' } : { kind: 'char', char: '•' };
      p.marL = 18; p.indent = -18;
    }
    prev.runs = splitRuns(prev.runs, 0, m[0].length, (r) => { r.text = ''; }).filter((r) => r.text || r.br);
  }

  private autoCorrect(typed: string): void {
    const prefs = this.app.prefs;
    if (!prefs.autoCorrect) return;
    const s = window.getSelection();
    if (!s || !s.rangeCount) return;
    const node = s.anchorNode;
    if (!node || node.nodeType !== 3) return;
    const text = node.nodeValue || '';
    const caret = s.anchorOffset;
    const before = text.slice(0, caret - typed.length);
    const m = /(\S+)$/.exec(before);
    if (!m) return;
    const word = m[1];
    const reps = prefs.replacements || {};
    const own = (k: string): string | undefined => (Object.hasOwn(reps, k) && typeof reps[k] === 'string' ? reps[k] : undefined);
    const rep = own(word) ?? own(word.toLowerCase());
    let replacement: string | null = null;
    if (rep) replacement = /^[A-Z]/.test(word) && /^[a-z]/.test(rep) ? rep[0].toUpperCase() + rep.slice(1) : rep;
    else if (prefs.autoCapitalize && /^[a-z]/.test(word) && (before.length === word.length || /[.!?]\s+$/.test(before.slice(0, -word.length))) && /[\s.,;:!?]/.test(typed)) {
      // Capitalize the first word of a sentence (only at the start of the text node to stay predictable).
      const blockStart = this.getRange()?.[0].off === caret && before.length === word.length;
      if (blockStart || /[.!?]\s+$/.test(before.slice(0, -word.length))) replacement = word[0].toUpperCase() + word.slice(1);
    }
    if (replacement == null || replacement === word) return;
    const start = caret - typed.length - word.length;
    node.nodeValue = text.slice(0, start) + replacement + text.slice(caret - typed.length);
    const r = document.createRange();
    const pos = start + replacement.length + typed.length;
    r.setStart(node, Math.min(pos, node.nodeValue.length));
    r.collapse(true);
    setSel(r);
  }

  private onPaste(e: ClipboardEvent): void {
    // Paste as plain text in the current formatting (rich paste comes through Paste Special).
    const text = e.clipboardData?.getData('text/plain');
    if (text == null) return;
    e.preventDefault();
    document.execCommand('insertText', false, cleanPastedText(text));
  }

  /** Ends editing; commit writes the paragraphs back to the model in one undoable step. */
  finish(commit: boolean): void {
    if (active !== this) return;
    active = null;
    this.onDone?.(commit);
  }

  destroy(): void {
    if (active === this) active = null;
    this.root.remove();
  }
}

// ------------------------------------------------------------------------------------------

/**
 * Plain text for pasting: CRLF/CR become newlines, a vertical tab (PowerPoint's soft line break in
 * plain text) becomes a newline, form feeds become paragraph breaks, and other control characters
 * are dropped.
 */
export function cleanPastedText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[\x0B\x0C]/g, '\n').replace(/[\x00-\x08\x0E-\x1F\x7F]/g, '');
}

function setSel(r: Range): void {
  const s = window.getSelection();
  if (!s) return;
  s.removeAllRanges();
  s.addRange(r);
}

function lengthOf(n: Node): number {
  if (n.nodeType === 3) return (n.nodeValue || '').length;
  if ((n as Element).tagName === 'BR') return n.nextSibling ? 1 : 0;
  let k = 0;
  for (const c of n.childNodes) k += lengthOf(c);
  return k;
}

export function paraText(p: Paragraph): string {
  return p.runs.map((r) => (r.br ? '\n' : r.text)).join('');
}

function runOnly(r: Run | RunProps): RunProps {
  const o: any = {};
  for (const k of RUN_KEYS) if ((r as any)[k] !== undefined) o[k] = (r as any)[k];
  if ((r as Run).field) o.field = (r as Run).field;
  return o;
}

function paraOnly(p: Paragraph): Partial<Paragraph> {
  const o: any = {};
  for (const [k, v] of Object.entries(p)) if (v !== undefined && k !== 'runs' && k !== 'level' && k !== 'end') o[k] = v;
  return o;
}

function stripUndef<T extends object>(o: T): Partial<T> {
  const r: any = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && k !== 'runs' && k !== 'level' && k !== 'end') r[k] = v;
  return r;
}

function sameProps(a: RunProps, b: RunProps): boolean {
  return JSON.stringify(runOnly(a)) === JSON.stringify(runOnly(b));
}

/** Appends a run, merging with the previous one when the formatting is the same. */
function pushRun(runs: Run[], r: Run): void {
  const last = runs[runs.length - 1];
  if (last && !last.br && !r.br && !last.field && !r.field && sameProps(last, r)) last.text += r.text;
  else runs.push(r);
}

/** Splits runs so [from, to) is covered by whole runs, applies fn to those, and merges neighbors. */
export function splitRuns(runs: Run[], from: number, to: number, fn: (r: Run) => void): Run[] {
  const out: Run[] = [];
  let pos = 0;
  for (const r of runs) {
    const len = r.br ? 1 : r.text.length;
    const s = pos, e = pos + len;
    pos = e;
    if (r.br || e <= from || s >= to) { out.push({ ...r }); continue; }
    const a = Math.max(from, s) - s, b = Math.min(to, e) - s;
    if (a > 0) out.push({ ...r, text: r.text.slice(0, a) });
    const mid: Run = { ...r, text: r.text.slice(a, b) };
    fn(mid);
    out.push(mid);
    if (b < len) out.push({ ...r, text: r.text.slice(b) });
  }
  const merged: Run[] = [];
  for (const r of out) { if (r.text || r.br || r.field) pushRun(merged, r); }
  return merged;
}

function toHex(c: string): string {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c);
  if (m) return '#' + [m[1], m[2], m[3]].map((v) => (+v).toString(16).padStart(2, '0')).join('').toUpperCase();
  return c.startsWith('#') ? c.toUpperCase() : c;
}
