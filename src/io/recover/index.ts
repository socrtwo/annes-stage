/**
 * Damaged-presentation recovery.
 *
 * The pipeline follows the author's Word Recovery / Immortal Unzipper design (socrtwo), as in
 * Anne's Pen and Anne's Grid, adapted to presentations. Methods run in order and the candidate deck
 * with the most recovered content wins:
 *
 *   a. identify   S2 file identification: the real type regardless of extension, embedded or
 *                 concatenated foreign data, encrypted packages.
 *   b. open       the normal (lenient) importers.
 *   c. zip        byte-level ZIP salvage: local headers instead of the central directory,
 *                 ImmortalInflate for damaged deflate data, CRC-32 checks.
 *   d. xml        XML repair and rebuild: heal each part, cut slides at the last complete shape,
 *                 rebuild the slide list, regenerate content types and relationships, drop
 *                 dangling relationships; replace unusable masters with defaults.
 *   e. slides     slide-by-slide salvage: a slide that cannot be read never costs the others.
 *   f. media      media harvest: pictures, video and audio not placed on any slide go on
 *                 "Recovered media" slides (a signature scan of the raw bytes when the ZIP is lost).
 *   g. text       <a:t> text scan of slide fragments, rebuilt as title-and-content slides.
 *   h. ppt        PowerPoint 97-2003 record salvage, resynchronizing on record headers.
 *   i. odp        OpenDocument salvage: heal content.xml, cut at the last complete page.
 *   j. strings    printable-strings scan, as a last resort (text only).
 *
 * recoverPresentation never throws for damaged input: when nothing works the report has deck null.
 */
import JSZip from 'jszip';
import { Deck } from '../../model/deck';
import type { ShapeElement } from '../../model/types';
import { scan, identifyAt, recommend, DESCRIPTIONS, type Identification, type Segment, type S2Program } from './fileid';
import { crc32 } from './inflate';
import { scanZipBytes, PACKAGE_OUTPUT_BUDGET, repairXmlPart, stripInvalidChars, balanceXml, isWellFormed, findDamageCut, stringsScan } from './salvage';
import { importPptxPkg, type Pkg } from '../pptx/import';
import { importOdpParts, importFodp } from '../odp';
import { importPpt, salvagePptText } from '../ppt';
import { openCfb } from '../cfb';
import { deckFromOutline, type OutlineItem } from '../outline';
import { b64, decodeXml, enc, sniffMediaMime } from '../xml';

export type MethodStatus = 'success' | 'partial' | 'failed' | 'skipped';
export type MethodId = 'identify' | 'open' | 'zip' | 'xml' | 'slides' | 'media' | 'text' | 'ppt' | 'odp' | 'strings';

export interface MethodResult {
  id: MethodId;
  name: string;
  /** What the method does (shown dimmed in the report). */
  desc: string;
  status: MethodStatus;
  detail: string;
  slides?: number;
}

export type PresentationKind = 'pptx' | 'pptm' | 'odp' | 'fodp' | 'ppt' | 'qsp' | 'encrypted' | 'other' | 'unknown';

export interface RepairedPackage {
  name: string;
  blob: Blob;
  kind: 'pptx' | 'odp';
  repairedParts: string[];
  salvagedParts: string[];
  lostParts: string[];
}

export interface RecoveryStats { slides: number; shapes: number; pictures: number; words: number }

export interface RecoveryReport {
  fileName: string;
  kind: PresentationKind;
  /** Format id for the importer registry (pptx, odp, ppt, …). */
  format: string;
  deck: Deck | null;
  methods: MethodResult[];
  identification: Identification;
  foreign: Segment[];
  recommended: S2Program[];
  repaired?: RepairedPackage;
  summary: string;
  unverified?: boolean;
  textOnly?: boolean;
  bestMethod: MethodId | null;
  notes: string[];
  warnings: string[];
  stats: RecoveryStats;
}

export interface RecoverOptions {
  /** Run every repair method even when the file opens normally (Open and Repair). */
  forceRepair?: boolean;
  onProgress?: (msg: string) => void;
}

const METHOD_INFO: Record<MethodId, [string, string]> = {
  identify: ['File identification', 'Identify the file by its signature (S2 File Identifier), regardless of its extension; find embedded or concatenated data and encrypted packages.'],
  open: ['Normal open', 'Open the file with the regular importer in lenient mode.'],
  zip: ['ZIP salvage', 'Walk the PK\\x03\\x04 local headers instead of the central directory, inflate each part with ImmortalInflate (keeps everything before the damage) and check CRC-32 values.'],
  xml: ['XML repair and rebuild', 'Heal damaged XML, cut slides at the last complete shape, rebuild the slide list, regenerate content types and relationships, drop dangling relationships, then open the rebuilt package.'],
  slides: ['Slide-by-slide salvage', 'Read each slide on its own, so one broken slide never costs the others.'],
  media: ['Media harvest', 'Recover every picture, video and audio file that survives, and put the ones no slide uses on "Recovered media" slides.'],
  text: ['Slide text scan', 'Scan slide XML fragments for text runs and rebuild them as title-and-content slides.'],
  ppt: ['PowerPoint 97-2003 record salvage', 'Read the PowerPoint Document records leniently, resynchronizing on record headers, and scan raw bytes when the compound file is damaged.'],
  odp: ['OpenDocument salvage', 'Heal content.xml, cut it at the last complete page and open it; otherwise scan it for text.'],
  strings: ['Strings scan (last resort)', 'Collect readable text runs from the raw bytes. Layout and formatting are lost.'],
};

const KIND_DESC: Record<string, string> = {
  pptx: 'PowerPoint presentation (PPTX)', pptm: 'PowerPoint macro-enabled presentation (PPTM)', odp: 'OpenDocument presentation (ODP)', fodp: 'Flat OpenDocument presentation (FODP)',
  ppt: 'PowerPoint 97-2003 presentation (PPT)', qsp: 'Anne\'s Stage presentation', encrypted: 'Password-protected (encrypted) Office file', unknown: 'Unrecognized data',
};

const plural = (n: number, w: string) => `${n.toLocaleString('en-US')} ${n === 1 ? w : w + 's'}`;
const dec = (u8: Uint8Array) => decodeXml(u8);

function hasAscii(u8: Uint8Array, s: string, limit = u8.length): boolean {
  const pat = enc(s);
  const end = Math.min(u8.length, limit) - pat.length;
  outer: for (let i = 0; i <= end; i++) {
    if (u8[i] !== pat[0]) continue;
    for (let j = 1; j < pat.length; j++) if (u8[i + j] !== pat[j]) continue outer;
    return true;
  }
  return false;
}

