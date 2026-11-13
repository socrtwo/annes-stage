import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import JSZip from 'jszip';
import { importDeck } from '../../src/io';
import { recoverPresentation, harvestMediaBytes, scanSlideText } from '../../src/io/recover';
import { scan } from '../../src/io/recover/fileid';
import { scanZipBytes } from '../../src/io/recover/salvage';
import { immortalInflate } from '../../src/io/recover/inflate';

const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

function findSig(u: Uint8Array, c: number, d: number, nth = 1): number {
  let hits = 0;
  for (let i = 0; i + 4 <= u.length; i++) if (u[i] === 0x50 && u[i + 1] === 0x4b && u[i + 2] === c && u[i + 3] === d && ++hits === nth) return i;
  return -1;
}

/** LSB-first bit writer for hand-built deflate streams. */
class BitWriter {
  bytes: number[] = []; cur = 0; n = 0;
  bits(v: number, len: number) { for (let i = 0; i < len; i++) { this.cur |= ((v >> i) & 1) << this.n; if (++this.n === 8) { this.bytes.push(this.cur); this.cur = 0; this.n = 0; } } }
  /** Huffman codes go most significant bit first. */
  code(v: number, len: number) { for (let i = len - 1; i >= 0; i--) this.bits((v >> i) & 1, 1); }
  done() { if (this.n) this.bytes.push(this.cur); return new Uint8Array(this.bytes); }
}

