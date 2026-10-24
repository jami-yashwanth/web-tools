import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { collapseRepeats, compressionRatio, looksLikeLoop, repeatsNgram } from '../../src/ai/whisper/loops';

const STORY =
  'Every morning, Maria walks her dog along the river before work. The path is quiet at that hour, and the only sounds are birds and the water moving over stones. Last spring, the city repaired the old bridge near the bakery, so now she can cross to the other side and buy fresh bread on the way home.';
// What Whisper wrote for one 30 s window when it fell into a loop (by hand, Task 7), shortened.
const LOOP = Array(12).fill('Sentence number eight, privacy matters because your recordings stay on your own device,').join(' ');
/** Distinct tokens: a stand-in for ordinary speech. */
const speech = (n: number) => Array.from({ length: n }, (_, i) => 1000 + ((i * 7919) % 5000));

describe('compressionRatio', () => {
  it('ordinary speech stays under 2.4; a looping transcript is far over', () => {
    expect(compressionRatio(STORY)).toBeLessThan(2.4);
    expect(compressionRatio(LOOP)).toBeGreaterThan(2.4);
    expect(compressionRatio('')).toBe(0);
  });
});

describe('repeatsNgram', () => {
  it('false for distinct tokens, and for a phrase said up to 4 times in a row', () => {
    expect(repeatsNgram(speech(200))).toBe(false);
    expect(repeatsNgram([...speech(10), ...Array(4).fill([1, 2, 3]).flat(), ...speech(10)])).toBe(false);
    expect(repeatsNgram([5, 5, 5, 5])).toBe(false);
    expect(repeatsNgram([])).toBe(false);
  });

  it('true for one to four tokens repeated back to back more than 4 times', () => {
    expect(repeatsNgram([...speech(5), 9, 9, 9, 9, 9])).toBe(true);
    expect(repeatsNgram([...speech(5), ...Array(5).fill([1, 2]).flat()])).toBe(true);
    expect(repeatsNgram([...Array(5).fill([1, 2, 3, 4]).flat(), ...speech(5)])).toBe(true);
  });

  it('does not count longer phrases (5 tokens or more) or repeats that are not back to back', () => {
    expect(repeatsNgram(Array(6).fill([1, 2, 3, 4, 5]).flat())).toBe(false);
    expect(repeatsNgram([1, 2, 7, 1, 2, 8, 1, 2, 9, 1, 2, 10, 1, 2])).toBe(false);
  });
});

describe('looksLikeLoop', () => {
  it('a window of ordinary speech is kept; a looping one, or one stuck on a token, is dropped', () => {
    expect(looksLikeLoop(STORY, speech(60))).toBe(false);
    expect(looksLikeLoop(LOOP, speech(60))).toBe(true);
    expect(looksLikeLoop('Thank you.', [...speech(3), 7, 7, 7, 7, 7, 7])).toBe(true);
  });
});

describe('collapseRepeats', () => {
  const s = (start: number, text: string) => ({ start, end: start + 1, text });
  it('3 or more identical segments in a row become one, over the whole run', () => {
    expect(collapseRepeats([s(0, 'Hi.'), s(1, 'Thank you.'), s(2, 'thank  you.'), s(3, 'Thank you.'), s(4, 'Bye.')])).toEqual([
      s(0, 'Hi.'),
      { start: 1, end: 4, text: 'Thank you.' },
      s(4, 'Bye.'),
    ]);
  });
  it('two in a row, or repeats apart, are left alone', () => {
    const segs = [s(0, 'Yes.'), s(1, 'Yes.'), s(2, 'No.'), s(3, 'Yes.')];
    expect(collapseRepeats(segs)).toEqual(segs);
  });
});

describe('transformers.js tripwire', () => {
  it('is exactly 4.3.1, the version whose internals the worker uses (processor, generate, _decode_asr)', async () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pkg.dependencies['@huggingface/transformers']).toBe('4.3.1');
    expect(JSON.parse(readFileSync('node_modules/@huggingface/transformers/package.json', 'utf8')).version).toBe('4.3.1');
    const { WhisperTokenizer } = await import('@huggingface/transformers');
    expect(typeof WhisperTokenizer.prototype._decode_asr).toBe('function');
  });
});
