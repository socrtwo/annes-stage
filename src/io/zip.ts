/**
 * Bounded ZIP reading shared by the package importers. Entries are inflated one at a time, only
 * when wanted, and never beyond a per-entry and a per-package cap: the declared uncompressed size
 * (from the central directory) is checked before inflating and the actual output is counted while
 * inflating, so a "zip bomb" that lies about its sizes is stopped too.
 */
import JSZip from 'jszip';

/** Largest single entry that is inflated (bytes). */
export const ZIP_ENTRY_CAP = 200 * 1024 * 1024;
/** Largest total of inflated entries for one package (bytes). */
export const ZIP_TOTAL_CAP = 1024 * 1024 * 1024;

export class ZipLimitError extends Error {
  constructor(message: string) { super(message); this.name = 'ZipLimitError'; }
}

/** Running total of inflated bytes, shared by the entries of one package. */
export class ZipBudget {
  used = 0;
  constructor(public perEntry = ZIP_ENTRY_CAP, public total = ZIP_TOTAL_CAP) {}
}

const mb = (n: number) => `${Math.round(n / 1048576)} MB`;

/** The entry's declared uncompressed size, when the archive records one. */
export function declaredSize(f: JSZip.JSZipObject): number | undefined {
  const n = (f as unknown as { _data?: { uncompressedSize?: unknown } })._data?.uncompressedSize;
  return typeof n === 'number' && n >= 0 ? n : undefined;
}

/** Inflates one entry, refusing (ZipLimitError) when it would pass the entry or package cap. */
export function inflateCapped(f: JSZip.JSZipObject, budget: ZipBudget = new ZipBudget()): Promise<Uint8Array> {
  const declared = declaredSize(f);
  if (declared != null && declared > budget.perEntry) return Promise.reject(new ZipLimitError(`${f.name} would expand to ${mb(declared)}, more than the ${mb(budget.perEntry)} allowed for one part.`));
  if (declared != null && budget.used + declared > budget.total) return Promise.reject(new ZipLimitError(`This file would expand to more than ${mb(budget.total)}; it is too large to open safely.`));
  return new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let n = 0;
    let done = false;
    const stream = (f as any).internalStream('uint8array');
    const fail = (e: unknown) => { if (done) return; done = true; try { stream.pause(); } catch { /* already stopped */ } reject(e); };
    stream.on('data', (c: Uint8Array) => {
      if (done) return;
      n += c.length;
      if (n > budget.perEntry) return fail(new ZipLimitError(`${f.name} expands to more than ${mb(budget.perEntry)}, the most allowed for one part.`));
      if (budget.used + n > budget.total) return fail(new ZipLimitError(`This file expands to more than ${mb(budget.total)}; it is too large to open safely.`));
      chunks.push(c);
    });
    stream.on('error', fail);
    stream.on('end', () => {
      if (done) return;
      done = true;
      budget.used += n;
      if (chunks.length === 1) return resolve(chunks[0]);
      const out = new Uint8Array(n);
      let o = 0;
      for (const c of chunks) { out.set(c, o); o += c.length; }
      resolve(out);
    });
    stream.resume();
  });
}

/** Text parts (always read first); everything else is binary and may be read on demand. */
export const isTextPart = (name: string) => /\.(xml|rels|vml|json|txt)$/i.test(name) || name === 'mimetype' || /(^|\/)\[Content_Types\]\.xml$/.test(name);

export interface CappedZip { files: Map<string, Uint8Array>; warnings: string[] }

/**
 * Reads a ZIP's entries within the caps. With `phase2`, only text parts are read first; the
 * predicate it returns (given those parts) then picks the binary entries worth inflating. An entry
 * over the per-entry cap is skipped with a warning; passing the package cap throws ZipLimitError.
 */
export async function readZipCapped(data: Uint8Array, opts: { budget?: ZipBudget; rename?: (name: string) => string; phase2?: (text: Map<string, Uint8Array>) => (name: string) => boolean } = {}): Promise<CappedZip> {
  const zip = await JSZip.loadAsync(data);
  const budget = opts.budget || new ZipBudget();
  const files = new Map<string, Uint8Array>();
  const warnings: string[] = [];
  const entries = Object.values(zip.files).filter((f) => !f.dir);
  const read = async (f: JSZip.JSZipObject) => {
    try {
      files.set(opts.rename ? opts.rename(f.name) : f.name, await inflateCapped(f, budget));
    } catch (e) {
      if (e instanceof ZipLimitError && /allowed for one part|most allowed/.test(e.message)) { warnings.push(`${e.message} It was left out.`); return; }
      throw e;
    }
  };
  if (!opts.phase2) {
    for (const f of entries) await read(f);
    return { files, warnings };
  }
  const later: JSZip.JSZipObject[] = [];
  for (const f of entries) if (isTextPart(f.name)) await read(f); else later.push(f);
  const want = opts.phase2(files);
  for (const f of later) if (want(opts.rename ? opts.rename(f.name) : f.name)) await read(f);
  return { files, warnings };
}
