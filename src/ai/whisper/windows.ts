// Long audio is transcribed in 30 s windows (Whisper reads 30 s at once) that overlap by 5 s on each side, as
// transformers.js's own pipeline does it: the words in an overlap are read twice and the two readings are merged,
// so none are lost or doubled at the seams. Pure.

/** Whisper's input length, in seconds. */
export const WINDOW_S = 30;
/** How much of each window, on each side, it shares with its neighbour. */
export const STRIDE_S = WINDOW_S / 6;

export interface Window {
  /** Sample offsets in the audio: [start, end). */
  start: number;
  end: number;
  /** Samples at each edge shared with the neighbour (0 at the audio's own start and end). */
  strideLeft: number;
  strideRight: number;
}

/** The windows over `length` samples at `rate`, in order, exactly as the transformers.js pipeline cuts them. */
export function planWindows(length: number, rate: number): Window[] {
  const window = WINDOW_S * rate;
  const stride = STRIDE_S * rate;
  const jump = window - 2 * stride;
  const out: Window[] = [];
  for (let start = 0; ; start += jump) {
    const end = Math.min(length, start + window);
    const isLast = start + window >= length;
    out.push({ start, end, strideLeft: start === 0 ? 0 : stride, strideRight: isLast ? 0 : stride });
    if (isLast) return out;
  }
}

/** The part of a window that is its own (no neighbour reads it), in seconds. */
export const ownSpan = (w: Window, rate: number): [number, number] => [(w.start + w.strideLeft) / rate, (w.end - w.strideRight) / rate];
