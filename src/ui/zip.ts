import { zipSync, Zip, ZipPassThrough, type Zippable } from 'fflate';

/**
 * Bundle files into one ZIP. Images are already compressed, so they are stored (level 0), not deflated;
 * storing is a plain copy, so the synchronous API is fast and avoids fflate spawning blob: workers.
 */
export async function zipFiles(files: { name: string; blob: Blob }[]): Promise<Blob> {
  const entries: Zippable = {};
  for (const f of files) entries[f.name] = new Uint8Array(await f.blob.arrayBuffer());
  return new Blob([zipSync(entries, { level: 0 }) as BlobPart], { type: 'application/zip' });
}

/**
 * A ZIP built one file at a time, for when the files arrive over time (PDF to JPG pages) and must not all be held as
 * separate copies: each file's bytes are handed over and dropped; only the ZIP's own chunks are kept, then made one Blob.
 */
export function zipStream() {
  const chunks: Uint8Array[] = [];
  let failure: Error | undefined;
  let finished!: () => void;
  const end = new Promise<void>((resolve) => (finished = resolve));
  const zip = new Zip((err, chunk, final) => {
    if (err) failure = err;
    else chunks.push(chunk);
    if (final || err) finished();
  });
  return {
    /** Store `bytes` as `name` (images are already compressed, so stored as they are). */
    add(name: string, bytes: Uint8Array): void {
      const file = new ZipPassThrough(name);
      zip.add(file);
      file.push(bytes, true);
    },
    async finish(): Promise<Blob> {
      zip.end();
      await end;
      if (failure) throw failure;
      const blob = new Blob(chunks as BlobPart[], { type: 'application/zip' });
      chunks.length = 0;
      return blob;
    },
  };
}
