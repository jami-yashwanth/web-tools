import { describe, expect, it } from 'vitest';
import { downmix, hasSound, resample } from '../../src/ai/whisper/audio';

const sine = (hz: number, rate: number, seconds: number, amp = 0.5) =>
  Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / rate));

describe('resample', () => {
  it('44.1 kHz → 16 kHz keeps the duration within one sample', () => {
    for (const seconds of [1, 2.5, 7.3]) {
      const out = resample(sine(440, 44_100, seconds), 44_100, 16_000);
      expect(Math.abs(out.length - seconds * 16_000)).toBeLessThanOrEqual(1);
    }
  });

  it('48 kHz and 8 kHz → 16 kHz keep the duration too', () => {
    expect(Math.abs(resample(sine(440, 48_000, 3), 48_000, 16_000).length - 48_000)).toBeLessThanOrEqual(1);
    expect(Math.abs(resample(sine(440, 8_000, 3), 8_000, 16_000).length - 48_000)).toBeLessThanOrEqual(1);
  });

  it('keeps a tone well below the new Nyquist: same frequency, same level', () => {
    const out = resample(sine(440, 44_100, 1), 44_100, 16_000);
    const ref = sine(440, 16_000, 1);
    let err = 0;
    for (let i = 100; i < out.length - 100; i++) err = Math.max(err, Math.abs(out[i]! - ref[i]!));
    expect(err).toBeLessThan(0.03);
  });

  it('damps a tone above the new Nyquist rather than folding it back at full level', () => {
    const out = resample(sine(12_000, 48_000, 1), 48_000, 16_000);
    const peak = out.slice(100, -100).reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    expect(peak).toBeLessThan(0.25); // the input's peak is 0.5
  });

  it('is the same samples at the same rate, and empty for empty input', () => {
    const x = sine(440, 16_000, 0.1);
    expect(resample(x, 16_000, 16_000)).toEqual(x);
    expect(resample(new Float32Array(0), 44_100, 16_000)).toHaveLength(0);
  });
});

describe('downmix', () => {
  it('averages the channels into one', () => {
    expect([...downmix([Float32Array.of(1, 0.5, -1), Float32Array.of(0, 0.5, 1)])]).toEqual([0.5, 0.5, 0]);
  });

  it('passes a single channel through', () => {
    const x = Float32Array.of(0.1, 0.2);
    expect(downmix([x])).toBe(x);
  });
});

describe('hasSound', () => {
  it('is false for digital silence and for a faint hiss', () => {
    expect(hasSound(new Float32Array(32_000), 16_000)).toBe(false);
    const hiss = Float32Array.from({ length: 32_000 }, (_, i) => (i % 2 ? 1 : -1) * 0.0005);
    expect(hasSound(hiss, 16_000)).toBe(false);
  });

  it('is true for speech-level sound, even a short burst in a long silence', () => {
    expect(hasSound(sine(220, 16_000, 2, 0.1), 16_000)).toBe(true);
    const x = new Float32Array(16_000 * 10);
    x.set(sine(220, 16_000, 0.2, 0.1), 16_000 * 5);
    expect(hasSound(x, 16_000)).toBe(true);
  });
});
