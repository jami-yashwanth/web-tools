import { describe, expect, it } from 'vitest';
import { getTool } from '../../src/tools';
import { offers4x } from '../../src/ui/upscale';

describe('Upscale image: when 4× is offered', () => {
  it('on a computer with 8 GB or more, or one that does not say (Firefox, Safari)', () => {
    expect(offers4x({ mobile: false, deviceMemoryGB: 8 })).toBe(true);
    expect(offers4x({ mobile: false, deviceMemoryGB: 16 })).toBe(true);
    expect(offers4x({ mobile: false })).toBe(true);
  });

  it('not on a phone, nor with less than 8 GB', () => {
    expect(offers4x({ mobile: true, deviceMemoryGB: 8 })).toBe(false);
    expect(offers4x({ mobile: true })).toBe(false);
    expect(offers4x({ mobile: false, deviceMemoryGB: 4 })).toBe(false);
  });

  it('the page says so: up to 4x, and 2× whenever the tool can run (no WebGPU condition)', () => {
    const t = getTool('upscale-image');
    expect(t.description).toContain('up to 4x');
    const faq = t.faq.find((f) => f.q === 'Why is 4× not offered on my device?')!.a;
    expect(faq).toContain('8 GB');
    expect(faq).toContain('phones');
    expect(faq).toContain('2× is offered whenever the tool can run.');
    expect(faq).not.toMatch(/WebGPU|graphics/);
  });
});
