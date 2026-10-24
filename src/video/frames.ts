// Video to GIF: the pure rules. Which moments of the trimmed span become GIF frames, whether a trim can be made, the
// GIF's size, and which decoded frame stands for each moment.

/** GIFs can be up to 15 seconds (spec §3): GIF files get large quickly. */
export const MAX_GIF_SECONDS = 15;

export type GifWidth = 320 | 480;
export type GifFps = 10 | 15;

/** Trim inputs are typed to a tenth of a second: an end of 3.1 on a 3.05 s video is its end. */
const lastTenth = (durationS: number) => Math.ceil(Math.round(durationS * 1e6) / 1e5 - 1e-6) / 10;

/** Seconds, to the microsecond: 0.1 × 3 is 0.3, not 0.30000000000000004. */
const us = (s: number) => Math.round(s * 1e6) / 1e6;

/**
 * The moments (seconds) the GIF shows, one every 1/fps from `start` and before `end`. A span over 15 s, or an end not
 * after a start of 0 or more, is a RangeError (the page checks the trim first: see `checkTrim`).
 */
export function sampleTimes(start: number, end: number, fps: GifFps): number[] {
  if (!(start >= 0) || !(end > start)) throw new RangeError(`no span from ${start} to ${end}`);
  if (end - start > MAX_GIF_SECONDS + 1e-9) throw new RangeError(`a span of ${end - start} s is over ${MAX_GIF_SECONDS} s`);
  const n = Math.max(1, Math.ceil(us((end - start) * fps)));
  return Array.from({ length: n }, (_, i) => us(start + i / fps));
}

/**
 * Can this trim be made? Over 15 s is `too-long`, said first, even when the end is past the video too (the limit is
 * the thing to know). An end not after the start, a start below 0, an end past the video or a blank box is `invalid`.
 */
export function checkTrim(t: { start: number; end: number; durationS: number }): 'ok' | 'too-long' | 'invalid' {
  const { start, end, durationS } = t;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return 'invalid';
  if (end - start > MAX_GIF_SECONDS + 1e-9) return 'too-long';
  if (end > lastTenth(durationS) + 1e-9) return 'invalid';
  return 'ok';
}

/** The GIF's size: the picture upright (a quarter-turned video is portrait), `width` wide, an even height. */
export function gifSize(w: number, h: number, rotation: 0 | 90 | 180 | 270, width: GifWidth): { width: number; height: number } {
  const turned = rotation === 90 || rotation === 270;
  const [shownW, shownH] = turned ? [h, w] : [w, h];
  return { width, height: Math.max(2, Math.round((width * shownH) / shownW / 2) * 2) };
}

export interface Picker<F> {
  /** A decoded frame, at its presentation timestamp (µs). Frames must come in presentation order. */
  push(frame: F, ts: number): void;
  /** No more frames: the rest of the samples go to the last one. */
  finish(): void;
  /** Every sample has its frame: later frames can't be nearer, so decoding can stop. */
  readonly done: boolean;
  /** How many samples have their frame so far. */
  readonly assigned: number;
}

/**
 * Picks, for each sample time (µs, ascending), the decoded frame nearest to it, holding at most one frame at a time.
 * `emit(frame, n)` gives a frame and how many samples in a row it stands for (one GIF frame shown n times as long),
 * in order; `release(frame)` lets go of every frame, emitted or not, as soon as it is no longer needed.
 */
export function createPicker<F>(timesUs: number[], emit: (frame: F, samples: number) => void, release: (frame: F) => void): Picker<F> {
  let held: { frame: F; ts: number; samples: number } | null = null;
  let i = 0;
  const flush = ({ frame, samples }: { frame: F; samples: number }) => {
    try {
      if (samples) emit(frame, samples);
    } finally {
      release(frame);
    }
  };
  const letGo = () => {
    if (!held) return;
    const h = held;
    held = null;
    flush(h);
  };
  return {
    push(frame, ts) {
      if (i >= timesUs.length || (held && ts < held.ts)) {
        // Past the last sample (the last frame has been emitted already), or out of order: of no use.
        release(frame);
        return;
      }
      let samples = 0;
      // Samples up to this frame go to whichever of the two is nearer; a tie goes to the later frame.
      while (i < timesUs.length && timesUs[i]! <= ts) {
        const t = timesUs[i]!;
        if (held && !samples && t - held.ts < ts - t) held.samples++;
        else samples++;
        i++;
      }
      // Hold the new frame before the old one is emitted, so a throwing `emit` can't leave it unreleased: it is let
      // go of with the last sample, or by `finish`.
      const prev = held;
      held = { frame, ts, samples };
      try {
        if (prev) flush(prev);
      } finally {
        if (i >= timesUs.length) letGo();
      }
    },
    finish() {
      if (held) held.samples += timesUs.length - i;
      i = timesUs.length;
      letGo();
    },
    get done() {
      return i >= timesUs.length;
    },
    get assigned() {
      return i;
    },
  };
}

/**
 * The samples (indices, in decode order) to decode for a span (µs): from the keyframe at or before its start (or the
 * first keyframe), up to (not including) the first keyframe at or after its end. Nothing before the keyframe is
 * needed to decode the span, and nothing from the next keyframe on can show inside it.
 */
export function decodeSpan(samples: { timestamp: number; key: boolean }[], startUs: number, endUs: number): { from: number; to: number } {
  let from = -1;
  for (const [i, s] of samples.entries()) {
    if (!s.key) continue;
    if (s.timestamp <= startUs || from < 0) from = i;
    if (s.timestamp > startUs) break;
  }
  from = Math.max(0, from);
  let to = samples.length;
  for (let j = from + 1; j < samples.length; j++) {
    const s = samples[j]!;
    if (s.key && s.timestamp >= endUs) {
      to = j;
      break;
    }
  }
  return { from, to };
}

/** Over 20 MB a GIF is slow to load and share: the result says how to get a smaller one. */
export const LARGE_GIF_BYTES = 20_000_000;
export const isLargeGif = (bytes: number): boolean => bytes > LARGE_GIF_BYTES;
