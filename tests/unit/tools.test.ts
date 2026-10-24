import { describe, it, expect } from 'vitest';
import { TOOLS, CATEGORY_LABEL, getTool, getImageTool, toolForType } from '../../src/tools';

describe('tool registry', () => {
  it('JSON formatter FAQ is honest about what formatting rewrites', () => {
    const a = getTool('json-formatter').faq.find((f) => f.q === 'Does it change my data?')!.a;
    expect(a).not.toMatch(/only changes whitespace/);
    for (const s of ['1.0 becomes 1', 'duplicate keys', 'numeric keys', 'escapes']) expect(a).toContain(s);
  });

  it('QR copy does not claim the visit is untracked', () => {
    const t = getTool('qr-code-generator');
    expect(t.title).toBe('QR Code Generator - Free, Static, No Sign-up');
    expect(t.subhead).toBe('Turn text or a link into a QR code. Made on your device, and the code itself has no tracking.');
    expect(t.description).toMatch(/Nothing is uploaded, the code has no tracking, and it never expires\.$/);
    expect(`${t.title} ${t.description} ${t.subhead}`).not.toMatch(/nothing is tracked|Private, No Tracking/i);
  });

  it('has exactly the 17 unique slugs', () => {
    const slugs = TOOLS.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect([...slugs].sort()).toEqual(
      [
        'base64-encode-decode',
        'compress-image',
        'heic-to-jpg',
        'json-formatter',
        'jwt-decoder',
        'merge-pdf',
        'qr-code-generator',
        'split-pdf',
        'webp-to-jpg',
        'remove-background',
        'image-to-text',
        'upscale-image',
        'transcribe-audio',
        'pdf-to-jpg',
        'jpg-to-pdf',
        'compress-video',
        'video-to-gif',
      ].sort(),
    );
  });

  it('uses the spec H1s', () => {
    const h1 = (s: Parameters<typeof getTool>[0]) => getTool(s).h1;
    expect(h1('merge-pdf')).toBe('Merge PDF');
    expect(h1('split-pdf')).toBe('Split PDF');
    expect(h1('json-formatter')).toBe('JSON formatter');
    expect(h1('base64-encode-decode')).toBe('Base64 encode and decode');
    expect(h1('jwt-decoder')).toBe('JWT decoder');
    expect(h1('qr-code-generator')).toBe('QR code generator');
    expect(h1('remove-background')).toBe('Remove background');
    expect(h1('image-to-text')).toBe('Image to text');
    expect(h1('upscale-image')).toBe('Upscale image');
    expect(h1('transcribe-audio')).toBe('Transcribe audio');
    expect(h1('pdf-to-jpg')).toBe('PDF to JPG');
    expect(h1('jpg-to-pdf')).toBe('JPG to PDF');
    expect(h1('compress-video')).toBe('Compress video');
    expect(h1('video-to-gif')).toBe('Video to GIF');
  });

  it('has the kind, model, op and category of every round 3 tool', () => {
    const ai = (s: Parameters<typeof getTool>[0]) => {
      const t = getTool(s);
      return t.kind === 'ai' ? t.model : undefined;
    };
    expect(ai('remove-background')).toBe('bg');
    expect(ai('image-to-text')).toBe('ocr');
    expect(ai('upscale-image')).toBe('upscale');
    expect(ai('transcribe-audio')).toBe('whisper');
    const op = (s: Parameters<typeof getTool>[0]) => {
      const t = getTool(s);
      return t.kind === 'pdf' || t.kind === 'video' ? `${t.kind}:${t.op}` : undefined;
    };
    expect(op('pdf-to-jpg')).toBe('pdf:to-images');
    expect(op('jpg-to-pdf')).toBe('pdf:from-images');
    expect(op('compress-video')).toBe('video:compress');
    expect(op('video-to-gif')).toBe('video:gif');
    const cat = (s: Parameters<typeof getTool>[0]) => getTool(s).category;
    for (const s of ['remove-background', 'image-to-text', 'upscale-image', 'transcribe-audio'] as const) expect(cat(s)).toBe('ai');
    for (const s of ['pdf-to-jpg', 'jpg-to-pdf'] as const) expect(cat(s)).toBe('pdf');
    for (const s of ['compress-video', 'video-to-gif'] as const) expect(cat(s)).toBe('video');
  });

  it('Transcribe FAQ states both limits: 30 minutes and 300 MB', () => {
    const a = getTool('transcribe-audio').faq.find((f) => f.q === 'How long can the audio be?')!.a;
    expect(a).toContain('30 minutes');
    expect(a).toContain('300 MB');
  });

  it('Video to GIF FAQ names no limit on the video’s length (only the GIF’s 15 seconds)', () => {
    const faq = getTool('video-to-gif').faq.map((f) => f.a).join(' ');
    expect(faq).not.toMatch(/2 minutes|minute/);
  });

  it('every AI tool FAQ states the first-use download and that it is cached', () => {
    const sizes = { bg: '5 MB', ocr: '4 MB', upscale: '5 MB', whisper: '80 MB' };
    for (const t of TOOLS) {
      if (t.kind !== 'ai') continue;
      const faq = t.faq.map((f) => f.a).join(' ');
      expect(faq, t.slug).toContain(`about ${sizes[t.model]}`);
      expect(faq, t.slug).toMatch(/cached/);
      expect(`${t.title} ${t.description} ${t.subhead} ${faq}`, t.slug).not.toMatch(/unlimited|any language|all languages/i);
    }
  });

  it('has the kind, op/transform and category of every new tool', () => {
    const m = getTool('merge-pdf');
    const s = getTool('split-pdf');
    expect(m.kind === 'pdf' && m.op).toBe('merge');
    expect(s.kind === 'pdf' && s.op).toBe('split');
    const j = getTool('json-formatter');
    const b = getTool('base64-encode-decode');
    const w = getTool('jwt-decoder');
    expect(j.kind === 'text' && j.transform).toBe('json');
    expect(b.kind === 'text' && b.transform).toBe('base64');
    expect(w.kind === 'text' && w.transform).toBe('jwt');
    expect(getTool('qr-code-generator').kind).toBe('qr');
    for (const t of TOOLS) {
      const expected = { image: 'image', pdf: 'pdf', ai: 'ai', video: 'video', text: 'developer', qr: 'qr' }[t.kind];
      expect(t.category).toBe(expected);
    }
    expect(CATEGORY_LABEL).toEqual({
      image: 'Image',
      pdf: 'PDF',
      ai: 'AI',
      video: 'Video',
      developer: 'Developer',
      qr: 'QR code',
    });
  });

  it('getImageTool returns image tools and getTool throws on unknown slugs', () => {
    expect(getImageTool('heic-to-jpg').kind).toBe('image');
    expect(() => getTool('nope' as never)).toThrow('Unknown tool');
  });

  it('related slugs exist and are not the tool itself', () => {
    for (const t of TOOLS) {
      for (const r of t.related) {
        expect(r).not.toBe(t.slug);
        expect(TOOLS.some((x) => x.slug === r)).toBe(true);
      }
    }
  });

  it('has 4-5 FAQ entries and 3 how-to steps per tool', () => {
    for (const t of TOOLS) {
      expect(t.faq.length).toBeGreaterThanOrEqual(4);
      expect(t.faq.length).toBeLessThanOrEqual(5);
      expect(t.howTo).toHaveLength(3);
    }
  });

  it('keeps title <= 60 chars and description 120-160 chars', () => {
    for (const t of TOOLS) {
      expect(t.title.length).toBeLessThanOrEqual(60);
      expect(t.description.length).toBeGreaterThanOrEqual(120);
      expect(t.description.length).toBeLessThanOrEqual(160);
    }
  });

  it('has the specified defaults and accept attribute', () => {
    expect(getImageTool('heic-to-jpg').defaults.quality).toBe(85);
    expect(getImageTool('compress-image').defaults.quality).toBe(75);
    expect(getImageTool('webp-to-jpg').defaults.format).toBe('jpg');
    expect(getImageTool('heic-to-jpg').acceptAttr).toBe('.heic,.heif,image/heic,image/heif');
  });

  it('maps input types to tools', () => {
    expect(toolForType('png')).toBe('compress-image');
    expect(toolForType('jpg')).toBe('compress-image');
    expect(toolForType('heic')).toBe('heic-to-jpg');
    expect(toolForType('webp')).toBe('webp-to-jpg');
  });
});
