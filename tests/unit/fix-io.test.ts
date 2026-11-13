import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import JSZip from 'jszip';
import { Deck } from '../../src/model/deck';
import type { ChartElement, ShapeElement, Slide, Transition } from '../../src/model/types';
import { importDeck, exportDeck, decodeText } from '../../src/io';
import { exportMarkdown, importMarkdown, inlineRuns } from '../../src/io/markdown';
import { exportPptx } from '../../src/io/pptx/export';
import { importPptx, readZip } from '../../src/io/pptx/import';
import { exportOdp, importOdp, odfAngle } from '../../src/io/odp';
import { openCfb } from '../../src/io/cfb';
import { inflateCapped, readZipCapped, ZipBudget, ZipLimitError } from '../../src/io/zip';
import { shapesOf, slideListTexts, pptRecord } from '../../src/io/ppt';
import { imageSizePt } from '../../src/io/xml';
import { deckToPdf, winAnsiEncodable } from '../../src/export/pdf';
import { clampCanvas } from '../../src/export/images';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x20, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
const text = (s: Slide) => s.elements.map((e: any) => e.text?.paras.map((p: any) => p.runs.map((r: any) => r.text).join('')).join('\n') || '').join('\n');
const td = new TextDecoder();

// ------------------------------------------------------------------------------------------
describe('flat ODP automatic style names (2)', () => {
  it('are unique across master and slide styles', async () => {
    const d = Deck.blank();
    d.data.masters[0].elements.push({ id: 'logo', kind: 'shape', geom: 'ellipse', x: 10, y: 10, w: 50, h: 50, fill: { type: 'solid', color: '#FF0000' }, line: { fill: { type: 'none' } }, text: { paras: [{ level: 0, bullet: { kind: 'char', char: '•' }, runs: [{ text: 'M', b: true }] }] } } as any);
    d.slides[0].elements.push({ id: 'b', kind: 'shape', geom: 'ellipse', x: 100, y: 100, w: 50, h: 50, fill: { type: 'solid', color: '#00FF00' }, line: { fill: { type: 'none' } }, text: { paras: [{ level: 0, bullet: { kind: 'char', char: '•' }, align: 'ctr', runs: [{ text: 'S', i: true }] }] } } as any);
    const xml = td.decode((await exportDeck(d, 'fodp')).data);
    const names = [...xml.matchAll(/<(?:style:style|text:list-style) style:name="([^"]+)"(?: style:family="([^"]+)")?/g)].map((m) => `${m[2] || 'list'}:${m[1]}`);
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
    const back = await importDeck(new TextEncoder().encode(xml), 'x.fodp');
    expect((back.deck.data.masters[0].elements.find((e: any) => e.geom === 'ellipse') as any).fill).toEqual({ type: 'solid', color: '#FF0000' });
    expect((back.deck.slides[0].elements.find((e: any) => e.geom === 'ellipse') as any).fill).toEqual({ type: 'solid', color: '#00FF00' });
  });
  it('packaged ODP still keeps separate style sets', async () => {
    const d = Deck.blank();
    d.data.masters[0].elements.push({ id: 'logo', kind: 'shape', geom: 'ellipse', x: 10, y: 10, w: 50, h: 50 } as any);
    const zip = await JSZip.loadAsync(await exportOdp(d));
    expect(await zip.file('styles.xml')!.async('string')).toContain('style:name="gr1"');
  });
});

// ------------------------------------------------------------------------------------------
describe('theme format scheme with picture fills (3)', () => {
  it('falls back to the default scheme when the kept XML refers to package parts', async () => {
    const zip = await JSZip.loadAsync(readFileSync('tests/fixtures/deck.pptx'));
    const tname = Object.keys(zip.files).find((k) => /ppt\/theme\/theme1\.xml$/.test(k))!;
    let t = await zip.file(tname)!.async('string');
    t = t.replace(/<a:bgFillStyleLst>/, '<a:bgFillStyleLst><a:blipFill><a:blip r:embed="rId9"/><a:stretch><a:fillRect/></a:stretch></a:blipFill>');
    if (!/xmlns:r=/.test(t)) t = t.replace('<a:theme ', '<a:theme xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ');
    zip.file(tname, t);
    const r = await importPptx(await zip.generateAsync({ type: 'uint8array' }));
    expect(r.deck.data.themes[0].keep?.fmtScheme).toBeUndefined();
    const out = await JSZip.loadAsync(await exportPptx(r.deck));
    const theme = await out.file('ppt/theme/theme1.xml')!.async('string');
    expect(theme).toContain('<a:fmtScheme');
    expect(theme).not.toMatch(/r:embed/);
  });
  it('export ignores a kept scheme with r:embed', async () => {
    const d = Deck.blank();
    d.data.themes[0].keep = { part: 'x', fmtScheme: '<a:fmtScheme name="X"><a:fillStyleLst><a:blipFill><a:blip r:embed="rId3"/></a:blipFill></a:fillStyleLst></a:fmtScheme>' } as any;
    const out = await JSZip.loadAsync(await exportPptx(d));
    expect(await out.file('ppt/theme/theme1.xml')!.async('string')).not.toContain('r:embed');
  });
});