function detectKind(u8: Uint8Array, fileName: string): { kind: PresentationKind; id: Identification } {
  const lower = fileName.toLowerCase();
  const res = (kind: PresentationKind, confidence: Identification['confidence'] = 'high', ext: string = kind) => ({ kind, id: { ext, description: KIND_DESC[kind] || DESCRIPTIONS[ext] || ext, confidence } });
  if (!u8.length) return res('unknown', 'low', 'bin');
  const base = identifyAt(u8);
  if (['pptx', 'ooxml', 'zip', 'odp', 'docx', 'xlsx', 'odt', 'ods'].includes(base.ext)) {
    if (hasAscii(u8, 'application/x-quillstage', 200)) return res('qsp');
    if (base.ext === 'pptx') return res(hasAscii(u8, 'ppt/vbaProject.bin') || /\.pp[st]m$/.test(lower) ? 'pptm' : 'pptx');
    if (base.ext === 'odp') return res('odp');
    if (base.ext === 'ooxml' || base.ext === 'zip') {
      if (hasAscii(u8, 'ppt/') || /\.(pp[st][xm]|pot[xm])$/.test(lower)) return res('pptx', 'medium');
      if (hasAscii(u8, 'content.xml') && /\.o[dt]p$/.test(lower)) return res('odp', 'medium');
      if (/\.o[dt]p$/.test(lower)) return res('odp', 'low');
    }
    return { kind: 'other', id: base };
  }
  if (base.ext === 'ppt' || base.ext === 'ole') {
    const cfb = (() => { try { return openCfb(u8); } catch { return null; } })();
    if (cfb && (cfb.find('EncryptedPackage') || cfb.find('EncryptionInfo'))) return res('encrypted', 'high', 'ooxml');
    if (base.ext === 'ppt') return res('ppt');
    if (/\.(ppt|pps|pot)$/.test(lower)) return res('ppt', 'medium');
    return { kind: 'other', id: base };
  }
  const head = dec(u8.subarray(0, 4096)).toLowerCase();
  if (head.includes('office:document') && head.includes('presentation')) return res('fodp');
  if (/^\s*\{/.test(head) && head.includes('"quillstage"')) return res('qsp', 'high', 'json');
  if (/\.(pp[st][xm]|pot[xm])$/.test(lower) && hasAscii(u8, 'PK\x03\x04')) return res('pptx', 'low');
  if (/\.odp$/.test(lower) && hasAscii(u8, 'PK\x03\x04')) return res('odp', 'low');
  if (/\.(ppt|pps|pot)$/.test(lower)) return res('ppt', 'low');
  if (/\.(pptx|pptm|ppsx|potx)$/.test(lower)) return res('pptx', 'low');
  if (/\.odp$/.test(lower)) return res('odp', 'low');
  return res('unknown', 'low', base.ext);
}

const PRES_KINDS: PresentationKind[] = ['pptx', 'pptm', 'odp', 'fodp', 'ppt', 'qsp', 'encrypted'];

// ------------------------------------------------------------------------------------------
// ZIP salvage

interface Salvage { parts: Pkg; corrupt: Set<string>; salvaged: string[]; zipOk: boolean; zipError: string }

async function salvageZip(u8: Uint8Array, deep: boolean): Promise<Salvage> {
  const s: Salvage = { parts: new Map(), corrupt: new Set(), salvaged: [], zipOk: false, zipError: '' };
  const damaged = new Set<string>();
  // One output budget for every inflate of this package, so a damaged or hostile archive
  // cannot expand without bound across its entries.
  const budget = { remaining: PACKAGE_OUTPUT_BUDGET };
  try {
    const zip = await JSZip.loadAsync(u8);
    s.zipOk = true;
    for (const f of Object.values(zip.files)) {
      if (f.dir) continue;
      const declared = Number((f as any)._data?.uncompressedSize);
      if (Number.isFinite(declared) && declared > budget.remaining) { damaged.add(f.name); continue; }
      try {
        const bytes = await f.async('uint8array');
        const want = (f as any)._data?.crc32;
        if (typeof want === 'number' && want !== 0 && crc32(bytes) !== want >>> 0) { damaged.add(f.name); s.corrupt.add(f.name); }
        budget.remaining = Math.max(0, budget.remaining - bytes.length);
        s.parts.set(f.name, bytes);
      } catch { damaged.add(f.name); }
    }
  } catch (e: any) { s.zipError = e?.message || String(e); }
  if (deep || !s.zipOk || damaged.size) {
    const scanned = scanZipBytes(u8, budget);
    for (const [name, e] of scanned) {
      if (!e.isCorrupt && damaged.has(name)) s.corrupt.delete(name);
      if (e.isCorrupt && (!s.parts.has(name) || damaged.has(name))) s.corrupt.add(name);
      if (!s.parts.has(name) || damaged.has(name)) { s.parts.set(name, e.data); s.salvaged.push(name); }
    }
  }
  return s;
}

// ------------------------------------------------------------------------------------------
// PPTX repair

const SHAPE_CLOSERS = ['</p:sp>', '</p:pic>', '</p:graphicFrame>', '</p:grpSp>', '</p:cxnSp>'];
const isSlidePart = (n: string) => /^ppt\/slides\/slide\d+\.xml$/i.test(n);
const isXmlPart = (n: string) => /\.(xml|rels)$/i.test(n);
const slideNum = (n: string) => +(/(\d+)\.xml$/i.exec(n)?.[1] ?? 1e6);

/** Cuts a damaged slide at the last complete shape before the damage and closes what is open. */
export function repairSlideXml(text: string, corrupt: boolean): { xml: string; cut: boolean } | null {
  let xml = stripInvalidChars(text.replace(/^﻿/, ''));
  if (!corrupt && isWellFormed(xml)) return { xml, cut: false };
  let cut = -1;
  for (const c of SHAPE_CLOSERS) cut = Math.max(cut, findDamageCut(xml, c));
  if (cut < 0) {
    // Consistent markup that simply ends early: keep up to the last complete shape.
    const at = Math.max(...SHAPE_CLOSERS.map((c) => { const i = xml.lastIndexOf(c); return i < 0 ? -1 : i + c.length; }));
    if (at > 0 && !isWellFormed(xml)) cut = at;
  }
  if (cut > 0) xml = xml.slice(0, cut);
  const balanced = balanceXml(xml);
  if (isWellFormed(balanced)) return { xml: balanced, cut: cut > 0 };
  const r = repairXmlPart('slide.xml', xml, true);
  return r ? { xml: r.xml, cut: cut > 0 } : null;
}

const REL_SLIDE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide';
const REL_MASTER = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster';
const REL_THEME = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme';
const REL_DOC = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';
const X = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

function relsOf(xml: string): { id: string; type: string; target: string; external: boolean; raw: string }[] {
  return [...xml.matchAll(/<Relationship\b[^>]*\/?>/g)].map((m) => {
    const a = (k: string) => new RegExp(`\\b${k}="([^"]*)"`).exec(m[0])?.[1] || '';
    return { id: a('Id'), type: a('Type'), target: a('Target'), external: a('TargetMode') === 'External', raw: m[0] };
  });
}

function resolve(relsPart: string, target: string): string {
  const owner = relsPart.replace(/_rels\/([^/]+)\.rels$/, '$1');
  const parts = owner.split('/'); parts.pop();
  if (target.startsWith('/')) return target.slice(1);
  for (const seg of target.split('/')) { if (seg === '..') parts.pop(); else if (seg && seg !== '.') parts.push(seg); }
  return parts.join('/');
}

function contentTypes(names: string[]): string {
  const ov: Record<string, string> = {
    'ppt/presentation.xml': 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  };
  const byPattern: [RegExp, string][] = [
    [/^ppt\/slides\/slide\d+\.xml$/, 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml'],
    [/^ppt\/slideLayouts\/slideLayout\d+\.xml$/, 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml'],
    [/^ppt\/slideMasters\/slideMaster\d+\.xml$/, 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml'],
    [/^ppt\/notesSlides\/notesSlide\d+\.xml$/, 'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml'],
    [/^ppt\/notesMasters\/notesMaster\d+\.xml$/, 'application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml'],
    [/^ppt\/theme\/theme\d+\.xml$/, 'application/vnd.openxmlformats-officedocument.theme+xml'],
    [/^ppt\/charts\/chart\d+\.xml$/, 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml'],
    [/^ppt\/presProps\.xml$/, 'application/vnd.openxmlformats-officedocument.presentationml.presProps+xml'],
    [/^ppt\/viewProps\.xml$/, 'application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml'],
    [/^ppt\/tableStyles\.xml$/, 'application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml'],
    [/^docProps\/core\.xml$/, 'application/vnd.openxmlformats-package.core-properties+xml'],
    [/^docProps\/app\.xml$/, 'application/vnd.openxmlformats-officedocument.extended-properties+xml'],
  ];
  const defaults = new Map<string, string>([['rels', 'application/vnd.openxmlformats-package.relationships+xml'], ['xml', 'application/xml']]);
  const overrides: string[] = [];
  for (const n of names) {
    const ext = /\.([a-z0-9]+)$/i.exec(n)?.[1]?.toLowerCase();
    if (ext && ext !== 'xml' && ext !== 'rels' && !defaults.has(ext)) defaults.set(ext, sniffMediaMime(new Uint8Array(), n));
    const ct = ov[n] || byPattern.find(([re]) => re.test(n))?.[1];
    if (ct) overrides.push(`<Override PartName="/${n}" ContentType="${ct}"/>`);
  }
  return `${X}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${[...defaults].map(([e, c]) => `<Default Extension="${e}" ContentType="${c}"/>`).join('')}${overrides.join('')}</Types>`;
}

interface PptxRepair { parts: Pkg; repaired: string[]; lost: string[]; cutSlides: string[]; badSlides: string[]; rebuiltSlides: string[] }

const escX = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A minimal slide part holding recovered text in title and body placeholders. */
function textSlideXml(it: OutlineItem): string {
  const para = (t: string, lvl = 0) => `<a:p>${lvl ? `<a:pPr lvl="${lvl}"/>` : ''}<a:r><a:rPr lang="en-US"/><a:t>${escX(t)}</a:t></a:r></a:p>`;
  const sp = (id: number, ph: string, body: string) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Recovered ${id}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${body || '<a:p/>'}</p:txBody></p:sp>`;
  const body = it.bullets.map((b) => para(b.runs.map((r) => r.text).join(''), b.level)).join('');
  return `${X}<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${sp(2, '<p:ph type="title"/>', para(it.title))}${sp(3, '<p:ph idx="1"/>', body)}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

function repairPptx(src: Pkg, corrupt: Set<string>, force: boolean): PptxRepair {
  const parts: Pkg = new Map();
  const repaired: string[] = [], lost: string[] = [], cutSlides: string[] = [], badSlides: string[] = [], rebuiltSlides: string[] = [];
  for (const [name, bytes] of src) {
    if (name.endsWith('/')) continue;
    if (!isXmlPart(name)) { parts.set(name, bytes); continue; }
    const text = dec(bytes);
    if (isSlidePart(name)) {
      const r = repairSlideXml(text, corrupt.has(name) || force);
      const shapes = (x: string) => (x.match(/<p:(sp|pic|graphicFrame|grpSp|cxnSp)\b/g) || []).length;
      if (r && (shapes(r.xml) > 0 || !/<a:t>/.test(text))) { parts.set(name, enc(r.xml)); if (r.cut) cutSlides.push(name); if (r.cut || r.xml !== text) repaired.push(`${name}${r.cut ? ' (cut at the last complete shape)' : ' (healed)'}`); }
      else {
        // No shape survives: rebuild the slide in place from its text.
        const it = scanSlideText(text);
        if (it) { parts.set(name, enc(textSlideXml({ ...it, title: it.title || `Recovered slide ${slideNum(name)}` }))); rebuiltSlides.push(name); repaired.push(`${name} (rebuilt from its text)`); }
        else { badSlides.push(name); lost.push(name); }
      }
      continue;
    }
    if (!corrupt.has(name) && isWellFormed(text)) { parts.set(name, bytes); continue; }
    const r = repairXmlPart(name, text, true);
    if (r) { parts.set(name, enc(r.xml)); repaired.push(`${name} (${r.steps.join(', ') || 'checked'})`); }
    else lost.push(name);
  }
  // Masters and layouts that are unusable are dropped; the importer then uses defaults.
  for (const n of [...parts.keys()]) {
    if (/^ppt\/(slideMasters|slideLayouts)\/[^/]+\.xml$/.test(n) && !isWellFormed(dec(parts.get(n)!))) { parts.delete(n); lost.push(n); }
  }
  // Drop relationships whose target part is gone.
  for (const n of [...parts.keys()]) {
    if (!n.endsWith('.rels')) continue;
    const xml = dec(parts.get(n)!);
    const rels = relsOf(xml);
    const keep = rels.filter((r) => r.external || parts.has(resolve(n, r.target)) || n === '_rels/.rels');
    if (keep.length !== rels.length) {
      parts.set(n, enc(`${X}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${keep.map((r) => r.raw.replace(/\/?>$/, '/>')).join('')}</Relationships>`));
      repaired.push(`${n} (${plural(rels.length - keep.length, 'dangling relationship')} removed)`);
    }
  }
  // Presentation part and its relationships: rebuild when missing, damaged, or not listing the slides found.
  const slides = [...parts.keys()].filter(isSlidePart).sort((a, b) => slideNum(a) - slideNum(b));
  const masters = [...parts.keys()].filter((n) => /^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(n)).sort((a, b) => slideNum(a) - slideNum(b));
  const presXml = parts.has('ppt/presentation.xml') ? dec(parts.get('ppt/presentation.xml')!) : '';
  const presRels = parts.has('ppt/_rels/presentation.xml.rels') ? relsOf(dec(parts.get('ppt/_rels/presentation.xml.rels')!)) : [];
  const listed = presRels.filter((r) => r.type.endsWith('/slide')).map((r) => resolve('ppt/_rels/presentation.xml.rels', r.target));
  const presOk = presXml && isWellFormed(presXml) && /<p:sldIdLst|sldIdLst/.test(presXml) && slides.every((s) => listed.includes(s));
  if (!presOk) {
    const sz = /<p:sldSz[^>]*cx="(\d+)"[^>]*cy="(\d+)"/.exec(presXml);
    // Keep the original slide order when the old part lists it (via app.xml titles otherwise numeric).
    const rels: string[] = [];
    const ids: string[] = [], mids: string[] = [];
    let rid = 1;
    masters.forEach((m, i) => { rels.push(`<Relationship Id="rId${rid}" Type="${REL_MASTER}" Target="${m.slice(4)}"/>`); mids.push(`<p:sldMasterId id="${2147483648 + i * 100}" r:id="rId${rid++}"/>`); });
    slides.forEach((s, i) => { rels.push(`<Relationship Id="rId${rid}" Type="${REL_SLIDE}" Target="${s.slice(4)}"/>`); ids.push(`<p:sldId id="${256 + i}" r:id="rId${rid++}"/>`); });
    const theme = [...parts.keys()].find((n) => /^ppt\/theme\/theme\d+\.xml$/.test(n));
    if (theme) rels.push(`<Relationship Id="rId${rid++}" Type="${REL_THEME}" Target="${theme.slice(4)}"/>`);
    parts.set('ppt/presentation.xml', enc(`${X}<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">${mids.length ? `<p:sldMasterIdLst>${mids.join('')}</p:sldMasterIdLst>` : ''}${ids.length ? `<p:sldIdLst>${ids.join('')}</p:sldIdLst>` : ''}<p:sldSz cx="${sz?.[1] || 12192000}" cy="${sz?.[2] || 6858000}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`));
    parts.set('ppt/_rels/presentation.xml.rels', enc(`${X}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`));
    repaired.push(`ppt/presentation.xml (slide list rebuilt from ${plural(slides.length, 'slide part')})`);
  }
  if (!parts.has('_rels/.rels') || !relsOf(dec(parts.get('_rels/.rels')!)).some((r) => r.type.endsWith('/officeDocument'))) {
    parts.set('_rels/.rels', enc(`${X}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL_DOC}" Target="ppt/presentation.xml"/></Relationships>`));
    repaired.push('_rels/.rels (regenerated)');
  }
  parts.set('[Content_Types].xml', enc(contentTypes([...parts.keys()].filter((n) => n !== '[Content_Types].xml'))));
  return { parts, repaired, lost, cutSlides, badSlides, rebuiltSlides };
}

async function zipParts(parts: Pkg, mime?: string): Promise<Uint8Array> {
  const zip = new JSZip();
  if (mime) zip.file('mimetype', mime, { compression: 'STORE' });
  for (const [k, v] of parts) if (k !== 'mimetype') zip.file(k, v);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

// ------------------------------------------------------------------------------------------
// Text scans and media harvest

/** A character for a numeric reference, or '' when the code point is not a valid XML character. */
const charRef = (cp: number) => {
  const ok = cp === 9 || cp === 10 || cp === 13 || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff);
  return ok ? String.fromCodePoint(cp) : '';
};
const unent = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_m, d) => charRef(parseInt(d, 10))).replace(/&#x([0-9a-f]+);/gi, (_m, h) => charRef(parseInt(h, 16))).replace(/&amp;/g, '&');

/** Text of a slide XML fragment: shapes in order, the title placeholder first. */
export function scanSlideText(xml: string): OutlineItem | null {
  const shapes = xml.split(/<p:sp\b/).slice(1);
  let title = '';
  const bullets: OutlineItem['bullets'] = [];
  for (const sh of shapes) {
    const isTitle = /<p:ph\b[^>]*type="(title|ctrTitle)"/.test(sh);
    const paras = sh.split(/<a:p\b[^r]/).slice(1).map((p) => {
      const lvl = +(/<a:pPr\b[^>]*lvl="(\d)"/.exec(p)?.[1] || 0);
      const text = [...p.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => unent(m[1])).join('');
      return { lvl, text };
    }).filter((p) => p.text.trim());
    if (!paras.length) continue;
    if (isTitle && !title) title = paras.map((p) => p.text).join(' ');
    else for (const p of paras) bullets.push({ level: p.lvl, runs: [{ text: p.text }] });
  }
  if (!title && !bullets.length) {
    // No shape structure left: any text runs.
    const t = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => unent(m[1])).filter((s) => s.trim());
    if (!t.length) return null;
    return { title: t[0], bullets: t.slice(1).map((s) => ({ level: 0, runs: [{ text: s }] })) };
  }
  return { title, bullets };
}

function scanOdpText(xml: string): OutlineItem[] {
  const pages = xml.split(/<draw:page\b/).slice(1);
  return pages.map((pg) => {
    const paras = [...pg.matchAll(/<text:(?:p|h)\b[^>]*>([\s\S]*?)<\/text:(?:p|h)>/g)].map((m) => unent(m[1].replace(/<text:s\b[^>]*\/>/g, ' ').replace(/<text:(tab|line-break)\b[^>]*\/>/g, ' ').replace(/<[^>]+>/g, ''))).filter((t) => t.trim());
    return { title: paras[0] || '', bullets: paras.slice(1).map((t) => ({ level: 0, runs: [{ text: t }] })) };
  }).filter((p) => p.title || p.bullets.length);
}

/**
 * End (exclusive, after the 0x3B trailer) of a GIF starting at p, found by walking its block
 * structure: header, logical screen descriptor, global colour table, then extension blocks and
 * image descriptors (local colour table, LZW minimum code size, data sub-blocks). -1 when the
 * structure is broken or truncated. Image data can contain 00 3B, so a byte search is not enough.
 */
export function gifEnd(u8: Uint8Array, p: number): number {
  const n = u8.length;
  if (p + 13 > n || u8[p] !== 0x47 || u8[p + 1] !== 0x49 || u8[p + 2] !== 0x46 || u8[p + 3] !== 0x38 || (u8[p + 4] !== 0x37 && u8[p + 4] !== 0x39) || u8[p + 5] !== 0x61) return -1;
  let q = p + 13;
  const lsdFlags = u8[p + 10];
  if (lsdFlags & 0x80) q += 3 << ((lsdFlags & 7) + 1);
  const subBlocks = (at: number) => {
    while (at < n) { const len = u8[at]; at += 1 + len; if (len === 0) return at; }
    return -1;
  };
  let images = 0;
  while (q < n) {
    const b = u8[q];
    if (b === 0x3b) return images ? q + 1 : -1;
    if (b === 0x21) {
      if (q + 2 > n) return -1;
      q = subBlocks(q + 2);
      if (q < 0) return -1;
    } else if (b === 0x2c) {
      if (q + 10 > n) return -1;
      const f = u8[q + 9];
      q += 10;
      if (f & 0x80) q += 3 << ((f & 7) + 1);
      if (q >= n) return -1;
      const lzw = u8[q];
      if (lzw < 1 || lzw > 12) return -1;
      q = subBlocks(q + 1);
      if (q < 0) return -1;
      images++;
    } else return -1;
  }
  return -1;
}

/** Signature scan for embedded pictures and media in raw bytes. */
export function harvestMediaBytes(u8: Uint8Array, max = 200): { mime: string; data: Uint8Array }[] {
  const out: { mime: string; data: Uint8Array }[] = [];
  const find = (sig: number[], from: number) => {
    outer: for (let i = from; i <= u8.length - sig.length; i++) {
      for (let j = 0; j < sig.length; j++) if (u8[i + j] !== sig[j]) continue outer;
      return i;
    }
    return -1;
  };
  // PNG: to the IEND chunk.
  for (let p = find([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); p >= 0 && out.length < max; p = find([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], p + 8)) {
    const e = find([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82], p);
    if (e > p) out.push({ mime: 'image/png', data: u8.slice(p, e + 8) });
  }
  // JPEG: SOI with a JFIF/Exif/quantization marker, to EOI.
  for (let p = find([0xff, 0xd8, 0xff], 0); p >= 0 && out.length < max; p = find([0xff, 0xd8, 0xff], p + 3)) {
    if (![0xe0, 0xe1, 0xdb, 0xee, 0xc0].includes(u8[p + 3])) continue;
    const e = find([0xff, 0xd9], p + 4);
    if (e > p + 100) { out.push({ mime: 'image/jpeg', data: u8.slice(p, e + 2) }); p = e; }
  }
  // GIF: to the trailer.
  for (let p = find([0x47, 0x49, 0x46, 0x38], 0); p >= 0 && out.length < max; p = find([0x47, 0x49, 0x46, 0x38], p + 4)) {
    const e = gifEnd(u8, p);
    if (e > p) { out.push({ mime: 'image/gif', data: u8.slice(p, e) }); p = e - 4; }
  }
  return out;
}

function addMediaSlides(deck: Deck, items: { mime: string; b64: string; name?: string }[], title = 'Recovered media'): number {
  const imgs = items.filter((m) => /^image\/(png|jpeg|gif|bmp|webp|svg)/.test(m.mime));
  const other = items.filter((m) => !imgs.includes(m));
  const { w, h } = deck.size;
  const lay = deck.layoutByType('titleOnly')?.id || deck.data.layouts[0].id;
  let n = 0;
  for (let i = 0; i < imgs.length; i += 6) {
    const s = deck.makeSlide(lay);
    const t = s.elements.find((e) => e.ph) as ShapeElement | undefined;
    if (t) t.text = { paras: [{ level: 0, runs: [{ text: imgs.length > 6 ? `${title} (${i / 6 + 1})` : title }] }] };
    else s.elements.push({ id: `t${i}`, kind: 'shape', geom: 'rect', textbox: true, x: 40, y: 20, w: w - 80, h: 60, text: { paras: [{ level: 0, runs: [{ text: title, size: 28 }] }] } });
    const chunk = imgs.slice(i, i + 6);
    const cols = Math.min(3, chunk.length), rows = Math.ceil(chunk.length / cols);
    const cw = (w - 80) / cols, ch = (h - 160) / rows;
    chunk.forEach((m, k) => {
      const media = deck.addMedia(m);
      s.elements.push({ id: `rm${i + k}`, kind: 'picture', media, x: 40 + (k % cols) * cw + 6, y: 130 + Math.floor(k / cols) * ch + 6, w: cw - 12, h: ch - 12, alt: m.name ? `Recovered ${m.name}` : 'Recovered picture' });
      n++;
    });
    deck.data.slides.push(s);
  }
  for (const m of other) {
    const s = deck.makeSlide(lay);
    const t = s.elements.find((e) => e.ph) as ShapeElement | undefined;
    if (t) t.text = { paras: [{ level: 0, runs: [{ text: `${title}: ${m.name || m.mime}` }] }] };
    const media = deck.addMedia(m);
    s.elements.push({ id: `rmm${n}`, kind: 'media', media, mediaKind: /^audio/.test(m.mime) ? 'audio' : 'video', x: w * 0.2, y: h * 0.28, w: w * 0.6, h: h * 0.6 });
    deck.data.slides.push(s);
    n++;
  }
  return n;
}

function referencedMedia(deck: Deck): Set<string> {
  const used = new Set<string>();
  const walk = (els: any[]) => { for (const e of els) { if (e.media) used.add(e.media); if (e.poster) used.add(e.poster); if (e.fill?.media) used.add(e.fill.media); if (e.children) walk(e.children); } };
  for (const o of [...deck.data.slides, ...deck.data.layouts, ...deck.data.masters] as any[]) { walk(o.elements); if (o.bg?.media) used.add(o.bg.media); }
  return used;
}

// ------------------------------------------------------------------------------------------

export function deckStats(deck: Deck | null): RecoveryStats {
  if (!deck) return { slides: 0, shapes: 0, pictures: 0, words: 0 };
  let shapes = 0, pictures = 0, words = 0;
  const walk = (els: any[]) => {
    for (const e of els) {
      shapes++;
      if (e.kind === 'picture' && e.media) pictures++;
      if (e.text) for (const p of e.text.paras) for (const r of p.runs) words += (r.text.match(/\S+/g) || []).length;
      if (e.rows) for (const row of e.rows) for (const c of row.cells) for (const p of c.text?.paras || []) for (const r of p.runs) words += (r.text.match(/\S+/g) || []).length;
      if (e.children) walk(e.children);
    }
  };
  for (const s of deck.slides) { walk(s.elements); for (const p of s.notes) for (const r of p.runs) words += (r.text.match(/\S+/g) || []).length; }
  return { slides: deck.slides.length, shapes, pictures, words };
}

interface Candidate { id: MethodId; deck: Deck; weight: number }

/** Reports whose repair ran on a piece of a file that starts as a ZIP package. */
const zipSubRuns = new WeakSet<RecoveryReport>();

const reportScore = (r: RecoveryReport) => (r.deck ? r.stats.slides * 10 + r.stats.shapes + r.stats.pictures * 3 + r.stats.words / 10 : -1);

export async function recoverPresentation(data: Uint8Array | ArrayBuffer, name: string, opts: RecoverOptions = {}): Promise<RecoveryReport> {
  const raw = data instanceof Uint8Array ? data : new Uint8Array(data);
  const first = await recoverOnce(raw, name, opts, false);
  if (!zipSubRuns.has(first)) return first;
  // The file starts as a ZIP package but repair ran on one piece of it: a signature inside
  // the archive (stored media, say) may have split it. Repair the whole buffer too, keep the better.
  const whole = await recoverOnce(raw, name, opts, true);
  return reportScore(whole) > reportScore(first) ? whole : first;
}

async function recoverOnce(data: Uint8Array, name: string, opts: RecoverOptions, wholeBuffer: boolean): Promise<RecoveryReport> {
  const progress = (m: string) => { try { opts.onProgress?.(m); } catch { /* UI callback */ } };
  const fileName = name || 'presentation';
  const base = fileName.replace(/\.[^.]+$/, '');
  const report: RecoveryReport = {
    fileName, kind: 'unknown', format: '', deck: null, methods: [], identification: { ext: 'bin', description: 'Unrecognized data', confidence: 'low' },
    foreign: [], recommended: [], summary: '', bestMethod: null, notes: [], warnings: [], stats: deckStats(null),
  };
  const M = (id: MethodId): MethodResult => { const m: MethodResult = { id, name: METHOD_INFO[id][0], desc: METHOD_INFO[id][1], status: 'skipped', detail: '' }; report.methods.push(m); return m; };
  const cands: Candidate[] = [];
  const add = (m: MethodResult, id: MethodId, deck: Deck | null, weight: number) => { if (!deck) return; m.slides = deck.slides.length; cands.push({ id, deck, weight }); };
  try {
    const raw = data;
    // ---- a) identify
    progress('Identifying the file…');
    const mId = M('identify');
    if (!raw.length) { mId.status = 'failed'; mId.detail = 'The file is empty (0 bytes).'; report.summary = 'The file is empty (0 bytes); there is nothing to recover.'; return finish(report, cands, base); }
    let segs: Segment[] = [];
    try { segs = scan(raw).segments; } catch { segs = []; }
    let u8: Uint8Array = raw;
    let det = detectKind(raw, fileName);
    if (segs.length > 1 && wholeBuffer) report.notes.push('The file was also repaired as one whole package, ignoring the signatures found inside it.');
    else if (segs.length > 1) {
      // Several pieces: repair the first one that is a presentation.
      for (const s of segs) {
        const bytes = s.ext === 'ole' || s.ext === 'ppt' ? raw.subarray(s.offset) : s.bytes;
        const d = detectKind(bytes, fileName);
        if (PRES_KINDS.includes(d.kind) && d.id.confidence !== 'low') {
          if (s.offset > 0) report.notes.push(`Repair ran on the ${d.id.description} found at byte ${s.offset.toLocaleString('en-US')}.`);
          det = d; u8 = bytes; break;
        }
      }
      if (u8.length !== raw.length && segs[0].offset === 0 && raw[0] === 0x50 && raw[1] === 0x4b && raw[2] === 3 && raw[3] === 4) zipSubRuns.add(report);
    }
    report.kind = det.kind;
    report.identification = det.id;
    report.format = det.kind === 'encrypted' || det.kind === 'other' || det.kind === 'unknown' ? '' : det.kind;
    if (segs.length > 1) {
      report.foreign = segs.filter((s) => !(u8.byteOffset - raw.byteOffset <= s.offset && s.offset < u8.byteOffset - raw.byteOffset + u8.length)).map((s) => ({ ...s, recommended: recommend(s.ext) }));
      if (report.foreign.length) report.notes.push(`The file contains ${plural(segs.length, 'separate piece')}; ${plural(report.foreign.length, 'piece')} of another kind ${report.foreign.length === 1 ? 'was' : 'were'} set aside.`);
    }
    const ext = /\.([A-Za-z0-9]+)$/.exec(fileName)?.[1]?.toLowerCase() || '';
    const extKind = /^(pptx|pptm|ppsx|potx|ppsm|potm)$/.test(ext) ? 'pptx' : /^(ppt|pps|pot)$/.test(ext) ? 'ppt' : /^o[dt]p$/.test(ext) ? 'odp' : ext;
    const realBase = det.kind === 'pptm' ? 'pptx' : det.kind;
    if (ext && PRES_KINDS.includes(det.kind) && ['pptx', 'ppt', 'odp'].includes(extKind) && realBase !== extKind) report.notes.push(`The file is named .${ext} but is really a ${det.id.description}; it was treated as what it is.`);
    mId.status = det.kind === 'unknown' ? 'partial' : 'success';
    mId.detail = `${det.id.description} (${det.id.confidence} confidence)${segs.length > 1 ? `; ${plural(segs.length, 'piece')} found in the file` : ''}.`;
    report.recommended = recommend(det.kind === 'pptm' ? 'pptx' : det.kind === 'fodp' ? 'odp' : det.kind === 'encrypted' ? 'pptx' : det.kind === 'other' || det.kind === 'unknown' ? det.id.ext : det.kind);
    if (det.kind === 'encrypted') {
      mId.detail = 'This is a password-protected (encrypted) Office file: an encrypted package inside a compound file.';
      report.notes.push('The presentation is encrypted with a password. Open it with the password in the program that created it, remove the password (File > Info > Protect Presentation > Encrypt with Password), and save it again.');
      for (const id of ['open', 'zip', 'xml', 'slides', 'media', 'text', 'ppt', 'odp', 'strings'] as MethodId[]) { const m = M(id); m.detail = 'Not possible: the content is encrypted.'; }
      report.summary = 'This presentation is password-protected (encrypted); Anne\'s Stage cannot decrypt it.';
      return finish(report, cands, base);
    }
    if (det.kind === 'other') report.notes.push(`This is not a presentation: it looks like a ${det.id.description}.${report.recommended[0] ? ` ${report.recommended[0].name} may be able to repair it.` : ''}`);
    const kind = det.kind;
    const zipKind = kind === 'pptx' || kind === 'pptm' || kind === 'odp' || kind === 'qsp' || (kind === 'unknown' && hasAscii(u8, 'PK\x03\x04'));

    // ---- b) normal open
    progress('Opening the file normally…');
    const mOpen = M('open');
    let openOk = false;
    let openDamage = false;
    try {
      const { importDeck } = await import('../index');
      if (PRES_KINDS.includes(kind)) {
        const r = await importDeck(u8, fileName, { noRecovery: true } as any);
        add(mOpen, 'open', r.deck, 1);
        openOk = true;
        openDamage = !!(r as any).damaged || r.warnings.some((w) => /could not (be )?read|damaged|missing/i.test(w));
        mOpen.status = openDamage ? 'partial' : 'success';
        mOpen.detail = `${plural(r.deck.slides.length, 'slide')} opened${r.warnings.length ? `; ${r.warnings.slice(0, 3).join(' ')}` : '.'}`;
        report.warnings.push(...r.warnings);
      } else mOpen.detail = 'No importer recognizes this file.';
    } catch (e: any) {
      mOpen.status = 'failed';
      mOpen.detail = `The normal importer stopped: ${e?.message || e}`;
    }
    const done = openOk && !openDamage && !opts.forceRepair;

    // ---- c) ZIP salvage
    const mZip = M('zip');
    let sal: Salvage | null = null;
    if (!zipKind) mZip.detail = 'Not a ZIP package.';
    else if (done) mZip.detail = 'Not needed: the file opened normally.';
    else {
      progress('Salvaging the ZIP container…');
      sal = await salvageZip(u8, !!opts.forceRepair || !openOk);
      mZip.status = sal.parts.size ? (sal.corrupt.size || !sal.zipOk ? 'partial' : 'success') : 'failed';
      mZip.detail = sal.parts.size
        ? `${plural(sal.parts.size, 'part')} read${sal.salvaged.length ? `, ${sal.salvaged.length} from raw local headers` : ''}${sal.corrupt.size ? `; ${plural(sal.corrupt.size, 'part')} damaged (${[...sal.corrupt].slice(0, 4).join(', ')})` : ''}.${sal.zipOk ? '' : ` The central directory could not be read (${sal.zipError}).`}`
        : `No ZIP entries could be found (${sal.zipError || 'no local headers'}).`;
      if (sal.corrupt.size) report.unverified = true;
    }

    // ---- d) XML repair and rebuild (+ e) slide-by-slide, f) media, g) text)
    const mXml = M('xml'), mSlides = M('slides'), mMedia = M('media'), mText = M('text');
    const isPptx = kind === 'pptx' || kind === 'pptm' || (kind === 'unknown' && !!sal && [...sal.parts.keys()].some((k) => k.startsWith('ppt/')));
    if (!isPptx || done || !sal || !sal.parts.size) {
      const why = !isPptx ? 'Not a PowerPoint package.' : done ? 'Not needed: the file opened normally.' : 'No package parts to work with.';
      mXml.detail = why; mSlides.detail = why; mText.detail = why;
      if (!done && sal && !isPptx && kind !== 'odp' && sal.parts.size) {
        // Unknown ZIP: harvest media anyway.
        const media = [...sal.parts].filter(([n]) => /\.(png|jpe?g|gif|bmp|svg|mp4|mp3|wav|m4a|webm)$/i.test(n)).map(([n, b]) => ({ mime: sniffMediaMime(b, n), b64: b64(b), name: n.split('/').pop() }));
        if (media.length) { const d = new Deck(Deck.blankData()); addMediaSlides(d, media); add(mMedia, 'media', d, 0.3); mMedia.status = 'partial'; mMedia.detail = `${plural(media.length, 'media file')} recovered.`; }
      } else mMedia.detail = why;
    } else {
      progress('Repairing XML and rebuilding the package…');
      const rep = repairPptx(sal.parts, sal.corrupt, !!opts.forceRepair);
      let deck: Deck | null = null;
      try {
        const r = importPptxPkg(rep.parts);
        deck = r.deck;
        report.warnings.push(...r.warnings.filter((w) => !report.warnings.includes(w)));
        mXml.status = rep.repaired.length || rep.lost.length ? 'success' : 'success';
        mXml.detail = `${rep.repaired.length ? `Repaired ${plural(rep.repaired.length, 'part')}` : 'No part needed repair'}${rep.lost.length ? `; could not recover ${rep.lost.join(', ')}` : ''}; ${plural(deck.slides.length, 'slide')} opened.`;
        if (rep.cutSlides.length) report.unverified = true;
        // e) slide-by-slide: slides that failed in the importer or the repair
        const failed = [...rep.badSlides, ...r.badParts.filter(isSlidePart)];
        mSlides.status = failed.length ? 'partial' : 'success';
        mSlides.detail = failed.length ? `${plural(deck.slides.length, 'slide')} read; ${plural(failed.length, 'slide')} could not be read as slides (${failed.slice(0, 5).join(', ')}).` : `Every slide (${deck.slides.length}) was read on its own.`;
        // g) text scan of the failed slides
        const items: OutlineItem[] = [];
        for (const f of failed) { const b = sal.parts.get(f); const it = b ? scanSlideText(dec(b)) : null; if (it) items.push({ ...it, title: it.title || `Recovered text (${f.split('/').pop()})` }); }
        if (items.length) {
          const td = deckFromOutline(items, { titleFirst: false, size: deck.size });
          for (const s of td.slides) {
            const lay = deck.layoutByType(td.layout(s.layout).type || 'obj') || deck.data.layouts[0];
            const ns = deck.makeSlide(lay.id);
            for (const e of ns.elements) { const src = s.elements.find((x) => x.ph?.type === e.ph?.type || (x.ph && e.ph && (x.ph.type === 'title') === (e.ph.type === 'title'))) as ShapeElement | undefined; if (src?.text && e.kind === 'shape') e.text = src.text; }
            deck.data.slides.push(ns);
          }
          mText.status = 'partial';
          mText.detail = `Text of ${plural(items.length, 'damaged slide')} was rebuilt as title-and-content slides.`;
          report.unverified = true;
        } else if (rep.rebuiltSlides.length) {
          mText.status = 'partial';
          mText.detail = `${plural(rep.rebuiltSlides.length, 'slide')} rebuilt in place from the text found in ${rep.rebuiltSlides.length === 1 ? 'it' : 'them'} (${rep.rebuiltSlides.join(', ')}).`;
          report.unverified = true;
        } else mText.detail = failed.length ? 'No text could be found in the damaged slides.' : 'Not needed: every slide was read.';
        // f) media harvest
        const used = referencedMedia(deck);
        const usedParts = new Set<string>();
        for (const [k, v] of Object.entries(deck.media)) if (used.has(k)) usedParts.add(v.b64);
        const orphan = [...rep.parts].filter(([n]) => /^ppt\/media\//.test(n)).map(([n, b]) => ({ mime: sniffMediaMime(b, n), b64: b64(b), name: n.split('/').pop() })).filter((m) => !usedParts.has(m.b64));
        if (orphan.length) { const n = addMediaSlides(deck, orphan); mMedia.status = 'success'; mMedia.detail = `${plural(n, 'media file')} not used by any recovered slide ${n === 1 ? 'was' : 'were'} placed on "Recovered media" slides.`; }
        else mMedia.detail = `${plural(Object.keys(deck.media).length, 'media file')} recovered; all are on slides.`;
      } catch (e: any) {
        mXml.status = 'failed';
        mXml.detail = `The rebuilt package could not be opened: ${e?.message || e}`;
        // Text scan of every slide fragment, and the media.
        const items: OutlineItem[] = [];
        for (const [n, b] of [...sal.parts].filter(([n]) => isSlidePart(n)).sort((a, b) => slideNum(a[0]) - slideNum(b[0]))) { const it = scanSlideText(dec(b)); if (it) items.push({ ...it, title: it.title || `Slide ${slideNum(n)}` }); }
        if (items.length) {
          deck = deckFromOutline(items, { titleFirst: false });
          mText.status = 'partial'; mText.detail = `Text of ${plural(items.length, 'slide')} was recovered.`;
        } else mText.status = 'failed', mText.detail = 'No slide text was found.';
        const media = [...sal.parts].filter(([n]) => /^ppt\/media\//.test(n)).map(([n, b]) => ({ mime: sniffMediaMime(b, n), b64: b64(b), name: n.split('/').pop() }));
        if (media.length) { deck = deck || new Deck(Deck.blankData()); addMediaSlides(deck, media); mMedia.status = 'success'; mMedia.detail = `${plural(media.length, 'media file')} recovered.`; }
        mSlides.status = 'failed'; mSlides.detail = 'The slides could not be read as slides.';
        if (deck) { add(mText, 'text', deck, 0.6); report.unverified = true; }
      }
      if (deck && mXml.status !== 'failed') add(mXml, 'xml', deck, rep.repaired.length || rep.lost.length ? 0.95 : 0.99);
      try {
        const blob = new Blob([(await zipParts(rep.parts)).slice()], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
        report.repaired = { name: `${base} (repaired).pptx`, blob, kind: 'pptx', repairedParts: rep.repaired, salvagedParts: sal.salvaged, lostParts: rep.lost };
      } catch { /* zipping is best effort */ }
      if (!sal.zipOk && !cands.length) {
        const media = harvestMediaBytes(u8).map((m) => ({ mime: m.mime, b64: b64(m.data) }));
        if (media.length) { const d = new Deck(Deck.blankData()); addMediaSlides(d, media); add(mMedia, 'media', d, 0.3); mMedia.status = 'partial'; mMedia.detail = `${plural(media.length, 'picture')} found by signature scan.`; }
      }
    }

    // ---- h) .ppt record salvage
    const mPpt = M('ppt');
    if (kind !== 'ppt' && !(kind === 'unknown' && hasAscii(u8, 'P\0o\0w\0e\0r\0P\0o\0i\0n\0t\0'))) mPpt.detail = 'Not a PowerPoint 97-2003 file.';
    else if (done) mPpt.detail = 'Not needed: the file opened normally.';
    else {
      progress('Scanning PowerPoint 97-2003 records…');
      try {
        const r = await importPpt(u8);
        add(mPpt, 'ppt', r.deck, r.damaged ? 0.9 : 0.97);
        mPpt.status = r.damaged ? 'partial' : 'success';
        mPpt.detail = `${plural(r.deck.slides.length, 'slide')} read from the record stream.`;
      } catch (e: any) {
        const cfb = (() => { try { return openCfb(u8); } catch { return null; } })();
        const stream = cfb?.read('PowerPoint Document') || u8;
        const slides = salvagePptText(stream);
        if (slides.length) {
          const d = deckFromOutline(slides.map((s, i) => ({ title: s.title || `Slide ${i + 1}`, bullets: s.body.map((t) => ({ level: 0, runs: [{ text: t }] })) })), { titleFirst: false });
          add(mPpt, 'ppt', d, 0.7);
          mPpt.status = 'partial';
          mPpt.detail = `${plural(slides.length, 'slide')} of text recovered by scanning ${cfb ? 'the PowerPoint Document stream' : 'the raw bytes'} (${e?.message || e}).`;
          report.unverified = true;
        } else { mPpt.status = 'failed'; mPpt.detail = `No PowerPoint records could be read (${e?.message || e}).`; }
      }
    }

    // ---- i) OpenDocument salvage
    const mOdp = M('odp');
    if (kind !== 'odp' && kind !== 'fodp') mOdp.detail = 'Not an OpenDocument presentation.';
    else if (done) mOdp.detail = 'Not needed: the file opened normally.';
    else {
      progress('Repairing OpenDocument content…');
      const files: Pkg = kind === 'fodp' ? new Map([['content.xml', u8]]) : (sal?.parts || (await salvageZip(u8, true)).parts);
      const content = files.get('content.xml');
      if (!content) { mOdp.status = 'failed'; mOdp.detail = 'content.xml is missing.'; }
      else {
        let xml = stripInvalidChars(dec(content));
        let cut = false;
        if (!isWellFormed(xml)) {
          const at = xml.lastIndexOf('</draw:page>');
          if (at > 0) { xml = xml.slice(0, at + '</draw:page>'.length); cut = true; }
          xml = balanceXml(xml);
        }
        try {
          const fixed = new Map(files);
          if (kind === 'fodp') { const r = importFodp(enc(xml)); add(mOdp, 'odp', r.deck, cut ? 0.85 : 0.95); }
          else {
            fixed.set('content.xml', enc(xml));
            const st = fixed.get('styles.xml');
            if (st && !isWellFormed(dec(st))) { const r = repairXmlPart('styles.xml', dec(st), true); if (r) fixed.set('styles.xml', enc(r.xml)); else fixed.delete('styles.xml'); }
            const r = importOdpParts(fixed);
            add(mOdp, 'odp', r.deck, cut ? 0.85 : 0.95);
            try { report.repaired = { name: `${base} (repaired).odp`, blob: new Blob([(await zipParts(fixed, 'application/vnd.oasis.opendocument.presentation')).slice()]), kind: 'odp', repairedParts: cut ? ['content.xml (cut at the last complete page)'] : ['content.xml (healed)'], salvagedParts: sal?.salvaged || [], lostParts: [] }; } catch { /* best effort */ }
          }
          mOdp.status = cut ? 'partial' : 'success';
          mOdp.detail = `${plural(cands[cands.length - 1]?.deck.slides.length || 0, 'page')} recovered${cut ? ' (content after the damage was cut)' : ''}.`;
          if (cut) report.unverified = true;
        } catch (e: any) {
          const items = scanOdpText(dec(content));
          if (items.length) { add(mOdp, 'odp', deckFromOutline(items, { titleFirst: false }), 0.6); mOdp.status = 'partial'; mOdp.detail = `Text of ${plural(items.length, 'page')} recovered (${e?.message || e}).`; }
          else { mOdp.status = 'failed'; mOdp.detail = `content.xml could not be read (${e?.message || e}).`; }
        }
      }
    }

    // ---- j) strings scan
    const mStr = M('strings');
    if (cands.length) mStr.detail = 'Not needed: other methods recovered slides.';
    else {
      progress('Scanning for readable text…');
      const text = stringsScan(u8).split('\n').map((l) => l.trim()).filter((l) => l.length >= 3 && !/^[\W\d_]+$/.test(l)).slice(0, 2000);
      if (text.length) {
        const items: OutlineItem[] = [];
        for (let i = 0; i < text.length; i += 8) items.push({ title: `Recovered text (${i / 8 + 1})`, bullets: text.slice(i, i + 8).map((t) => ({ level: 0, runs: [{ text: t.slice(0, 300) }] })) });
        const d = deckFromOutline(items, { titleFirst: false });
        cands.push({ id: 'strings', deck: d, weight: 0.05 });
        mStr.slides = d.slides.length;
        mStr.status = 'partial';
        mStr.detail = `${plural(text.length, 'line')} of readable text found.`;
      } else { mStr.status = 'failed'; mStr.detail = 'No readable text was found.'; }
    }
    return finish(report, cands, base);
  } catch (e: any) {
    report.notes.push(`Recovery stopped unexpectedly: ${e?.message || e}.`);
    return finish(report, cands, base);
  }
}

function pickBest(cands: Candidate[]): Candidate | null {
  let best: Candidate | null = null, bestScore = -1;
  for (const c of cands) {
    const st = deckStats(c.deck);
    const score = (st.slides * 10 + st.shapes + st.pictures * 3 + st.words / 10) * c.weight;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best;
}

function finish(report: RecoveryReport, cands: Candidate[], base: string): RecoveryReport {
  const best = pickBest(cands);
  const st = deckStats(best?.deck ?? null);
  if (best && (st.slides > 0 || best.id === 'open')) {
    report.deck = best.deck;
    report.bestMethod = best.id;
    report.textOnly = best.id === 'strings';
    report.stats = st;
    if (!best.deck.data.props.title) best.deck.data.props.title = base;
    best.deck.clearHistory();
    const via = report.methods.find((m) => m.id === best.id)?.name.toLowerCase() || best.id;
    if (!report.summary) {
      report.summary = best.id === 'open' && !report.methods.some((m) => m.status === 'partial' && m.id !== 'identify')
        ? `The file opened normally: ${plural(st.slides, 'slide')}.`
        : best.id === 'strings'
          ? `Only loose text could be recovered (${plural(st.words, 'word')} on ${plural(st.slides, 'slide')}). Layout and formatting are lost.`
          : `Recovered ${plural(st.slides, 'slide')}${st.pictures ? ` and ${plural(st.pictures, 'picture')}` : ''} using ${via}.`;
    }
    if (report.unverified && !report.summary.includes('verify')) report.summary += ' Some content comes from a damaged area; verify it.';
  } else if (!report.summary) report.summary = 'Nothing could be recovered from this file.';
  return report;
}

/** Runs the pipeline; null when nothing could be recovered. */
export async function recoverDeck(data: Uint8Array, name: string, opts: RecoverOptions = {}): Promise<{ deck: Deck; report: RecoveryReport } | null> {
  const report = await recoverPresentation(data, name, opts);
  return report.deck ? { deck: report.deck, report } : null;
}

/** Plain-text version of a report (for Copy report). */
export function reportText(r: RecoveryReport): string {
  const lines = [`Recovery report: ${r.fileName}`, r.summary, `Identified as: ${r.identification.description} (${r.identification.confidence} confidence)`];
  if (r.notes.length) lines.push('', ...r.notes.map((n) => `- ${n}`));
  lines.push('', 'Methods:');
  for (const m of r.methods) lines.push(`  [${m.status}] ${m.name}${r.bestMethod === m.id ? ' (used)' : ''}: ${m.detail}`);
  if (r.repaired) {
    lines.push('', `Repaired package: ${r.repaired.name}`);
    if (r.repaired.salvagedParts.length) lines.push(`  Salvaged from raw bytes: ${r.repaired.salvagedParts.join(', ')}`);
    if (r.repaired.repairedParts.length) lines.push(`  Repaired: ${r.repaired.repairedParts.join('; ')}`);
    if (r.repaired.lostParts.length) lines.push(`  Lost: ${r.repaired.lostParts.join(', ')}`);
  }
  if (r.foreign.length) lines.push('', 'Other data found in the file:', ...r.foreign.map((s) => `  ${s.description}: ${s.length} bytes at byte ${s.offset}`));
  if (r.deck) lines.push('', `Recovered: ${plural(r.stats.slides, 'slide')}, ${plural(r.stats.shapes, 'object')}, ${plural(r.stats.pictures, 'picture')}, ${plural(r.stats.words, 'word')}.`);
  return lines.join('\n');
}
