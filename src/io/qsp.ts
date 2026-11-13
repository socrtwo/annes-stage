/**
 * Native Anne's Stage formats.
 *   .qsp   ZIP package: `mimetype` (stored first), `deck.json` (the model) and `media/<id>` binaries.
 *   .qspe  the same JSON (media inline) encrypted with AES-256-GCM under a password-derived key.
 *   .json  the model as plain JSON (media inline, base64).
 */
import JSZip from 'jszip';
import { Deck } from '../model/deck';
import { encryptJson, decryptJson } from '../util/crypto';
import { b64, dec, enc, unb64 } from './xml';
import { inflateCapped, ZipBudget } from './zip';

export const QSP_MIME = 'application/x-quillstage';

export async function exportQsp(deck: Deck): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('mimetype', QSP_MIME, { compression: 'STORE' });
  const j = deck.toJSON();
  const mediaIndex: Record<string, { mime: string; name?: string }> = {};
  for (const [id, m] of Object.entries(j.media)) {
    zip.file(`media/${id}`, unb64(m.b64));
    mediaIndex[id] = { mime: m.mime, ...(m.name ? { name: m.name } : {}) };
  }
  zip.file('deck.json', JSON.stringify({ format: j.format, version: j.version, data: j.data, mediaIndex }));
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', mimeType: QSP_MIME });
}

export async function importQsp(data: Uint8Array): Promise<Deck> {
  const zip = await JSZip.loadAsync(data);
  const f = zip.file('deck.json');
  if (!f) throw new Error('This Anne\'s Stage package has no deck.json.');
  // Entries are inflated on demand within size caps (see ./zip).
  const budget = new ZipBudget();
  const j = JSON.parse(dec(await inflateCapped(f, budget)).replace(/^\uFEFF/, ''));
  const media: Record<string, any> = {};
  for (const [id, info] of Object.entries<any>(j.mediaIndex || {})) {
    const mf = zip.file(`media/${id}`);
    if (mf) media[id] = { mime: info.mime, b64: b64(await inflateCapped(mf, budget)), ...(info.name ? { name: info.name } : {}) };
  }
  return Deck.fromJSON({ format: 'quillstage', version: j.version || 1, data: j.data, media: { ...(j.media || {}), ...media } });
}

export function exportJson(deck: Deck): Uint8Array {
  return enc(JSON.stringify(deck.toJSON()));
}

export function importJson(data: Uint8Array): Deck {
  return Deck.fromJSON(JSON.parse(dec(data).replace(/^﻿/, '')));
}

export async function exportQspe(deck: Deck, password: string): Promise<Uint8Array> {
  return encryptJson(deck.toJSON(), password);
}

export async function importQspe(data: Uint8Array, password: string): Promise<Deck> {
  let j: any;
  try {
    j = await decryptJson(data.slice().buffer, password);
  } catch (e: any) {
    if (/Not an encrypted/.test(e?.message || '')) throw e;
    throw new Error('The password is incorrect, or the file is damaged.');
  }
  return Deck.fromJSON(j);
}

export const QSPE_MAGIC = 'QFDE1';
