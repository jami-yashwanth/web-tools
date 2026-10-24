import { describe, expect, it } from 'vitest';
import { toSrt, toTxt, toVtt, type Segment } from '../../src/ai/whisper/subtitles';

const SEGS: Segment[] = [
  { start: 0, end: 2.5, text: ' Hello' },
  { start: 2.5, end: 4.0004, text: 'world. ' },
];

describe('toSrt', () => {
  it('numbers each cue, with comma milliseconds and a blank line after each', () => {
    expect(toSrt([SEGS[0]!])).toBe('1\n00:00:00,000 --> 00:00:02,500\nHello\n\n');
    expect(toSrt(SEGS)).toBe('1\n00:00:00,000 --> 00:00:02,500\nHello\n\n2\n00:00:02,500 --> 00:00:04,000\nworld.\n\n');
  });

  it('writes hours past the first, and rounds to the nearest millisecond', () => {
    expect(toSrt([{ start: 3723.4566, end: 3725.0005, text: 'Later' }])).toBe('1\n01:02:03,457 --> 01:02:05,001\nLater\n\n');
    expect(toSrt([{ start: 59.9996, end: 61, text: 'Carry' }])).toBe('1\n00:01:00,000 --> 00:01:01,000\nCarry\n\n');
  });

  it('puts each cue on one line and skips cues with no words, numbering on', () => {
    const segs = [
      { start: 0, end: 1, text: 'One\n  two' },
      { start: 1, end: 2, text: '   ' },
      { start: 2, end: 3, text: 'Three' },
    ];
    expect(toSrt(segs)).toBe('1\n00:00:00,000 --> 00:00:01,000\nOne two\n\n2\n00:00:02,000 --> 00:00:03,000\nThree\n\n');
  });

  it('is empty for no segments', () => {
    expect(toSrt([])).toBe('');
  });
});

describe('toVtt', () => {
  it('starts with WEBVTT and uses dot milliseconds, without cue numbers', () => {
    expect(toVtt([SEGS[0]!])).toBe('WEBVTT\n\n00:00:00.000 --> 00:00:02.500\nHello\n\n');
    expect(toVtt(SEGS)).toBe('WEBVTT\n\n00:00:00.000 --> 00:00:02.500\nHello\n\n00:00:02.500 --> 00:00:04.000\nworld.\n\n');
  });

  it('writes hours past the first', () => {
    expect(toVtt([{ start: 7200, end: 7201.25, text: 'Two hours' }])).toBe('WEBVTT\n\n02:00:00.000 --> 02:00:01.250\nTwo hours\n\n');
  });

  it('escapes the characters a cue would read as markup', () => {
    expect(toVtt([{ start: 0, end: 1, text: 'Tom & <Jerry>' }])).toBe('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nTom &amp; &lt;Jerry&gt;\n\n');
  });

  it('is only the header for no segments', () => {
    expect(toVtt([])).toBe('WEBVTT\n\n');
  });
});

describe('toTxt', () => {
  it('joins the segments with spaces and normalises whitespace', () => {
    expect(toTxt(SEGS)).toBe('Hello world.');
    expect(toTxt([{ start: 0, end: 1, text: '  One\n\ttwo ' }, { start: 1, end: 2, text: '' }, { start: 2, end: 3, text: 'three  ' }])).toBe(
      'One two three',
    );
  });

  it('is empty for no segments', () => {
    expect(toTxt([])).toBe('');
  });
});