// ------------------------------------------------------------------------------------------
/** A compound file: header, FAT, directory, a 4096-byte stream, and `extra` DIFAT sectors that all repeat sector 0 and loop. */
function cfbWithBadDifat(extra: number): { file: Uint8Array; payload: Uint8Array } {
  const S = 512;
  const dataSecs = 8;
  const total = 1 + 1 + 1 + dataSecs + extra; // FAT, dir, (unused), data, DIFAT
  const b = new Uint8Array(S * (total + 1));
  const dv = new DataView(b.buffer);
  b.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  dv.setUint16(0x1a, 3, true); dv.setUint16(0x1c, 0xfffe, true); dv.setUint16(0x1e, 9, true); dv.setUint16(0x20, 6, true);
  dv.setUint32(0x2c, 1, true); dv.setUint32(0x30, 1, true); dv.setUint32(0x38, 4096, true); dv.setUint32(0x3c, 0xfffffffe, true);
  const difat0 = 3 + dataSecs;
  dv.setUint32(0x44, extra ? difat0 : 0xfffffffe, true); dv.setUint32(0x48, extra, true);
  for (let k = 0; k < 109; k++) dv.setUint32(0x4c + k * 4, 0, true); // sector 0 repeated 109 times
  const sec = (n: number) => S * (n + 1);
  // FAT (sector 0)
  for (let k = 0; k < 128; k++) dv.setUint32(sec(0) + k * 4, 0xffffffff, true);
  dv.setUint32(sec(0), 0xfffffffd, true);
  dv.setUint32(sec(0) + 4, 0xfffffffe, true);
  for (let k = 0; k < dataSecs; k++) dv.setUint32(sec(0) + (3 + k) * 4, k === dataSecs - 1 ? 0xfffffffe : 4 + k, true);
  // Directory (sector 1): root + one stream
  const name = (o: number, s: string) => { for (let i = 0; i < s.length; i++) dv.setUint16(o + i * 2, s.charCodeAt(i), true); dv.setUint16(o + 0x40, (s.length + 1) * 2, true); };
  const d0 = sec(1);
  name(d0, 'Root Entry'); b[d0 + 0x42] = 5; dv.setUint32(d0 + 0x44, 0xffffffff, true); dv.setUint32(d0 + 0x48, 0xffffffff, true); dv.setUint32(d0 + 0x4c, 1, true); dv.setUint32(d0 + 0x74, 0xfffffffe, true);
  const d1 = d0 + 128;
  name(d1, 'Data'); b[d1 + 0x42] = 2; dv.setUint32(d1 + 0x44, 0xffffffff, true); dv.setUint32(d1 + 0x48, 0xffffffff, true); dv.setUint32(d1 + 0x4c, 0xffffffff, true); dv.setUint32(d1 + 0x74, 3, true); dv.setUint32(d1 + 0x78, 4096, true);
  for (let i = 2; i < 4; i++) { const o = d0 + i * 128; dv.setUint32(o + 0x44, 0xffffffff, true); dv.setUint32(o + 0x48, 0xffffffff, true); dv.setUint32(o + 0x4c, 0xffffffff, true); }
  const payload = new Uint8Array(4096).map((_, i) => (i * 7) & 255);
  b.set(payload, sec(3));
  // DIFAT sectors: every entry names sector 0 again; each links to the next, the last back to the first.
  for (let k = 0; k < extra; k++) {
    const o = sec(difat0 + k);
    for (let j = 0; j < 127; j++) dv.setUint32(o + j * 4, 0, true);
    dv.setUint32(o + 127 * 4, k === extra - 1 ? difat0 : difat0 + k + 1, true);
  }
  return { file: b, payload };
}

