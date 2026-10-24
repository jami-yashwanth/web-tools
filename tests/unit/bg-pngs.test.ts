import { describe, expect, it } from 'vitest';
import { BackgroundPngs } from '../../src/ui/bg';

const make = () => {
  const revoked: string[] = [];
  return { pngs: new BackgroundPngs((u) => revoked.push(u)), revoked };
};

describe('BackgroundPngs (the PNGs kept for download)', () => {
  it('keeps transparent, white and one colour', () => {
    const { pngs, revoked } = make();
    pngs.set('transparent', 'blob:t');
    pngs.set('white', 'blob:w');
    pngs.choose('#ff0000');
    expect(pngs.set('#ff0000', 'blob:red')).toBe(true);
    expect([pngs.get('transparent'), pngs.get('white'), pngs.get('#ff0000')]).toEqual(['blob:t', 'blob:w', 'blob:red']);
    expect(revoked).toEqual([]);
  });

  it('a new colour replaces the last one and revokes its URL', () => {
    const { pngs, revoked } = make();
    pngs.choose('#ff0000');
    pngs.set('#ff0000', 'blob:red');
    pngs.choose('#00ff00');
    pngs.set('#00ff00', 'blob:green');
    expect(pngs.get('#ff0000')).toBeUndefined();
    expect(pngs.get('#00ff00')).toBe('blob:green');
    expect(revoked).toEqual(['blob:red']);
  });

  it('many colours in a row never keep more than one colour PNG', () => {
    const { pngs, revoked } = make();
    for (let i = 0; i < 50; i++) {
      const hex = `#0000${i.toString(16).padStart(2, '0')}`;
      pngs.choose(hex);
      pngs.set(hex, `blob:${i}`);
    }
    expect(revoked).toHaveLength(49);
  });

  it('a PNG that arrives for a colour no longer chosen is revoked at once, not kept', () => {
    const { pngs, revoked } = make();
    pngs.choose('#ff0000');
    pngs.choose('#0000ff'); // picked another before red's PNG came back
    expect(pngs.set('#ff0000', 'blob:late')).toBe(false);
    expect(pngs.get('#ff0000')).toBeUndefined();
    expect(revoked).toEqual(['blob:late']);
  });

  it('choosing white keeps the colour PNG for when Colour is chosen again', () => {
    const { pngs } = make();
    pngs.choose('#ff0000');
    pngs.set('#ff0000', 'blob:red');
    pngs.choose('white');
    expect(pngs.get('#ff0000')).toBe('blob:red');
  });

  it('clear revokes every URL it holds', () => {
    const { pngs, revoked } = make();
    pngs.set('transparent', 'blob:t');
    pngs.set('white', 'blob:w');
    pngs.choose('#ff0000');
    pngs.set('#ff0000', 'blob:red');
    pngs.clear();
    expect(revoked.sort()).toEqual(['blob:red', 'blob:t', 'blob:w']);
    expect(pngs.get('transparent')).toBeUndefined();
  });
});
