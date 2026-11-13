/**
 * File format registry: detection by content, import (with automatic recovery of damaged files)
 * and export. Importers load on demand so the app starts without them.
 */
import type { Deck } from '../model/deck';
import type { RecoveryReport } from './recover';

export interface FormatDef { id: string; label: string; ext: string[]; mime: string; canImport: boolean; canExport: boolean }

export const FORMATS: FormatDef[] = [
  { id: 'pptx', label: 'PowerPoint Presentation', ext: ['pptx'], mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', canImport: true, canExport: true },
  { id: 'pptm', label: 'PowerPoint Macro-Enabled Presentation', ext: ['pptm'], mime: 'application/vnd.ms-powerpoint.presentation.macroEnabled.12', canImport: true, canExport: true },
  { id: 'ppsx', label: 'PowerPoint Show', ext: ['ppsx', 'ppsm'], mime: 'application/vnd.openxmlformats-officedocument.presentationml.slideshow', canImport: true, canExport: true },
  { id: 'potx', label: 'PowerPoint Template', ext: ['potx', 'potm'], mime: 'application/vnd.openxmlformats-officedocument.presentationml.template', canImport: true, canExport: true },
  { id: 'odp', label: 'OpenDocument Presentation', ext: ['odp'], mime: 'application/vnd.oasis.opendocument.presentation', canImport: true, canExport: true },
  { id: 'otp', label: 'OpenDocument Presentation Template', ext: ['otp'], mime: 'application/vnd.oasis.opendocument.presentation-template', canImport: true, canExport: true },
  { id: 'fodp', label: 'Flat OpenDocument Presentation', ext: ['fodp'], mime: 'application/vnd.oasis.opendocument.flat-presentation', canImport: true, canExport: true },
  { id: 'ppt', label: 'PowerPoint 97-2003 Presentation', ext: ['ppt', 'pps', 'pot'], mime: 'application/vnd.ms-powerpoint', canImport: true, canExport: false },
  { id: 'md', label: 'Markdown Slides', ext: ['md', 'markdown'], mime: 'text/markdown', canImport: true, canExport: true },
  { id: 'txt', label: 'Plain-Text Outline', ext: ['txt'], mime: 'text/plain', canImport: true, canExport: true },
  { id: 'docx', label: 'Word Document Outline', ext: ['docx'], mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', canImport: true, canExport: false },
  { id: 'rtf', label: 'Rich Text Outline', ext: ['rtf'], mime: 'application/rtf', canImport: true, canExport: true },
  { id: 'qsp', label: 'Anne\'s Stage Presentation', ext: ['qsp'], mime: 'application/x-quillstage', canImport: true, canExport: true },
  { id: 'qspe', label: 'Encrypted Anne\'s Stage Presentation', ext: ['qspe'], mime: 'application/x-quillstage-encrypted', canImport: true, canExport: true },
  { id: 'json', label: 'Anne\'s Stage JSON', ext: ['json'], mime: 'application/json', canImport: true, canExport: true },
];

export function formatById(id: string): FormatDef | undefined {
  return FORMATS.find((f) => f.id === id);
}

export function formatFromName(name: string): FormatDef | undefined {
  const ext = /\.([a-z0-9]+)$/i.exec(name || '')?.[1]?.toLowerCase();
  return ext ? FORMATS.find((f) => f.ext.includes(ext)) : undefined;
}

export class PasswordNeeded extends Error {
  constructor(message = 'This presentation is encrypted; enter its password to open it.') { super(message); this.name = 'PasswordNeeded'; }
}

/**
 * Decodes a text file: a UTF-8, UTF-16LE or UTF-16BE byte-order mark is honoured (and dropped);
 * without one, BOM-less UTF-16 is recognised by its zero bytes, and anything that is not valid
 * UTF-8 is read as Windows-1252.
 */
export function decodeText(u8: Uint8Array): string {
  if (u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) return new TextDecoder('utf-8').decode(u8.subarray(3));
  if (u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder('utf-16le').decode(u8.subarray(2));
  if (u8[0] === 0xfe && u8[1] === 0xff) return new TextDecoder('utf-16be').decode(u8.subarray(2));
  if (u8.length >= 4) {
    // Heuristic for BOM-less UTF-16: ASCII text has a zero in every other byte.
    let even = 0, odd = 0;
    const n = Math.min(u8.length & ~1, 1024);
    for (let i = 0; i < n; i += 2) { if (u8[i] === 0) even++; if (u8[i + 1] === 0) odd++; }
    if (odd > n / 2 * 0.6 && even === 0) return new TextDecoder('utf-16le').decode(u8);
    if (even > n / 2 * 0.6 && odd === 0) return new TextDecoder('utf-16be').decode(u8);
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(u8); } catch { return new TextDecoder('windows-1252').decode(u8); }
}

const ascii = (u8: Uint8Array, from: number, to: number) => { let s = ''; for (let i = from; i < Math.min(u8.length, to); i++) s += String.fromCharCode(u8[i]); return s; };
const contains = (u8: Uint8Array, s: string, limit = u8.length) => {
  const n = s.length;
  outer: for (let i = 0; i <= Math.min(u8.length, limit) - n; i++) {
    for (let j = 0; j < n; j++) if (u8[i + j] !== s.charCodeAt(j)) continue outer;
    return true;
  }
  return false;
};

/** Detects the format by content, falling back to the extension. */
export function sniffFormat(data: Uint8Array, name: string): string | null {
  const byName = formatFromName(name)?.id || null;
  if (!data.length) return byName;
  const head = ascii(data, 0, 8);
  if (head.startsWith('QFDE1')) return 'qspe';
  if (head.startsWith('PK\x03\x04') || head.startsWith('PK\x05\x06')) {
    if (contains(data, 'application/x-quillstage', 120)) return 'qsp';
    if (contains(data, 'application/vnd.oasis.opendocument.presentation-template', 120)) return 'otp';
    if (contains(data, 'application/vnd.oasis.opendocument.presentation', 120)) return 'odp';
    if (contains(data, 'ppt/')) {
      if (contains(data, 'ppt/vbaProject.bin')) return byName === 'ppsx' || byName === 'potx' ? byName : 'pptm';
      return byName === 'ppsx' || byName === 'potx' || byName === 'pptm' ? byName : 'pptx';
    }
    if (contains(data, 'word/document.xml') || contains(data, 'word/')) return 'docx';
    if (contains(data, 'content.xml')) return 'odp';
    return byName;
  }
  if (data[0] === 0xd0 && data[1] === 0xcf && data[2] === 0x11 && data[3] === 0xe0) return 'ppt';
  if (head.startsWith('{\\rtf')) return 'rtf';
  const text = decodeText(data.subarray(0, 4096)).replace(/^\uFEFF/, '');
  if (/^\s*</.test(text) && /office:document/.test(text)) return 'fodp';
  if (/^\s*\{/.test(text) && /"format"\s*:\s*"quillstage"/.test(text)) return 'json';
  if (byName === 'md' || byName === 'txt') return byName;
  if (/^---\s*$/m.test(text) || /^#{1,6}\s/m.test(text)) return 'md';
  return byName || 'txt';
}

export interface ImportResult { deck: Deck; format: string; warnings: string[]; recovery?: RecoveryReport; /** The normal importer skipped damaged parts (only with noRecovery). */ damaged?: boolean }

async function importNormal(data: Uint8Array, fmt: string, opts: { password?: string }): Promise<{ deck: Deck; warnings: string[]; damaged?: boolean }> {
  switch (fmt) {
    case 'pptx': case 'pptm': case 'ppsx': case 'potx': {
      const { importPptx } = await import('./pptx/import');
      const r = await importPptx(data);
      return { deck: r.deck, warnings: r.warnings, damaged: r.badParts.length > 0 };
    }
    case 'odp': case 'otp': case 'fodp': {
      const { importOdp } = await import('./odp');
      return importOdp(data);
    }
    case 'ppt': {
      const { importPpt } = await import('./ppt');
      return importPpt(data);
    }
    case 'md': {
      const { importMarkdown } = await import('./markdown');
      return { deck: importMarkdown(decodeText(data)), warnings: [] };
    }
    case 'txt': {
      const { importTextOutline } = await import('./outline');
      return { deck: importTextOutline(decodeText(data)), warnings: [] };
    }
    case 'docx': {
      const { importDocxOutline } = await import('./outline');
      return { deck: await importDocxOutline(data), warnings: ['Imported as an outline: each Heading 1 starts a slide.'] };
    }
    case 'rtf': {
      const { importRtfOutline } = await import('./outline');
      return { deck: importRtfOutline(new TextDecoder('latin1').decode(data)), warnings: ['Imported as an outline.'] };
    }
    case 'qsp': {
      const { importQsp } = await import('./qsp');
      return { deck: await importQsp(data), warnings: [] };
    }
    case 'json': {
      const { importJson } = await import('./qsp');
      return { deck: importJson(data), warnings: [] };
    }
    case 'qspe': {
      if (!opts.password) throw new PasswordNeeded();
      const { importQspe } = await import('./qsp');
      return { deck: await importQspe(data, opts.password), warnings: [] };
    }
  }
  throw new Error(`Anne\'s Stage cannot open this kind of file${fmt ? ` (${fmt})` : ''}.`);
}

/**
 * Opens any supported file. When normal parsing fails or the file is damaged, runs the recovery
 * pipeline (repair forces it) and returns its best deck with the report.
 */
export async function importDeck(data: Uint8Array, name: string, opts: { repair?: boolean; password?: string; noRecovery?: boolean } = {}): Promise<ImportResult> {
  const fmt = sniffFormat(data, name) || '';
  const warnings: string[] = [];
  const byName = formatFromName(name)?.id;
  if (byName && fmt && byName !== fmt && !(fmt.startsWith('ppt') && byName.startsWith('pp')) && !(fmt === 'pptx' && byName === 'potx')) {
    warnings.push(`The file is named .${name.split('.').pop()} but its content is ${formatById(fmt)?.label || fmt}; it was opened as what it is.`);
  }
  let normal: { deck: Deck; warnings: string[]; damaged?: boolean } | null = null;
  let error: unknown = null;
  if (!opts.repair || opts.noRecovery) {
    try { normal = await importNormal(data, fmt, opts); } catch (e) { error = e; }
  }
  if (error instanceof PasswordNeeded || (fmt === 'qspe' && error)) throw error;
  if (opts.noRecovery) {
    if (!normal) throw error;
    return { deck: normal.deck, format: fmt, warnings: [...warnings, ...normal.warnings], ...(normal.damaged ? { damaged: true } : {}) };
  }
  const recoverable = ['pptx', 'pptm', 'ppsx', 'potx', 'odp', 'otp', 'fodp', 'ppt', 'qsp', ''].includes(fmt) || !normal;
  if (normal && !normal.damaged && !opts.repair) return { deck: normal.deck, format: fmt, warnings: [...warnings, ...normal.warnings] };
  if (!recoverable && normal) return { deck: normal.deck, format: fmt, warnings: [...warnings, ...normal.warnings] };
  const { recoverPresentation } = await import('./recover');
  const report = await recoverPresentation(data, name, { forceRepair: !!opts.repair });
  if (report.deck) return { deck: report.deck, format: fmt || report.format, warnings: [...warnings, ...report.warnings.filter((w) => !warnings.includes(w))], recovery: report };
  if (normal) return { deck: normal.deck, format: fmt, warnings: [...warnings, ...normal.warnings] };
  throw error instanceof Error ? error : new Error(report.summary || 'This file could not be opened.');
}

export async function exportDeck(deck: Deck, format: string, opts: { password?: string } = {}): Promise<{ data: Uint8Array; mime: string; ext: string; /** Content the format could not carry. */ warnings?: string[] }> {
  const def = formatById(format);
  if (!def || !def.canExport) throw new Error(`Anne\'s Stage cannot save as ${format}.`);
  const out = (data: Uint8Array) => ({ data, mime: def.mime, ext: def.ext[0] });
  const enc = (s: string) => new TextEncoder().encode(s);
  switch (format) {
    case 'pptx': case 'pptm': case 'ppsx': case 'potx': {
      const { exportPptx } = await import('./pptx/export');
      return out(await exportPptx(deck, format));
    }
    case 'odp': case 'otp': case 'fodp': {
      const { exportOdp } = await import('./odp');
      const warnings: string[] = [];
      const data = await exportOdp(deck, { flat: format === 'fodp', template: format === 'otp', warnings });
      return warnings.length ? { ...out(data), warnings } : out(data);
    }
    case 'md': {
      const { exportMarkdown } = await import('./markdown');
      return out(enc(exportMarkdown(deck)));
    }
    case 'txt': {
      const { outlineToText } = await import('./outline');
      return out(enc(outlineToText(deck)));
    }
    case 'rtf': {
      const { outlineToRtf } = await import('./outline');
      return out(enc(outlineToRtf(deck)));
    }
    case 'qsp': {
      const { exportQsp } = await import('./qsp');
      return out(await exportQsp(deck));
    }
    case 'qspe': {
      if (!opts.password) throw new PasswordNeeded('A password is needed to save an encrypted presentation.');
      const { exportQspe } = await import('./qsp');
      return out(await exportQspe(deck, opts.password));
    }
    case 'json': {
      const { exportJson } = await import('./qsp');
      return out(exportJson(deck));
    }
  }
  throw new Error(`Anne\'s Stage cannot save as ${format}.`);
}

export type { RecoveryReport };