describe('compound file DIFAT (6)', () => {
  it('reads a valid stream despite repeated FAT entries', () => {
    const { file, payload } = cfbWithBadDifat(0);
    const cfb = openCfb(file)!;
    expect(cfb.read('Data')).toEqual(payload);
  });
  it('a looping DIFAT full of repeats stays small and fast', () => {
    const { file, payload } = cfbWithBadDifat(4000); // ~2 MB, ~508,000 bogus FAT entries before the fix
    const t0 = Date.now();
    const cfb = openCfb(file)!;
    expect(cfb.read('Data')).toEqual(payload);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

// ------------------------------------------------------------------------------------------
describe('bounded zip inflation (7)', () => {
  it('refuses an entry over the per-entry cap by its declared size', async () => {
    const z = new JSZip();
    z.file('big.bin', new Uint8Array(50000));
    const zip = await JSZip.loadAsync(await z.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
    await expect(inflateCapped(zip.file('big.bin')!, new ZipBudget(10000, 1e9))).rejects.toBeInstanceOf(ZipLimitError);
    expect((await inflateCapped(zip.file('big.bin')!, new ZipBudget(60000, 1e9))).length).toBe(50000);
  });
  it('stops a lying entry while inflating', async () => {
    const z = new JSZip();
    z.file('bomb.xml', 'a'.repeat(300000));
    const bytes = await z.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    // Patch the declared uncompressed size (local header +22, central directory +24) to 10 bytes.
    const dv = new DataView(bytes.buffer, bytes.byteOffset);
    for (let i = 0; i + 4 <= bytes.length; i++) {
      const sig = dv.getUint32(i, true);
      if (sig === 0x04034b50) dv.setUint32(i + 22, 10, true);
      if (sig === 0x02014b50) dv.setUint32(i + 24, 10, true);
    }
    const zip = await JSZip.loadAsync(bytes);
    await expect(inflateCapped(zip.file('bomb.xml')!, new ZipBudget(100000, 1e9))).rejects.toThrow(/more than/);
  });
  it('the package total is capped', async () => {
    const z = new JSZip();
    for (let i = 0; i < 5; i++) z.file(`p${i}.xml`, 'x'.repeat(10000));
    const data = await z.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    await expect(readZipCapped(data, { budget: new ZipBudget(20000, 30000) })).rejects.toBeInstanceOf(ZipLimitError);
    const ok = await readZipCapped(data, { budget: new ZipBudget(20000, 60000) });
    expect(ok.files.size).toBe(5);
  });
  it('pptx binaries no relationship names are not inflated', async () => {
    const zip = await JSZip.loadAsync(await exportPptx(Deck.blank()));
    zip.file('ppt/media/orphan.bin', new Uint8Array(1000));
    const pkg = await readZip(await zip.generateAsync({ type: 'uint8array' }));
    expect(pkg.has('ppt/media/orphan.bin')).toBe(false);
    expect(pkg.has('ppt/presentation.xml')).toBe(true);
  });
  it('a chart point index is bounded by ptCount', async () => {
    const d = Deck.blank();
    d.slides[0].elements.push({ id: 'c1', kind: 'chart', x: 50, y: 50, w: 300, h: 200, chart: { type: 'column', categories: ['A', 'B'], series: [{ name: 'S', values: [1, 2] }] } } as ChartElement);
    const zip = await JSZip.loadAsync(await exportPptx(d));
    const cname = Object.keys(zip.files).find((k) => /charts\/chart\d+\.xml$/.test(k))!;
    zip.file(cname, (await zip.file(cname)!.async('string')).replace(/<c:pt idx="1">/g, '<c:pt idx="400000000">'));
    const r = await importPptx(await zip.generateAsync({ type: 'uint8array' }));
    const ch = r.deck.slides[0].elements.find((e) => e.kind === 'chart') as ChartElement;
    expect(ch.chart.categories.length).toBeLessThanOrEqual(2);
    expect(ch.chart.series[0].values.length).toBeLessThanOrEqual(2);
  });
});

// ------------------------------------------------------------------------------------------
describe('ODF angles (8)', () => {
  it('unitless is tenths of a degree; deg, grad, rad are honoured', () => {
    expect(odfAngle('300')).toBe(30);
    expect(odfAngle('45')).toBe(4.5);
    expect(odfAngle('30deg')).toBe(30);
    expect(odfAngle('100grad')).toBeCloseTo(90);
    expect(odfAngle(`${Math.PI / 2}rad`)).toBeCloseTo(90);
    expect(odfAngle('junk')).toBe(0);
  });
  it('a gradient angle of 45 (4.5°) is not read as 45°', () => {
    const fodp = `<?xml version="1.0" encoding="UTF-8"?><office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" office:version="1.3"><office:styles><draw:gradient draw:name="g" draw:style="linear" draw:start-color="#ff0000" draw:end-color="#0000ff" draw:angle="450"/></office:styles><office:automatic-styles><style:style style:name="gr1" style:family="graphic"><style:graphic-properties draw:fill="gradient" draw:fill-gradient-name="g"/></style:style></office:automatic-styles><office:body><office:presentation><draw:page draw:name="p1"><draw:custom-shape draw:style-name="gr1" svg:x="1cm" svg:y="1cm" svg:width="2cm" svg:height="2cm"><draw:enhanced-geometry draw:type="rectangle"/></draw:custom-shape></draw:page></office:presentation></office:body></office:document>`;
    const r = (importOdp as any)(new TextEncoder().encode(fodp));
    return Promise.resolve(r).then((res: any) => {
      const f = (res.deck.slides[0].elements[0] as ShapeElement).fill as any;
      expect(f.type).toBe('gradient');
      expect(f.angle).toBeCloseTo(45); // 90 - 45° = 45
    });
  });
});

// ------------------------------------------------------------------------------------------
describe('Markdown emphasis and escapes (9, 10)', () => {
  it('intraword underscores are literal', () => {
    expect(inlineRuns('use my_var_name and other_thing here')).toEqual([{ text: 'use my_var_name and other_thing here' }]);
    expect(inlineRuns('an _emphasised_ word')).toEqual([{ text: 'an ' }, { text: 'emphasised', i: true }, { text: ' word' }]);
    expect(inlineRuns('__strong__ and snake__case__x')).toEqual([{ text: 'strong', b: true }, { text: ' and snake__case__x' }]);
    expect(inlineRuns('a *b* c')[1]).toEqual({ text: 'b', i: true });
    expect(inlineRuns('not \\*emph\\*')).toEqual([{ text: 'not *emph*' }]);
  });
  it('line-leading structure in text survives a round trip', () => {
    const d = Deck.blank();
    const s = d.makeSlide(d.layoutByType('obj')!.id);
    (s.elements[0] as ShapeElement).text = { paras: [{ level: 0, runs: [{ text: 'Learning C#' }] }] };
    const lines = ['Note: bring laptops', '# of users grew', '1. not a list', '- not a bullet', '+ plus', '> not a quote', '???', '---', 'notes: lower', 'snake_case_name', 'a <!-- comment --> b'];
    (s.elements[1] as ShapeElement).text = { paras: lines.map((t) => ({ level: 0, bullet: { kind: 'none' as const }, runs: [{ text: t }] })) };
    s.notes = [{ level: 0, runs: [{ text: 'line one' }] }, { level: 0, runs: [{ text: '---' }] }, { level: 0, runs: [{ text: '```' }] }, { level: 0, runs: [{ text: 'last' }] }];
    d.data.slides = [s];
    const md = exportMarkdown(d);
    const back = importMarkdown(md);
    expect(back.slides.length).toBe(1);
    const t = back.slides[0].elements.map((e: any) => e.text?.paras.map((p: any) => p.runs.map((r: any) => r.text).join('')) || []);
    expect(t[0]).toEqual(['Learning C#']);
    expect(t[1]).toEqual(lines);
    expect(back.slides[0].notes.map((p) => p.runs.map((r) => r.text).join(''))).toEqual(['line one', '---', '```', 'last']);
  });
  it('backslash escapes are honoured on import', () => {
    const d = importMarkdown('## T\n\n\\# not heading\n\n1\\. not numbered\n\n\\- not bullet\n');
    expect(text(d.slides[0])).toContain('# not heading\n1. not numbered\n- not bullet');
  });
});

// ------------------------------------------------------------------------------------------
async function pptxTrip(t: Transition): Promise<Transition | undefined> {
  const d = Deck.blank();
  d.slides[0].transition = t;
  return (await importPptx(await exportPptx(d))).deck.slides[0].transition;
}
async function odpTrip(t: Transition): Promise<Transition | undefined> {
  const d = Deck.blank();
  d.slides[0].transition = t;
  return (await importOdp(await exportOdp(d))).deck.slides[0].transition;
}

describe('transition directions round-trip (11)', () => {
  it('pptx split keeps orientation and in/out', async () => {
    const r = await pptxTrip({ type: 'split', dir: 'vert', inOut: 'in', dur: 500 } as any);
    expect(r?.type).toBe('split');
    expect(r?.dir).toBe('vert');
    expect((r as any).inOut).toBe('in');
    const r2 = await pptxTrip({ type: 'split', dir: 'horz', dur: 500 });
    expect(r2?.dir).toBe('horz');
    expect((r2 as any).inOut).toBe('out');
  });
  it('pptx reveal is written as p14:reveal with a fallback and read back as reveal', async () => {
    const d = Deck.blank();
    d.slides[0].transition = { type: 'reveal', dir: 'r', dur: 500 };
    const zip = await JSZip.loadAsync(await exportPptx(d));
    const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
    expect(xml).toContain('<p14:reveal dir="r"/>');
    expect(xml).toContain('<mc:Fallback>');
    const r = (await importPptx(await zip.generateAsync({ type: 'uint8array' }))).deck.slides[0].transition;
    expect(r?.type).toBe('reveal');
    expect(r?.dir).toBe('r');
  });
  it('pptx wipe and push directions survive', async () => {
    for (const dir of ['l', 'r', 'u', 'd'] as const) {
      expect((await pptxTrip({ type: 'wipe', dir, dur: 500 }))?.dir).toBe(dir);
      expect((await pptxTrip({ type: 'push', dir, dur: 500 }))?.dir).toBe(dir);
    }
  });
  it('ODP wipe directions survive (reverse for the opposite sides)', async () => {
    for (const dir of ['l', 'r', 'u', 'd'] as const) {
      const r = await odpTrip({ type: 'wipe', dir, dur: 500 });
      expect(r?.type).toBe('wipe');
      expect(r?.dir).toBe(dir);
    }
    for (const dir of ['l', 'r', 'u', 'd'] as const) expect((await odpTrip({ type: 'push', dir, dur: 500 }))?.dir).toBe(dir);
  });
  it('ODP split keeps orientation and in/out; uncover stays uncover', async () => {
    const r = await odpTrip({ type: 'split', dir: 'horz', inOut: 'in', dur: 500 } as any);
    expect(r?.type).toBe('split');
    expect(r?.dir).toBe('horz');
    expect((r as any).inOut).toBe('in');
    expect((await odpTrip({ type: 'uncover', dir: 'l', dur: 500 }))?.type).toBe('uncover');
  });
});

// ------------------------------------------------------------------------------------------
describe('text files with a byte-order mark (12)', () => {
  const md = '# Grüße\n\n- Ünïcödé ✓\n';
  const le = (s: string, bom: boolean) => { const b = new Uint8Array((s.length + (bom ? 1 : 0)) * 2); let o = 0; if (bom) { b[0] = 0xff; b[1] = 0xfe; o = 2; } for (let i = 0; i < s.length; i++) { b[o + i * 2] = s.charCodeAt(i) & 255; b[o + i * 2 + 1] = s.charCodeAt(i) >> 8; } return b; };
  const be = (s: string) => { const b = new Uint8Array(s.length * 2 + 2); b[0] = 0xfe; b[1] = 0xff; for (let i = 0; i < s.length; i++) { b[2 + i * 2] = s.charCodeAt(i) >> 8; b[3 + i * 2] = s.charCodeAt(i) & 255; } return b; };
  it('decodes UTF-8 BOM, UTF-16LE and UTF-16BE', () => {
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(md)]))).toBe(md);
    expect(decodeText(le(md, true))).toBe(md);
    expect(decodeText(be(md))).toBe(md);
    expect(decodeText(le(md, false))).toBe(md);
    expect(decodeText(new Uint8Array([0x63, 0x61, 0x66, 0xe9]))).toBe('café'); // not UTF-8: Windows-1252
  });
  it('imports UTF-16 Markdown and text outlines', async () => {
    for (const bytes of [le(md, true), be(md), new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(md)])]) {
      const r = await importDeck(bytes, 'notes.md');
      expect(text(r.deck.slides[0])).toContain('Grüße');
      expect(text(r.deck.slides[0])).toContain('Ünïcödé ✓');
    }
    const r = await importDeck(le('Agenda\n\tFirst ✓\n', true), 'o.txt');
    expect(text(r.deck.slides[0])).toContain('First ✓');
  });
});

