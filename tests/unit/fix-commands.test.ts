/** Regression tests for command-layer fixes: find/replace, macros, shortcuts, key names, prefs, storage. */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { Deck } from '../../src/model/deck';
import type { Paragraph, Slide, TableElement } from '../../src/model/types';
import { def, allCommands, getCommand } from '../../src/commands/registry';
import { canonicalKey, prettyKey, keyName } from '../../src/util/keys';
import { sanitizePrefs, defaultPrefs } from '../../src/prefs';
import { kvGet, kvSet } from '../../src/util/store';
import { findAll, findRegExp, replaceOne, replaceAll } from '../../src/commands/edit';
import { App } from '../../src/app';

beforeAll(async () => {
  await import('../../src/commands/index');
});

afterEach(() => { vi.restoreAllMocks(); document.querySelectorAll('.ql-toasts').forEach((e) => e.remove()); });

const para = (text: string): Paragraph => ({ level: 0, runs: [{ text }] });
const textOf = (p: Paragraph) => p.runs.map((r) => r.text).join('');
const OPTS = { matchCase: false, whole: false, notes: true };

function deckWith(texts: string[], table?: string[][]): { deck: Deck; slide: Slide; table?: TableElement } {
  const deck = Deck.blank();
  const slide = deck.slides[0];
  slide.elements = texts.map((t, i) => ({ id: `s${i}`, kind: 'shape', geom: 'rect', x: 0, y: i * 50, w: 100, h: 40, text: { paras: [para(t)] } }) as any);
  let tbl: TableElement | undefined;
  if (table) {
    tbl = { id: 'tbl', kind: 'table', x: 0, y: 300, w: 200, h: 80, cols: table[0].map(() => 100), rows: table.map((r) => ({ h: 40, cells: r.map((c) => ({ text: { paras: [para(c)] } })) })) } as any;
    slide.elements.push(tbl as any);
  }
  return { deck, slide, table: tbl };
}

// 3 -------------------------------------------------------------------------------------------
describe('Find and Replace', () => {
  it('replaces in the matching table cell only', () => {
    const { deck, table } = deckWith([], [['apple', 'cat'], ['dog', 'cat food']]);
    const hits = findAll(deck, 'cat', OPTS);
    expect(hits).toHaveLength(2);
    expect(hits[0].body).not.toBe(hits[1].body);
    expect(replaceAll(deck, 'cat', 'tiger', OPTS)).toBe(2);
    const cells = table!.rows.flatMap((r) => r.cells.map((c) => textOf(c.text.paras[0])));
    expect(cells).toEqual(['apple', 'tiger', 'dog', 'tiger food']);
  });

  it('Replace on a table cell changes that cell, not the first cell', () => {
    const { deck, table } = deckWith([], [['one', 'two'], ['three', 'cat']]);
    const r = replaceOne(deck, 'cat', 'X', OPTS, 0);
    expect(r.replaced).toBe(true);
    expect(table!.rows.flatMap((row) => row.cells.map((c) => textOf(c.text.paras[0])))).toEqual(['one', 'two', 'three', 'X']);
  });

  it('Replace never matches its own replacement again', () => {
    const { deck, slide } = deckWith(['a cat and a cat']);
    let at = -1;
    for (let i = 0; i < 3; i++) {
      if (at >= 0 && at >= findAll(deck, 'cat', OPTS).length) break;
      const r = replaceOne(deck, 'cat', 'cats', OPTS, at);
      if (!r.replaced) break;
      if (r.next < 0) { at = r.hits.length; continue; }
      at = r.next;
    }
    expect(textOf((slide.elements[0] as any).text.paras[0])).toBe('a cats and a cats');
  });

  it('reports no next match after the last replacement', () => {
    const { deck } = deckWith(['cat']);
    const r = replaceOne(deck, 'cat', 'cats', OPTS, 0);
    expect(r.replaced).toBe(true);
    expect(r.next).toBe(-1);
  });

  it('whole words work for C++ and non-ASCII words', () => {
    const w = { matchCase: false, whole: true };
    expect('I write C++ code'.match(findRegExp('C++', w))?.[0]).toBe('C++');
    expect('C++x'.match(findRegExp('C++', w))).toBeNull();
    expect('un café noir'.match(findRegExp('café', w))?.[0]).toBe('café');
    expect('cafés'.match(findRegExp('café', w))).toBeNull();
    expect('über straße'.match(findRegExp('straße', w))?.[0]).toBe('straße');
    expect('Æblegrød'.match(findRegExp('blegrød', w))).toBeNull();
    expect('cat concat cat_x cat'.match(findRegExp('cat', w))).toHaveLength(2);
  });
});

