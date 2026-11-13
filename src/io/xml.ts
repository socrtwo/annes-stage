/**
 * Small, namespace-agnostic XML helpers shared by the importers and exporters. Elements and
 * attributes are matched by local name so prefix variations between producers do not matter.
 */

/** Decodes XML bytes honoring a BOM or the encoding named in the declaration. */
export function decodeXml(u8: Uint8Array): string {
  if (u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) return new TextDecoder('utf-8').decode(u8.subarray(3));
  if (u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder('utf-16le').decode(u8.subarray(2));
  if (u8[0] === 0xfe && u8[1] === 0xff) return new TextDecoder('utf-16be').decode(u8.subarray(2));
  const head = String.fromCharCode(...Array.from(u8.subarray(0, 200)));
  const m = /^\s*<\?xml[^>]*encoding\s*=\s*["']([\w.:-]+)["']/i.exec(head);
  const label = m ? m[1].toLowerCase() : 'utf-8';
  if (label !== 'utf-8' && label !== 'utf8') {
    try { return new TextDecoder(label).decode(u8); } catch { /* unknown label */ }
  }
  return new TextDecoder('utf-8').decode(u8);
}

/** Parses XML text; retries after removing characters XML 1.0 forbids. Null on failure. */
export function parseXml(text: string): Document | null {
  const parse = (t: string): Document | null => {
    try {
      const d = new DOMParser().parseFromString(t, 'application/xml');
      if (!d.documentElement || d.documentElement.localName === 'parsererror' || d.getElementsByTagName('parsererror').length) return null;
      return d;
    } catch {
      return null;
    }
  };
  const clean = text.replace(/^﻿/, '');
  return parse(clean) || parse(clean.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ''));
}

export function kids(el: Element | null | undefined): Element[] {
  const out: Element[] = [];
  if (!el) return out;
  for (let c = el.firstElementChild; c; c = c.nextElementSibling) out.push(c);
  return out;
}

export function kid(el: Element | null | undefined, name: string): Element | null {
  if (!el) return null;
  for (let c = el.firstElementChild; c; c = c.nextElementSibling) if (c.localName === name) return c;
  return null;
}

export function kidsNamed(el: Element | null | undefined, name: string): Element[] {
  return kids(el).filter((c) => c.localName === name);
}

/** Follows a path of child local names. */
export function path(el: Element | null | undefined, ...names: string[]): Element | null {
  let e: Element | null = el || null;
  for (const n of names) { e = kid(e, n); if (!e) return null; }
  return e;
}

export function desc(el: Element | Document | null | undefined, name: string): Element[] {
  if (!el) return [];
  return Array.from(el.getElementsByTagNameNS('*', name));
}

export function firstDesc(el: Element | Document | null | undefined, name: string): Element | null {
  if (!el) return null;
  return el.getElementsByTagNameNS('*', name)[0] || null;
}

export function attr(el: Element | null | undefined, name: string): string | null {
  if (!el) return null;
  const a = el.attributes;
  for (let i = 0; i < a.length; i++) if (a[i].localName === name) return a[i].value;
  return null;
}

/** Attribute by prefixed name first (r:id), then by local name. */
export function attrQ(el: Element | null | undefined, qname: string): string | null {
  if (!el) return null;
  const v = el.getAttribute(qname);
  if (v != null) return v;
  return attr(el, qname.includes(':') ? qname.split(':')[1] : qname);
}

export function num(el: Element | null | undefined, name: string): number | null {
  const v = attr(el, name);
  if (v == null || v === '') return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

export function bool(el: Element | null | undefined, name: string): boolean | null {
  const v = attr(el, name);
  if (v == null) return null;
  return v === '1' || v === 'true' || v === 'on';
}

/** Escapes text for XML content and attribute values; drops characters XML 1.0 forbids. */
export function esc(s: string | number | null | undefined): string {
  return String(s ?? '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F￾￿]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

export const enc = (s: string) => new TextEncoder().encode(s);
export const dec = (u8: Uint8Array) => new TextDecoder('utf-8').decode(u8);

export function b64(u8: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

export function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** MIME type of image/media bytes from their signature. */
export function sniffMediaMime(u8: Uint8Array, name = ''): string {
  const h = (sig: number[], off = 0) => sig.every((b, i) => u8[off + i] === b);
  if (h([0x89, 0x50, 0x4e, 0x47])) return 'image/png';
  if (h([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (h([0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (h([0x42, 0x4d])) return 'image/bmp';
  if (h([0x52, 0x49, 0x46, 0x46]) && h([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  if (h([0x01, 0x00, 0x00, 0x00]) && h([0x20, 0x45, 0x4d, 0x46], 40)) return 'image/x-emf';
  if (h([0xd7, 0xcd, 0xc6, 0x9a])) return 'image/x-wmf';
  if (h([0x66, 0x74, 0x79, 0x70], 4)) return /\.m4a$/i.test(name) ? 'audio/mp4' : 'video/mp4';
  if (h([0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm';
  if (h([0x49, 0x44, 0x33]) || h([0xff, 0xfb])) return 'audio/mpeg';
  if (h([0x52, 0x49, 0x46, 0x46]) && h([0x57, 0x41, 0x56, 0x45], 8)) return 'audio/wav';
  if (h([0x4f, 0x67, 0x67, 0x53])) return 'audio/ogg';
  const head = new TextDecoder().decode(u8.subarray(0, 300));
  if (/<svg[\s>]/i.test(head)) return 'image/svg+xml';
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() || '';
  const byExt: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', emf: 'image/x-emf', wmf: 'image/x-wmf', tif: 'image/tiff', tiff: 'image/tiff', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', wma: 'audio/x-ms-wma', wmv: 'video/x-ms-wmv', avi: 'video/x-msvideo' };
  return byExt[ext] || 'application/octet-stream';
}

export const MIME_EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpeg', 'image/gif': 'gif', 'image/bmp': 'bmp', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/x-emf': 'emf', 'image/x-wmf': 'wmf', 'image/tiff': 'tiff',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'video/x-ms-wmv': 'wmv', 'video/x-msvideo': 'avi', 'audio/x-ms-wma': 'wma',
};

/**
 * Intrinsic size of a PNG, JPEG, GIF or BMP image in points, from its header and (when present)
 * its resolution (PNG pHYs, JFIF density, BMP pixels-per-meter); 96 dpi otherwise. Null when the
 * format or header is not recognised.
 */
export function imageSizePt(u8: Uint8Array): { w: number; h: number } | null {
  const be32 = (o: number) => (o + 4 <= u8.length ? ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0 : 0);
  const be16 = (o: number) => (o + 2 <= u8.length ? (u8[o] << 8) | u8[o + 1] : 0);
  const le16 = (o: number) => (o + 2 <= u8.length ? u8[o] | (u8[o + 1] << 8) : 0);
  const le32 = (o: number) => (o + 4 <= u8.length ? u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16) | (u8[o + 3] << 24) : 0);
  const out = (pw: number, ph: number, dx = 96, dy = dx) => {
    if (!(pw > 0 && ph > 0)) return null;
    const ok = (d: number) => (d >= 10 && d <= 10000 ? d : 96);
    return { w: (pw * 72) / ok(dx), h: (ph * 72) / ok(dy) };
  };
  if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) {
    const w = be32(16), h = be32(20);
    let dx = 96, dy = 96;
    for (let o = 8, n = 0; o + 12 <= u8.length && n < 1000; n++) {
      const l = be32(o), t = String.fromCharCode(u8[o + 4], u8[o + 5], u8[o + 6], u8[o + 7]);
      if (t === 'pHYs' && l >= 9 && u8[o + 16] === 1) { dx = be32(o + 8) * 0.0254; dy = be32(o + 12) * 0.0254; break; }
      if (t === 'IDAT' || t === 'IEND') break;
      o += 12 + l;
    }
    return out(w, h, dx, dy);
  }
  if (u8[0] === 0xff && u8[1] === 0xd8) {
    let dx = 96, dy = 96;
    for (let o = 2, n = 0; o + 9 < u8.length && n < 10000; n++) {
      if (u8[o] !== 0xff) { o++; continue; }
      const m = u8[o + 1];
      if (m === 0xff) { o++; continue; }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { o += 2; continue; }
      const l = be16(o + 2);
      if (m === 0xe0 && l >= 14 && u8[o + 4] === 0x4a && u8[o + 5] === 0x46 && u8[o + 6] === 0x49 && u8[o + 7] === 0x46) {
        const units = u8[o + 11], x = be16(o + 12), y = be16(o + 14);
        if (units === 1 && x && y) { dx = x; dy = y; } else if (units === 2 && x && y) { dx = x * 2.54; dy = y * 2.54; }
      }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return out(be16(o + 7), be16(o + 5), dx, dy);
      if (m === 0xda || l < 2) break;
      o += 2 + l;
    }
    return null;
  }
  if (u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46) return out(le16(6), le16(8));
  if (u8[0] === 0x42 && u8[1] === 0x4d && u8.length > 46) {
    const px = le32(38) * 0.0254, py = le32(42) * 0.0254;
    return out(Math.abs(le32(18)), Math.abs(le32(22)), px || 96, py || 96);
  }
  return null;
}