// ------------------------------------------------------------------------------------------
describe('PDF export (13, 14)', () => {
  it('no slides is a clear error', async () => {
    const d = Deck.blank();
    d.data.slides = [];
    for (const kind of ['slides', 'handouts', 'notes', 'outline'] as const) await expect(deckToPdf(d, { kind, render: async () => JPEG })).rejects.toThrow('No slides to export');
    const h = Deck.blank();
    h.slides[0].hidden = true;
    await expect(deckToPdf(h, { render: async () => JPEG })).rejects.toThrow('No slides to export');
  });
  it('text outside WinAnsi is drawn as a picture, or reported', async () => {
    expect(winAnsiEncodable('Café – “quotes” €')).toBe(true);
    expect(winAnsiEncodable('Ελληνικά')).toBe(false);
    const d = Deck.blank();
    d.slides[0].notes = [{ level: 0, runs: [{ text: 'Ελληνικά 日本語' }] }];
    const warnings: string[] = [];
    let drawn = 0;
    const pdf = td.decode(await deckToPdf(d, { kind: 'notes', render: async () => JPEG, onWarning: (m) => warnings.push(m), rasterText: async () => { drawn++; return { jpeg: JPEG, w: 80, h: 14 }; } }));
    expect(drawn).toBe(1);
    expect(pdf).toContain('/T1 Do');
    expect(warnings.length).toBe(1);
    (d.slides[0].elements[0] as ShapeElement).text = { paras: [{ level: 0, runs: [{ text: 'Заголовок' }] }] };
    const w2: string[] = [];
    await deckToPdf(d, { kind: 'outline', onWarning: (m) => w2.push(m), rasterText: async () => null });
    expect(w2[0]).toMatch(/replaced by "\?"/);
  });
});

