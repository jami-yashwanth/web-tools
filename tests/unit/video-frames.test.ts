import { describe, expect, it } from 'vitest';
import { checkTrim, createPicker, decodeSpan, gifSize, isLargeGif, LARGE_GIF_BYTES, MAX_GIF_SECONDS, sampleTimes } from '../../src/video/frames';

describe('Video to GIF: sample times', () => {
  it('0–2 s at 10 fps: 20 times, from 0 to 1.9', () => {
    const t = sampleTimes(0, 2, 10);
    expect(t).toHaveLength(20);
    expect(t[0]).toBe(0);
    expect(t.at(-1)).toBe(1.9);
    expect(t[3]).toBe(0.3); // no floating-point drift
  });

  it('starts at the trim start, one frame every 1/fps', () => {
    const t = sampleTimes(1.5, 2.5, 15);
    expect(t).toHaveLength(15);
    expect(t[0]).toBe(1.5);
    expect(t[1]).toBeCloseTo(1.5 + 1 / 15, 6);
    expect(t.every((x) => x >= 1.5 && x < 2.5)).toBe(true);
  });

  it('a span that is not a whole number of frames still covers it', () => {
    expect(sampleTimes(0, 0.25, 10)).toEqual([0, 0.1, 0.2]);
    expect(sampleTimes(0, 0.05, 10)).toEqual([0]);
  });

  it('takes up to 15 s; a span over 15 s is a RangeError', () => {
    expect(MAX_GIF_SECONDS).toBe(15);
    expect(sampleTimes(0, 15, 15)).toHaveLength(225);
    expect(() => sampleTimes(0, 15.1, 10)).toThrow(RangeError);
    expect(() => sampleTimes(2, 20, 10)).toThrow(RangeError);
  });

  it('an end at or before the start is a RangeError', () => {
    expect(() => sampleTimes(2, 2, 10)).toThrow(RangeError);
    expect(() => sampleTimes(3, 1, 10)).toThrow(RangeError);
    expect(() => sampleTimes(-1, 1, 10)).toThrow(RangeError);
  });
});

describe('Video to GIF: trim validation', () => {
  const d = 3;
  it('a span inside the video, up to 15 s, is ok', () => {
    expect(checkTrim({ start: 0, end: 2, durationS: d })).toBe('ok');
    expect(checkTrim({ start: 0, end: 15, durationS: 60 })).toBe('ok');
    expect(checkTrim({ start: 1, end: 3, durationS: d })).toBe('ok');
  });

  it('over 15 s is too long, even past the end of the video', () => {
    expect(checkTrim({ start: 0, end: 15.1, durationS: 60 })).toBe('too-long');
    expect(checkTrim({ start: 0, end: 20, durationS: d })).toBe('too-long');
  });

  it('an end not after the start, or outside the video, is invalid', () => {
    expect(checkTrim({ start: 2, end: 2, durationS: d })).toBe('invalid');
    expect(checkTrim({ start: 2, end: 1, durationS: d })).toBe('invalid');
    expect(checkTrim({ start: -1, end: 1, durationS: d })).toBe('invalid');
    expect(checkTrim({ start: 0, end: 4, durationS: d })).toBe('invalid');
    expect(checkTrim({ start: NaN, end: 1, durationS: d })).toBe('invalid');
    expect(checkTrim({ start: 0, end: NaN, durationS: d })).toBe('invalid');
  });

  it('an end typed to one decimal place at the end of the video is inside it', () => {
    expect(checkTrim({ start: 0, end: 3.1, durationS: 3.05 })).toBe('ok');
  });
});

describe('Video to GIF: size', () => {
  it('scales to the chosen width, keeping the aspect ratio, with an even height', () => {
    expect(gifSize(640, 360, 0, 320)).toEqual({ width: 320, height: 180 });
    expect(gifSize(1920, 1080, 0, 480)).toEqual({ width: 480, height: 270 });
    expect(gifSize(640, 480, 0, 480)).toEqual({ width: 480, height: 360 });
    expect(gifSize(1000, 333, 0, 320)).toEqual({ width: 320, height: 106 });
  });

  it('a video turned a quarter is shown upright: portrait', () => {
    expect(gifSize(640, 360, 90, 320)).toEqual({ width: 320, height: 568 });
    expect(gifSize(640, 360, 270, 480)).toEqual({ width: 480, height: 854 });
    expect(gifSize(640, 360, 180, 320)).toEqual({ width: 320, height: 180 });
  });
});