// 4 -------------------------------------------------------------------------------------------
function makeApp(): App {
  const app = new App(document.createElement('div'));
  (app as any).ui = { refresh() {}, status() {}, tabsChanged() {}, renderQat() {} };
  return app;
}

describe('macros', () => {
  let count = 0;
  beforeAll(() => {
    def([
      { id: 'test.fix.inner', label: 'Inner', tab: 'Test', internal: true, run: () => { count++; } },
      { id: 'test.fix.outer', label: 'Outer', tab: 'Test', internal: true, run: (app) => { app.exec('test.fix.inner'); app.exec('test.fix.inner'); } },
    ]);
  });

  it('records only the command the user ran, not the ones it runs', () => {
    const app = makeApp();
    app.recording = { name: 'm', steps: [] };
    app.exec('test.fix.outer');
    expect(app.recording.steps).toEqual([{ id: 'test.fix.outer' }]);
    expect(app.execDepth).toBe(0);
    expect(app.lastCommand?.id).toBe('test.fix.outer');
  });

  it('keeps the exec depth balanced when a command throws', () => {
    def({ id: 'test.fix.throws', label: 'Throws', tab: 'Test', internal: true, run: () => { throw new Error('boom'); } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = makeApp();
    app.exec('test.fix.throws');
    expect(app.execDepth).toBe(0);
  });

  it('stops a macro that runs itself through another macro', async () => {
    const app = makeApp();
    count = 0;
    app.prefs.macros = [
      { name: 'A', steps: [{ id: 'test.fix.inner' }, { id: 'macro:B' }, { id: 'test.fix.inner' }], created: 0 },
      { name: 'B', steps: [{ id: 'test.fix.inner' }, { id: 'dev.runMacro', arg: 'A' }], created: 0 },
    ];
    await app.exec('dev.runMacro', 'A');
    expect(count).toBe(2); // A's first step and B's first step; the loop is cut and the rest skipped
    expect(document.body.textContent).toMatch(/stopped: it runs itself/);
  });

  it('stops macros nested more than 8 deep', async () => {
    const app = makeApp();
    count = 0;
    app.prefs.macros = Array.from({ length: 12 }, (_, i) => ({ name: `M${i}`, steps: [{ id: 'test.fix.inner' }, ...(i < 11 ? [{ id: `macro:M${i + 1}` }] : [])], created: 0 }));
    await app.exec('dev.runMacro', 'M0');
    expect(count).toBe(8);
    expect(document.body.textContent).toMatch(/8 levels deep/);
  });

  it('records a macro run as one step', async () => {
    const app = makeApp();
    app.prefs.macros = [{ name: 'Two', steps: [{ id: 'test.fix.inner' }, { id: 'test.fix.inner' }], created: 0 }];
    app.recording = { name: 'm', steps: [] };
    await app.exec('macro:Two');
    expect(app.recording.steps).toEqual([{ id: 'macro:Two' }]);
  });
});

// 9 -------------------------------------------------------------------------------------------
describe('default shortcuts', () => {
  it('no two commands share a key', () => {
    const seen = new Map<string, string>();
    const dups: string[] = [];
    for (const c of allCommands()) for (const k of c.keys || []) {
      const ck = canonicalKey(k);
      const prev = seen.get(ck);
      if (prev && prev !== c.id) dups.push(`${ck}: ${prev} and ${c.id}`);
      else seen.set(ck, c.id);
    }
    expect(dups).toEqual([]);
  });

  it('keeps Ctrl+= for Subscript and Alt+Shift+arrows for list levels', () => {
    expect(getCommand('fmt.subscript')?.keys).toContain('Mod-=');
    expect(getCommand('view.zoomIn')?.keys).toEqual(['Mod-Alt-=']);
    expect(getCommand('fmt.indent')?.keys).toContain('Alt-Shift-ArrowRight');
    expect(getCommand('outline.demote')?.keys || []).toEqual([]);
  });

  it('refuses duplicate command ids', () => {
    expect(() => def({ id: 'file.save', label: 'Again', tab: 'Test', run: () => {} })).toThrow(/Duplicate command id file\.save/);
  });
});

// 10 ------------------------------------------------------------------------------------------
describe('key names', () => {
  it('handles "-" as the base key', () => {
    expect(canonicalKey('Mod--')).toBe('Mod--');
    expect(canonicalKey('Shift-Ctrl--')).toBe('Mod-Shift--');
    expect(canonicalKey('-')).toBe('-');
    expect(prettyKey('Mod--')).toBe('Ctrl+-');
    expect(prettyKey('Mod-Shift-=')).toBe('Ctrl+Shift+=');
    expect(prettyKey('Alt-q')).toBe('Alt+Q');
    const e = new KeyboardEvent('keydown', { key: '-', code: 'Minus', ctrlKey: true });
    expect(canonicalKey(keyName(e)!)).toBe(canonicalKey('Mod--'));
    expect(canonicalKey('Mod--')).not.toBe(canonicalKey('Mod-='));
  });
});

// 11 ------------------------------------------------------------------------------------------
describe('sanitizePrefs', () => {
  it('clamps numeric preferences and replaces non-numbers with defaults', () => {
    const d = defaultPrefs();
    expect(sanitizePrefs({ gridSize: 1000, uiScale: 0.01, autosaveSeconds: 0 })).toMatchObject({ gridSize: 144, uiScale: 0.5, autosaveSeconds: 3 });
    expect(sanitizePrefs({ gridSize: 1, uiScale: 9 })).toMatchObject({ gridSize: 2, uiScale: 2 });
    expect(sanitizePrefs({ gridSize: NaN, uiScale: Infinity, autosaveSeconds: 'abc' })).toMatchObject({ gridSize: d.gridSize, uiScale: d.uiScale, autosaveSeconds: d.autosaveSeconds });
    expect(sanitizePrefs({ gridSize: '24' }).gridSize).toBe(24);
    expect(sanitizePrefs({ defaultTheme: -3.7 }).defaultTheme).toBe(0);
    expect(sanitizePrefs({ readAloudRate: 50 }).readAloudRate).toBe(10);
    expect(sanitizePrefs({ gridSize: 20 }).gridSize).toBe(20);
  });
});

// 14 ------------------------------------------------------------------------------------------
describe('storage', () => {
  it('kvSet rejects when the store is full', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    await expect(kvSet('x', { a: 1 })).rejects.toThrow();
  });

  it('kvGet returns undefined for a damaged entry', async () => {
    localStorage.setItem('qlkv:bad', '{not json');
    await expect(kvGet('bad')).resolves.toBeUndefined();
    await kvSet('good', { a: 1 });
    await expect(kvGet('good')).resolves.toEqual({ a: 1 });
  });

  it('AutoSave reports a draft it could not store', async () => {
    const app = makeApp();
    const status: string[] = [];
    (app as any).ui.status = (s: string) => status.push(s);
    app.docs = [{ id: 't1', dirty: true, displayName: 'Deck', title: 'Deck', fileName: '', format: 'pptx', uri: null, key: '', deck: Deck.blank() } as any];
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await app.saveDrafts()).toBe(false);
    expect(status).toEqual(['Draft not saved']);
    expect(document.body.textContent).toMatch(/could not store a draft of Deck/);
    vi.restoreAllMocks();
    expect(await app.saveDrafts()).toBe(true);
    expect(status[status.length - 1]).toBe('Draft saved');
  });
});