// ------------------------------------------------------------------------------------------
describe('other fixes', () => {
  it('ppt: OutlineTextRefAtom resolves to the slide list text (1)', () => {
    const recB = (type: number, body: Uint8Array, ver = 0, inst = 0) => { const b = new Uint8Array(8 + body.length); const dv = new DataView(b.buffer); dv.setUint16(0, (inst << 4) | ver, true); dv.setUint16(2, type, true); dv.setUint32(4, body.length, true); b.set(body, 8); return b; };
    const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((a, x) => a + x.length, 0)); let k = 0; for (const x of p) { o.set(x, k); k += x.length; } return o; };
    const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
    const chars = (s: string) => { const b = new Uint8Array(s.length * 2); for (let i = 0; i < s.length; i++) new DataView(b.buffer).setUint16(i * 2, s.charCodeAt(i), true); return b; };
    const list = recB(0x0ff0, cat(
      recB(0x03f3, new Uint8Array(20)),
      recB(0x0f9f, u32(0)), recB(0x0fa0, chars('Slide title')),
      recB(0x0f9f, u32(1)), recB(0x0fa8, new TextEncoder().encode('First\rSecond')),
    ), 0xf);
    const anchor = recB(0xf010, cat(new Uint8Array([0, 0, 0, 0]), new Uint8Array([0, 0, 0, 0]), new Uint8Array([0x40, 1, 0, 0]), new Uint8Array([0x40, 1, 0, 0])).subarray(0, 8));
    const sp = (ref: number) => recB(0xf004, cat(anchor, recB(0xf00d, recB(0x0f9e, u32(ref)), 0xf)), 0xf);
    const slide = recB(0x03ee, recB(0x040c, recB(0xf002, recB(0xf003, cat(sp(1), sp(0)), 0xf), 0xf), 0xf), 0xf);
    const buf = cat(list, slide);
    const lt = slideListTexts(buf, pptRecord(buf, 0)!)[0].listText;
    expect(lt.map((x) => x.text)).toEqual(['Slide title', 'First\rSecond']);
    const shapes = shapesOf(buf, pptRecord(buf, list.length)!, lt);
    expect(shapes.map((s) => [s.textType, s.text])).toEqual([[1, 'First\rSecond'], [0, 'Slide title']]);
  });
  it('picture intrinsic size from PNG header (4)', () => {
    const png4 = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEUlEQVR4nGP8z8DAwMDAxAADAA4FAQH6N3DEAAAAAElFTkSuQmCC'), (c) => c.charCodeAt(0));
    expect(imageSizePt(png4)).toEqual({ w: 3, h: 3 });
    expect(imageSizePt(JPEG)).toEqual({ w: 24, h: 12 });
  });
  it('ODP fo:clip is measured against the intrinsic size and reads back (4)', async () => {
    const d = Deck.blank();
    const m = d.addMedia({ mime: 'image/png', b64: 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEUlEQVR4nGP8z8DAwMDAxAADAA4FAQH6N3DEAAAAAElFTkSuQmCC' });
    d.slides[0].elements.push({ id: 'p', kind: 'picture', media: m, x: 10, y: 10, w: 200, h: 100, crop: [0.25, 0.1, 0.25, 0.2] } as any);
    const out = await exportOdp(d);
    const content = await (await JSZip.loadAsync(out)).file('content.xml')!.async('string');
    expect(content).toContain('fo:clip="rect(0.3pt, 0.75pt, 0.6pt, 0.75pt)"');
    const pic = (await importOdp(out)).deck.slides[0].elements.find((e) => e.kind === 'picture') as any;
    expect(pic.crop.map((v: number) => +v.toFixed(3))).toEqual([0.25, 0.1, 0.25, 0.2]);
  });
  it('canvas size is clamped (15)', () => {
    expect(clampCanvas(100000, 50000).width).toBeLessThanOrEqual(16384);
    const c = clampCanvas(16000, 16000);
    expect(c.width * c.height).toBeLessThanOrEqual(268435456);
    expect(clampCanvas(1920, 1080)).toEqual({ width: 1920, height: 1080 });
  });
  it('flat ODP leaves media out with a warning but keeps pictures inline (16)', async () => {
    const d = Deck.blank();
    const v = d.addMedia({ mime: 'video/mp4', b64: 'AAAA' });
    d.slides[0].elements.push({ id: 'v', kind: 'media', mediaKind: 'video', media: v, x: 0, y: 0, w: 100, h: 100 } as any);
    const r = await exportDeck(d, 'fodp');
    expect(r.warnings?.[0]).toMatch(/flat OpenDocument/);
    expect(td.decode(r.data)).not.toContain('draw:plugin');
  });
  it('pptx duplicate shape ids get unique element ids (16)', async () => {
    const d = Deck.blank();
    d.slides[0].elements.push({ id: 'a', kind: 'shape', geom: 'rect', x: 0, y: 0, w: 10, h: 10 } as any, { id: 'b', kind: 'shape', geom: 'rect', x: 20, y: 0, w: 10, h: 10 } as any);
    const zip = await JSZip.loadAsync(await exportPptx(d));
    zip.file('ppt/slides/slide1.xml', (await zip.file('ppt/slides/slide1.xml')!.async('string')).replace(/<p:cNvPr id="\d+"/g, (m, o) => (o > 300 ? '<p:cNvPr id="7"' : m)));
    const s = (await importPptx(await zip.generateAsync({ type: 'uint8array' }))).deck.slides[0];
    const ids = s.elements.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('pptx group flips are written (16)', async () => {
    const d = Deck.blank();
    d.slides[0].elements.push({ id: 'g', kind: 'group', flipH: true, children: [{ id: 'a', kind: 'shape', geom: 'rect', x: 0, y: 0, w: 10, h: 10 }, { id: 'b', kind: 'shape', geom: 'rect', x: 20, y: 0, w: 10, h: 10 }] } as any);
    const xml = await (await JSZip.loadAsync(await exportPptx(d))).file('ppt/slides/slide1.xml')!.async('string');
    expect(xml).toMatch(/<p:grpSpPr><a:xfrm flipH="1">/);
    expect((await importPptx(await exportPptx(d))).deck.slides[0].elements.find((e) => e.kind === 'group')?.flipH).toBe(true);
  });
});