describe('Video to GIF: picking the nearest frame for each sample', () => {
  /** Feed frames (µs timestamps) to a picker: what it emits, and what it lets go of. */
  function run(timesUs: number[], frameTs: number[]) {
    const emitted: [number, number][] = [];
    const released: number[] = [];
    const picker = createPicker<number>(timesUs, (f, n) => emitted.push([f, n]), (f) => released.push(f));
    for (const ts of frameTs) picker.push(ts, ts);
    picker.finish();
    return { emitted, released, picker };
  }

  it('30 fps to 10 fps: every third frame, once each', () => {
    const frames = Array.from({ length: 30 }, (_, i) => Math.round((i * 1e6) / 30));
    const { emitted } = run([0, 100_000, 200_000, 300_000], frames);
    expect(emitted).toEqual([
      [0, 1],
      [100_000, 1],
      [200_000, 1],
      [300_000, 1],
    ]);
  });

  it('5 fps to 10 fps: each frame shown for two samples (one GIF frame, twice as long)', () => {
    const { emitted } = run([0, 100_000, 200_000, 300_000], [0, 200_000, 400_000]);
    // 100 ms is as near 0 as 200 ms: the later frame wins a tie.
    expect(emitted).toEqual([
      [0, 1],
      [200_000, 2],
      [400_000, 1],
    ]);
  });

  it('the nearest frame, before or after the sample time', () => {
    const { emitted } = run([100_000], [0, 90_000, 130_000]);
    expect(emitted).toEqual([[90_000, 1]]);
    expect(run([100_000], [0, 70_000, 110_000]).emitted).toEqual([[110_000, 1]]);
  });

  it('frames before the span (from the keyframe) and after it are let go, every one exactly once', () => {
    const frames = [0, 500_000, 1_000_000, 1_100_000, 1_200_000, 1_300_000, 2_000_000];
    const { emitted, released } = run([1_000_000, 1_100_000, 1_200_000], frames);
    expect(emitted.map(([f]) => f)).toEqual([1_000_000, 1_100_000, 1_200_000]);
    expect([...released].sort((a, b) => a - b)).toEqual(frames);
  });

  it('samples past the last frame go to the last frame', () => {
    const { emitted } = run([0, 100_000, 200_000], [0, 50_000]);
    expect(emitted).toEqual([
      [0, 1],
      [50_000, 2],
    ]);
  });

  it('is done once a frame at or after the last sample has come', () => {
    const emitted: number[] = [];
    const picker = createPicker<number>([0, 100_000], (f) => emitted.push(f), () => {});
    picker.push(0, 0);
    expect(picker.done).toBe(false);
    picker.push(100_000, 100_000);
    expect(picker.done).toBe(true);
    // Later frames are let go at once.
    const released: number[] = [];
    const p2 = createPicker<number>([0], () => {}, (f) => released.push(f));
    p2.push(0, 0);
    p2.push(50_000, 50_000);
    expect(released).toContain(0);
  });

  it('counts the samples assigned so far', () => {
    const picker = createPicker<number>([0, 100_000, 200_000], () => {}, () => {});
    picker.push(0, 0);
    expect(picker.assigned).toBe(1);
    picker.push(150_000, 150_000);
    expect(picker.assigned).toBe(2);
  });
});

describe('Video to GIF: the span to decode', () => {
  // 30 fps, a keyframe every 10 frames (every 333 ms), in decode order.
  const samples = Array.from({ length: 90 }, (_, i) => ({ timestamp: Math.round((i * 1e6) / 30), key: i % 10 === 0 }));

  it('from the keyframe at or before the start, up to the first keyframe at or after the end', () => {
    expect(decodeSpan(samples, 0, 2_000_000)).toEqual({ from: 0, to: 60 });
    expect(decodeSpan(samples, 500_000, 1_000_000)).toEqual({ from: 10, to: 30 });
    expect(decodeSpan(samples, 333_333, 1_000_001)).toEqual({ from: 10, to: 40 });
  });

  it('through the last sample when no keyframe follows the end', () => {
    expect(decodeSpan(samples, 2_500_000, 3_000_000)).toEqual({ from: 70, to: 90 });
  });

  it('from the first keyframe when the start is before it', () => {
    const late = samples.map((s, i) => ({ ...s, key: i === 5 || i === 50 }));
    expect(decodeSpan(late, 0, 1_000_000)).toEqual({ from: 5, to: 50 });
  });
});

describe('Video to GIF: a picker whose emit throws', () => {
  it('still lets go of every frame exactly once', () => {
    const frames = [0, 100_000, 200_000, 300_000];
    const released: number[] = [];
    const picker = createPicker<number>(
      [0, 100_000, 200_000],
      () => {
        throw new Error('draw failed');
      },
      (f) => released.push(f),
    );
    for (const ts of frames) {
      try {
        picker.push(ts, ts);
      } catch {
        // the caller records the failure and carries on letting go
      }
    }
    try {
      picker.finish();
    } catch {
      // as above
    }
    expect([...released].sort((a, b) => a - b)).toEqual(frames);
  });
});

describe('Video to GIF: large result', () => {
  it('over 20 MB is a large GIF', () => {
    expect(LARGE_GIF_BYTES).toBe(20_000_000);
    expect(isLargeGif(20_000_000)).toBe(false);
    expect(isLargeGif(20_000_001)).toBe(true);
    expect(isLargeGif(500_000)).toBe(false);
  });
});
