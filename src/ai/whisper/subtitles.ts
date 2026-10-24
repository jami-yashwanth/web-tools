// Transcribe audio's downloads, from the transcript's segments: plain text, SRT and WebVTT captions. Pure.

export interface Segment {
  /** Seconds from the start of the audio. */
  start: number;
  end: number;
  text: string;
}

/** One line, single spaces, no padding. */
const clean = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** "01:02:03" + sep + "456": hours always shown, milliseconds rounded. */
function stamp(seconds: number, sep: ',' | '.'): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor(ms / 60_000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`;
}

/** The segments that have words, each with its text on one line. */
const cues = (segs: Segment[]) => segs.map((s) => ({ ...s, text: clean(s.text) })).filter((s) => s.text);

/** SubRip: numbered cues, "00:00:00,000 --> 00:00:02,500". */
export function toSrt(segs: Segment[]): string {
  return cues(segs)
    .map((c, i) => `${i + 1}\n${stamp(c.start, ',')} --> ${stamp(c.end, ',')}\n${c.text}\n\n`)
    .join('');
}

/** WebVTT: a header, then "00:00:00.000 --> 00:00:02.500" cues. Cue text is markup there, so & < > are escaped. */
export function toVtt(segs: Segment[]): string {
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `WEBVTT\n\n${cues(segs)
    .map((c) => `${stamp(c.start, '.')} --> ${stamp(c.end, '.')}\n${esc(c.text)}\n\n`)
    .join('')}`;
}

/** The words alone: the segments joined with spaces. */
export function toTxt(segs: Segment[]): string {
  return cues(segs)
    .map((c) => c.text)
    .join(' ');
}
