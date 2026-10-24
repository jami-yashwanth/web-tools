import { describe, expect, it } from 'vitest';
import { checkLimits, encoderCodecs, MAX_BYTES, MAX_SECONDS, outputSize, targetBitrate } from '../../src/video/limits';

describe('Compress video: limits', () => {
  it('takes videos up to 2 minutes, and no longer', () => {
    expect(MAX_SECONDS).toBe(120);
    expect(checkLimits({ durationS: 3, bytes: 1_000_000 }, 'compress')).toBe('ok');
    expect(checkLimits({ durationS: 120, bytes: 1_000_000 }, 'compress')).toBe('ok');
    expect(checkLimits({ durationS: 120.1, bytes: 1_000_000 }, 'compress')).toBe('too-long');
  });

  it('takes files up to 200 MB, and no larger', () => {
    expect(MAX_BYTES).toBe(200_000_000);
    expect(checkLimits({ durationS: 3, bytes: 200_000_000 }, 'compress')).toBe('ok');
    expect(checkLimits({ durationS: 3, bytes: 200_000_001 }, 'compress')).toBe('too-large');
  });

  it('says too large before too long (the size is known before the file is read)', () => {
    expect(checkLimits({ durationS: 600, bytes: 300_000_000 }, 'compress')).toBe('too-large');
  });
});

describe('Video to GIF: limits', () => {
  it('has no length cap (it decodes only its span), and the same 200 MB cap', () => {
    expect(checkLimits({ durationS: 130, bytes: 1_000_000 }, 'gif')).toBe('ok');
    expect(checkLimits({ durationS: 3 * 3600, bytes: 200_000_000 }, 'gif')).toBe('ok');
    expect(checkLimits({ durationS: 3, bytes: 200_000_001 }, 'gif')).toBe('too-large');
  });
});

describe('Compress video: bitrate presets', () => {
  it('Smaller file < Balanced < Better quality, at every size', () => {
    for (const [w, h] of [
      [320, 180],
      [640, 360],
      [1280, 720],
      [1920, 1080],
      [3840, 2160],
    ] as const) {
      const small = targetBitrate('small', w, h);
      const balanced = targetBitrate('balanced', w, h);
      const better = targetBitrate('better', w, h);
      expect(small).toBeLessThan(balanced);
      expect(balanced).toBeLessThan(better);
    }
  });

  it('grows with the picture, and stays within sensible bounds', () => {
    expect(targetBitrate('balanced', 1280, 720)).toBeGreaterThan(targetBitrate('balanced', 640, 360));
    expect(targetBitrate('balanced', 1920, 1080)).toBeGreaterThan(targetBitrate('balanced', 1280, 720));
    expect(targetBitrate('small', 16, 16)).toBeGreaterThanOrEqual(100_000);
    expect(Number.isInteger(targetBitrate('better', 1921, 1081))).toBe(true);
  });
});

describe('Compress video: output size', () => {
  it('keeps the original size (made even) at Original', () => {
    expect(outputSize(640, 360, null)).toEqual({ width: 640, height: 360 });
    expect(outputSize(641, 361, null)).toEqual({ width: 640, height: 360 });
  });

  it('720p and 1080p limit the short side, as the names mean: 1920 x 1080 at 720p is 1280 x 720', () => {
    expect(outputSize(1920, 1080, 720)).toEqual({ width: 1280, height: 720 });
    expect(outputSize(3840, 2160, 1080)).toEqual({ width: 1920, height: 1080 });
  });

  it('a portrait video too: 1080 x 1920 at 720p is 720 x 1280', () => {
    expect(outputSize(1080, 1920, 720)).toEqual({ width: 720, height: 1280 });
  });

  it('keeps the aspect ratio, with even sides', () => {
    const { width, height } = outputSize(1000, 750, 720);
    expect(height).toBe(720);
    expect(width % 2).toBe(0);
    expect(Math.abs(width / height - 1000 / 750)).toBeLessThan(0.01);
  });

  it('never scales up', () => {
    expect(outputSize(640, 360, 1080)).toEqual({ width: 640, height: 360 });
    expect(outputSize(1280, 720, 720)).toEqual({ width: 1280, height: 720 });
  });
});

describe('Compress video: H.264 codecs to try', () => {
  it('High, then Main, then Baseline: avc1.640028, avc1.4d401f, avc1.42001f up to 720p at 30 fps', () => {
    expect(encoderCodecs(640, 360, 30)).toEqual(['avc1.640028', 'avc1.4d401f', 'avc1.42001f']);
    expect(encoderCodecs(1280, 720, 30)).toEqual(['avc1.640028', 'avc1.4d401f', 'avc1.42001f']);
  });

  it('a level high enough for the picture and frame rate (1080p, 1080p60, 4K)', () => {
    expect(encoderCodecs(1920, 1080, 30)).toEqual(['avc1.640028', 'avc1.4d4028', 'avc1.420028']);
    expect(encoderCodecs(1920, 1080, 60)).toEqual(['avc1.64002a', 'avc1.4d402a', 'avc1.42002a']);
    expect(encoderCodecs(3840, 2160, 30)).toEqual(['avc1.640033', 'avc1.4d4033', 'avc1.420033']);
  });
});
