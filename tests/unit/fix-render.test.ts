import { describe, it, expect } from 'vitest';
import { Deck } from '../../src/model/deck';
import type { Slide, TableElement } from '../../src/model/types';
import { slideSvg } from '../../src/render/slide';
import { renderAnimatedSlide, stateAt } from '../../src/render/animate';
import { renderChart } from '../../src/render/chart';
import { layoutText } from '../../src/render/text';

const json = (d: Deck) => JSON.parse(JSON.stringify(d.toJSON()));
const dom = (markup: string) => { const host = document.createElement('div'); host.innerHTML = markup; return host; };
const xmlOk = (markup: string) => !new DOMParser().parseFromString(markup, 'image/svg+xml').getElementsByTagName('parsererror').length;

describe('markup injection from deck data', () => {
  it('drops non-hex theme colours', () => {
    const j = json(Deck.blank());
    j.data.themes[0].colors.lt1 = '"/><img src=x onerror="window.__pwn=1">';
    const d = Deck.fromJSON(j);
    expect(d.data.themes[0].colors.lt1).toMatch(/^#[0-9A-F]{3,8}$/);
    const host = dom(slideSvg(d, d.slides[0], { mode: 'thumb' }));
    expect(host.querySelector('img')).toBeNull();
  });

  it('ignores a raw colour value set after loading', () => {
    const d = Deck.blank();
    (d.data.themes[0].colors as any).accent1 = 'red"><img src=x>';
    d.slides[0].elements.push({ id: 's', kind: 'shape', geom: 'rect', x: 0, y: 0, w: 10, h: 10 } as any);
    const host = dom(slideSvg(d, d.slides[0], {}));
    expect(host.querySelector('img')).toBeNull();
  });

  it('cannot break out of a custom path, line cap/join or shadow alpha', () => {
    const j = json(Deck.blank());
    j.data.slides[0].elements.push({
      id: 'x', kind: 'shape', geom: 'custom', x: 0, y: 0, w: 10, h: 10,
      path: [{ d: 'M0 0"/><img src=x onerror="1">', w: 10, h: 10 }],
      line: { fill: { type: 'solid', color: '#000000' }, width: 1, cap: 'round"/><img src=x>', join: 'x"><img src=y>' },
      effects: { shadow: { color: '#000000', dir: 0, dist: 2, blur: 2, alpha: '1"/><img src=z>' } },
    });
    const d = Deck.fromJSON(j);
    const svg = slideSvg(d, d.slides[0], {});
    expect(dom(svg).querySelector('img')).toBeNull();
    expect(xmlOk(svg)).toBe(true);
  });

  it('drops media with a bad mime type or non-base64 data', () => {
    const j = json(Deck.blank());
    j.media = { m1: { mime: 'image/png"/><img src=x onerror="1"><x y="', b64: 'AA' }, m2: { mime: 'image/png', b64: 'AA"><img src=x>' }, m3: { mime: 'image/png', b64: 'iVBORw0KGgo=' } };
    j.data.slides[0].elements.push({ id: 'p', kind: 'picture', media: 'm1', x: 0, y: 0, w: 10, h: 10 }, { id: 'q', kind: 'picture', media: 'm2', x: 0, y: 0, w: 10, h: 10 });
    const d = Deck.fromJSON(j);
    expect(Object.keys(d.media)).toEqual(['m3']);
    expect(dom(slideSvg(d, d.slides[0], {})).querySelector('img')).toBeNull();
    expect(d.mediaUrl('m3')).toBe('data:image/png;base64,iVBORw0KGgo=');
  });
});

describe('XML-illegal control characters', () => {
  it('keeps the animated slide drawable and turns U+000B into a line break', () => {
    const d = Deck.blank();
    const s = d.slides[0];
    (s.elements[0] as any).text.paras = [{ level: 0, runs: [{ text: 'Line one\u000Bline two\u0001' }] }];
    const markup = slideSvg(d, s, { mode: 'show' });
    expect(xmlOk(markup)).toBe(true);
    const svg = renderAnimatedSlide(d, s, 0);
    expect(svg.nodeName).toBe('svg');
    const text = svg.textContent || '';
    expect(text).toContain('Line one');
    expect(text).toContain('line two');
    // Two separate lines.
    const texts = [...svg.querySelectorAll('.qs-text text')].map((t) => t.textContent);
    expect(texts).toContain('Line one');
    expect(texts).toContain('line two');
  });
});

describe('by-paragraph animation inside a group', () => {
  it('draws a paragraph layer for a shape nested in a group', () => {
    const d = Deck.blank();
    const s: Slide = d.slides[0];
    s.elements = [{
      id: 'g', kind: 'group', x: 0, y: 0, w: 200, h: 200,
      children: [
        { id: 'inner', kind: 'shape', geom: 'rect', x: 0, y: 0, w: 200, h: 100, text: { paras: [{ level: 0, runs: [{ text: 'Alpha' }] }, { level: 0, runs: [{ text: 'Beta' }] }] } },
        { id: 'sib', kind: 'shape', geom: 'rect', x: 0, y: 100, w: 200, h: 100, text: { paras: [{ level: 0, runs: [{ text: 'Sibling' }] }] } },
      ],
    } as any];
    s.anims = [{ id: 'a', target: 'inner', cls: 'entr', effect: 'fade', trigger: 'click', byPara: true }];
    const svg = renderAnimatedSlide(d, s, 3);
    const layers = [...svg.querySelectorAll('g[data-para]')];
    expect(layers.map((l) => l.textContent)).toEqual(['Alpha', 'Beta']);
    // The sibling is not duplicated into the paragraph layers.
    expect(layers.some((l) => /Sibling/.test(l.textContent || ''))).toBe(false);
  });

  it('hides shape-triggered entrances in a live show', () => {
    const d = Deck.blank();
    const s = d.slides[0];
    s.elements.push({ id: 'btn', kind: 'shape', geom: 'rect', x: 0, y: 0, w: 10, h: 10 } as any, { id: 'pop', kind: 'shape', geom: 'rect', x: 0, y: 0, w: 10, h: 10 } as any);
    s.anims = [{ id: 'a', target: 'pop', cls: 'entr', effect: 'fade', trigger: 'click', onShape: 'btn' }];
    expect(stateAt(s, 0).hide.has('pop')).toBe(true); // as the slide first appears
    expect(stateAt(s, 1).hide.has('pop')).toBe(false); // fully built (print shows every object)
    expect(stateAt(s, 1, undefined, { live: true }).hide.has('pop')).toBe(true);
  });
});

describe('table height', () => {
  it('scales rows to the frame height', () => {
    const d = Deck.blank();
    const t: TableElement = { id: 't', kind: 'table', x: 0, y: 0, w: 200, h: 200, cols: [100, 100], rows: [{ h: 20, cells: [{}, {}] }, { h: 20, cells: [{}, {}] }] } as any;
    d.slides[0].elements = [t];
    const host = dom(slideSvg(d, d.slides[0], {}));
    const rects = [...host.querySelectorAll('g[transform^="translate(0 0)"] > rect')];
    const heights = rects.map((r) => +r.getAttribute('height')!);
    expect(heights).toEqual([100, 100, 100, 100]);
    expect(rects.map((r) => +r.getAttribute('y')!)).toEqual([0, 0, 100, 100]);
  });
});

describe('charts', () => {
  const color = () => '#000000';
  const nums = (svg: string, re: RegExp) => [...svg.matchAll(re)].map((m) => +m[1]);

  it('stacks 100% line charts', () => {
    const svg = renderChart({ type: 'line', stacked: 'percent', categories: ['a', 'b'], series: [{ name: 's1', values: [1, 3] }, { name: 's2', values: [1, 1] }], legend: 'none' } as any, 400, 300, color, 'c');
    // The top series reaches 100% at every category, so its points sit on the top gridline.
    const ys = nums(svg, /<circle cx="[\d.]+" cy="([\d.-]+)"/g);
    expect(ys).toHaveLength(4);
    expect(ys[2]).toBeCloseTo(ys[3]);
    expect(Math.min(...ys)).toBeCloseTo(8, 0);
  });

  it('puts stacked negatives on a matching axis', () => {
    const svg = renderChart({ type: 'column', stacked: 'percent', categories: ['a'], series: [{ name: 's1', values: [3] }, { name: 's2', values: [-1] }], legend: 'none' } as any, 400, 300, color, 'c');
    expect(svg).toContain('>-100%<');
    expect(svg).toContain('>100%<');
    expect(svg).not.toMatch(/>-?(?:[2-9]\d\d|1\d[1-9]|1[1-9]\d|\d{4,})%</);
  });

  it('breaks lines at blank values', () => {
    const svg = renderChart({ type: 'line', categories: ['a', 'b', 'c', 'd'], series: [{ name: 's', values: [1, 2, null, 4] }], legend: 'none' } as any, 400, 300, color, 'c');
    expect(nums(svg, /<circle cx="([\d.]+)"/g)).toHaveLength(3);
    const lines = [...svg.matchAll(/<path d="(M[^"]+)" fill="none" stroke="#000000" stroke-width="2.25"/g)].map((m) => m[1]);
    expect(lines).toHaveLength(2);
  });
});

describe('list numbering and spaces', () => {
  const opts = { width: 500, height: 500, styleFor: () => ({ bullet: { kind: 'num' as const }, run: { size: 18 } }), font: () => 'Carlito' };
  it('does not count empty paragraphs', () => {
    const lay = layoutText([
      { level: 0, runs: [{ text: 'One' }] },
      { level: 0, runs: [] },
      { level: 0, runs: [{ text: 'Two' }] },
    ], opts);
    expect(lay.lines.map((l) => l.bullet?.text).filter(Boolean)).toEqual(['1.', '2.']);
  });
  it('keeps leading spaces of a paragraph', () => {
    const lay = layoutText([{ level: 0, runs: [{ text: '   indented' }] }], { ...opts, styleFor: () => ({ run: { size: 18 } }) });
    expect(lay.lines[0].segs.map((s) => s.text).join('')).toBe('   indented');
  });
});