describe('recovery fixes', () => {
  it('1: a stored PNG inside a damaged package does not split it', async () => {
    const src = await JSZip.loadAsync(readFileSync('tests/fixtures/deck.pptx'));
    const names = Object.keys(src.files).filter((n) => !src.files[n].dir);
    const z = new JSZip();
    const dp = names.filter((n) => n.startsWith('docProps/'));
    const rest = names.filter((n) => !n.startsWith('docProps/'));
    for (const n of dp) z.file(n, await src.files[n].async('uint8array'));
    z.file('ppt/media/stored.png', PNG, { compression: 'STORE' });
    for (const n of rest) z.file(n, await src.files[n].async('uint8array'));
    const u = await z.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    const expected = (await importDeck(u, 'ok.pptx')).deck.slides.length;
    u.fill(0, findSig(u, 3, 4, 2), findSig(u, 3, 4, 2) + 64); // wipe the second local header
    expect(scan(u).segments).toHaveLength(1);
    const r = await recoverPresentation(u, 'talk.pptx');
    expect(r.deck).not.toBeNull();
    expect(r.deck!.slides.length).toBeGreaterThanOrEqual(expected);
    expect(r.foreign).toHaveLength(0);
  });

  it('1: a clean package followed by a PDF still splits', () => {
    const zipBytes = readFileSync('tests/fixtures/deck.pptx');
    const pdf = new TextEncoder().encode('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF\n');
    const both = new Uint8Array(zipBytes.length + pdf.length);
    both.set(zipBytes); both.set(pdf, zipBytes.length);
    expect(scan(both).segments.map((s) => s.ext)).toEqual(['pptx', 'pdf']);
  });

  it('2: keeps the genuine shift-0 partial decode of a damaged binary part', async () => {
    // Low-entropy binary (bytes 0..7): compressible, but almost no printable bytes.
    let x = 12345;
    const bin = new Uint8Array(300000);
    for (let i = 0; i < bin.length; i++) { x = (x * 1103515245 + 12345) >>> 0; bin[i] = (x >>> 16) & 7; }
    const z = new JSZip();
    z.file('ppt/embeddings/blob.bin', bin, { compression: 'DEFLATE', createFolders: false });
    const u = await z.generateAsync({ type: 'uint8array' });
    const dStart = 30 + 'ppt/embeddings/blob.bin'.length;
    const cd = findSig(u, 1, 2);
    const at = dStart + Math.floor((cd - dStart) * 0.7);
    for (let i = at; i < at + 40; i++) u[i] ^= 0x5a;
    const e = scanZipBytes(u).get('ppt/embeddings/blob.bin')!;
    expect(e.isCorrupt).toBe(true);
    expect(e.data.length).toBeGreaterThan(50000);
    expect(e.data.subarray(0, 50000)).toEqual(bin.subarray(0, 50000));
  });

  it('3: checks the CRC from a data descriptor', async () => {
    const z = new JSZip();
    z.file('ppt/slides/slide1.xml', '<p:sld>' + 'x'.repeat(5000) + '</p:sld>', { createFolders: false });
    const u = await z.generateAsync({ type: 'uint8array', compression: 'DEFLATE', streamFiles: true });
    expect(u[6] & 0x08).toBe(0x08);
    expect(scanZipBytes(u).get('ppt/slides/slide1.xml')!.isCorrupt).toBe(false);
    const dd = findSig(u, 7, 8);
    u[dd + 4] ^= 0xff;
    expect(scanZipBytes(u).get('ppt/slides/slide1.xml')!.isCorrupt).toBe(true);
  });

  it('3: rejects stored blocks whose LEN is not ~NLEN', () => {
    const ok = immortalInflate(new Uint8Array([0x01, 5, 0, 0xfa, 0xff, 104, 101, 108, 108, 111]));
    expect(ok.isCorrupt).toBe(false);
    expect(new TextDecoder().decode(ok.data)).toBe('hello');
    const bad = immortalInflate(new Uint8Array([0x01, 5, 0, 0x00, 0x00, 104, 101, 108, 108, 111]));
    expect(bad.isCorrupt).toBe(true);
    expect(bad.data.length).toBe(0);
  });

  it('3: rejects over-subscribed Huffman codes', () => {
    const w = new BitWriter();
    w.bits(1, 1); w.bits(2, 2); // BFINAL, dynamic
    w.bits(0, 5); w.bits(0, 5); w.bits(14, 4); // HLIT 257, HDIST 1, HCLEN 18
    // Code-length code: symbols 0, 1, 17, 18 with length 2 (order 16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1).
    const order = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1];
    for (const sym of order) w.bits([0, 1, 17, 18].includes(sym) ? 2 : 0, 3);
    const c = { 0: 0, 1: 1, 17: 2, 18: 3 } as Record<number, number>;
    const zeros = (n: number) => { while (n >= 11) { const k = Math.min(138, n); w.code(c[18], 2); w.bits(k - 11, 7); n -= k; } };
    // Literals 'A', 'B' and end-of-block all with length 1: over-subscribed.
    zeros(65); w.code(c[1], 2); w.code(c[1], 2); zeros(189); w.code(c[1], 2); w.code(c[0], 2);
    for (let i = 0; i < 16; i++) w.bits(i & 1, 1);
    const r = immortalInflate(w.done());
    expect(r.isCorrupt).toBe(true);
    expect(r.data.length).toBe(0);
  });

  it('4: harvests a GIF whose image data contains 00 3B', () => {
    const gif = new Uint8Array([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0x80, 0, 0, // header + LSD with a 2-colour table
      0, 0, 0, 0xff, 0xff, 0xff, // global colour table
      0x21, 0xf9, 4, 0, 0, 0, 0, 0, // graphic control extension
      0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, // image descriptor
      2, 4, 0x00, 0x3b, 0x00, 0x3b, 2, 0x4c, 0x01, 0, // LZW min size, sub-blocks with 00 3B inside
      0x3b,
    ]);
    const buf = new Uint8Array(50 + gif.length + 30).fill(0x11);
    buf.set(gif, 50);
    const found = harvestMediaBytes(buf).filter((m) => m.mime === 'image/gif');
    expect(found).toHaveLength(1);
    expect(found[0].data).toEqual(gif);
  });

  it('5: decodes numeric character references above U+FFFF', () => {
    const it2 = scanSlideText('<p:sp><p:ph type="title"/><a:p><a:r><a:t>Hi &#x1F600; &#128512;&#xD800;&#1114112;</a:t></a:r></a:p></p:sp>')!;
    expect(it2.title).toBe('Hi \u{1F600} \u{1F600}');
  });
});
