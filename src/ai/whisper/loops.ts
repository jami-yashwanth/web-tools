import { zlibSync } from 'fflate';
import type { Segment } from './subtitles';

// Whisper's known failure: it falls into a loop and writes one phrase over and over until its token limit. A window
// whose reading looks like that is dropped (its words are lost; the made-up text would be worse), as Whisper's own
// compression-ratio check does. Pure.

/** Whisper's own threshold: text that zlib squeezes more than this is repeating itself. */
const MAX_COMPRESSION_RATIO = 2.4;
/** The longest phrase, in tokens, checked for back-to-back repeats, and how many repeats in a row are too many. */
const MAX_NGRAM = 4;
const MAX_REPEATS = 4;

/** UTF-8 bytes over zlib bytes. */
export function compressionRatio(text: string): number {
  const bytes = new TextEncoder().encode(text);
  return bytes.length ? bytes.length / zlibSync(bytes).length : 0;
}

/** Does some run of 1 to 4 tokens repeat itself back to back more than 4 times (5 copies or more in a row)? */
export function repeatsNgram(tokens: readonly number[]): boolean {
  for (let n = 1; n <= MAX_NGRAM; n++) {
    for (let i = 0; i + n <= tokens.length; i++) {
      let copies = 1;
      while (i + (copies + 1) * n <= tokens.length && sameRun(tokens, i, i + copies * n, n)) copies++;
      if (copies > MAX_REPEATS) return true;
    }
  }
  return false;
}
function sameRun(t: readonly number[], a: number, b: number, n: number): boolean {
  for (let k = 0; k < n; k++) if (t[a + k] !== t[b + k]) return false;
  return true;
}

/** A window's reading that is a loop: its text compresses too well, or its tokens repeat a short phrase. */
export const looksLikeLoop = (text: string, tokens: readonly number[]): boolean =>
  compressionRatio(text) > MAX_COMPRESSION_RATIO || repeatsNgram(tokens);

/** Runs of 3 or more segments saying the same thing become one segment over the whole run. */
export function collapseRepeats(segments: Segment[]): Segment[] {
  const key = (s: Segment) => s.text.replace(/\s+/g, ' ').trim().toLowerCase();
  const out: Segment[] = [];
  for (let i = 0; i < segments.length; ) {
    let j = i + 1;
    while (j < segments.length && key(segments[j]!) === key(segments[i]!)) j++;
    const run = j - i;
    if (run >= 3) out.push({ ...segments[i]!, end: segments[j - 1]!.end });
    else out.push(...segments.slice(i, j));
    i = j;
  }
  return out;
}
