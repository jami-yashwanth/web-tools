import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The setup notes a person follows by hand: the parts that are easy to get wrong.

describe('README: model hosting', () => {
  const readme = readFileSync('README.md', 'utf8');

  it('PUBLIC_MODEL_BASE_URL must be an absolute https URL', () => {
    expect(readme).toMatch(/`PUBLIC_MODEL_BASE_URL`[^.]*absolute `https:\/\/` URL/);
  });

  it('the R2 CORS rule exposes Content-Encoding (the loader reads it)', () => {
    expect(readme).toMatch(/ExposeHeaders[^\n]*Content-Encoding/);
  });

  it('says test:models runs Whisper on WebAssembly, so WebGPU needs a manual headed check', () => {
    expect(readme).toMatch(/test:models[^\n]*WebAssembly[^\n]*WebGPU[^\n]*headed/);
  });
});

describe('round 3 spec: amendments', () => {
  const spec = readFileSync('docs/superpowers/specs/2026-10-24-tools-round-3-design.md', 'utf8');
  const amendments = spec.slice(spec.indexOf('## Amendments (rulings during implementation)'));

  it('ends with the amendments section', () => {
    expect(spec).toContain('## Amendments (rulings during implementation)');
    expect(amendments.indexOf('\n## ', 1)).toBe(-1); // nothing after it
  });

  it('lists each ruling', () => {
    for (const s of ['u2netp', 'tessdata', 'WebGPU off', 'q4f16', 'WebM rejected', '300 MB', 'Repetition guard', 'non-AAC', 'APP1', 'no source-duration cap']) {
      expect(amendments, s).toContain(s);
    }
  });

  it('lists the new microcopy, as the pages say it', () => {
    const src = ['src/ui/ai.ts', 'src/ui/transcribe.ts', 'src/ui/upscale.ts', 'src/ui/video.ts', 'src/ui/video-shell.ts', 'src/ui/video-gif.ts', 'src/ui/pdf-images.ts']
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    for (const s of [
      'Choose another file',
      'Files up to 300 MB for now. Try a shorter recording.',
      'Reading audio…',
      'This can take a few minutes on this device.',
      "Very large pages were drawn at a lower resolution to fit your device's memory.",
      "This video's sound couldn't be kept.",
      'This video was already well compressed.',
      "Couldn't load the video tools. Check your connection.",
      "This browser can't play this video's format. Try Chrome, Edge or Safari.",
      "Your browser can't read video. Try Chrome, Edge, Safari 17+ or Firefox 130+.",
      'End must be after start and within the video.',
      'Large GIF. Try 320 px or a shorter clip for a smaller file.',
      'Videos up to 200 MB for now.',
    ]) {
      expect(amendments, s).toContain(s);
      expect(src, s).toContain(s);
    }
  });
});
