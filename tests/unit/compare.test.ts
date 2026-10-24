import { describe, expect, it } from 'vitest';
import { positionFromPointer, stepPosition } from '../../src/ui/compare';

describe('stepPosition (the slider keys)', () => {
  it('ArrowLeft and ArrowRight move the divider by 5 points', () => {
    expect(stepPosition(50, 'ArrowLeft')).toBe(45);
    expect(stepPosition(50, 'ArrowRight')).toBe(55);
  });
  it('ArrowDown and ArrowUp do the same, as for any slider', () => {
    expect(stepPosition(50, 'ArrowDown')).toBe(45);
    expect(stepPosition(50, 'ArrowUp')).toBe(55);
  });
  it('PageDown and PageUp move by 20, Home and End go to the ends', () => {
    expect(stepPosition(50, 'PageDown')).toBe(30);
    expect(stepPosition(50, 'PageUp')).toBe(70);
    expect(stepPosition(50, 'Home')).toBe(0);
    expect(stepPosition(50, 'End')).toBe(100);
  });
  it('stays within 0 to 100', () => {
    expect(stepPosition(2, 'ArrowLeft')).toBe(0);
    expect(stepPosition(98, 'ArrowRight')).toBe(100);
    expect(stepPosition(90, 'PageUp')).toBe(100);
  });
  it('other keys are not the slider’s (null: let them through)', () => {
    expect(stepPosition(50, 'Tab')).toBeNull();
    expect(stepPosition(50, 'a')).toBeNull();
  });
});

describe('positionFromPointer', () => {
  it('maps a pointer x within the image to 0 to 100, clamped', () => {
    const box = { left: 100, width: 400 };
    expect(positionFromPointer(300, box)).toBe(50);
    expect(positionFromPointer(100, box)).toBe(0);
    expect(positionFromPointer(50, box)).toBe(0);
    expect(positionFromPointer(900, box)).toBe(100);
    expect(positionFromPointer(201, box)).toBe(25);
  });
  it('a box with no width gives the middle', () => {
    expect(positionFromPointer(10, { left: 0, width: 0 })).toBe(50);
  });
});
