// Compress video: the pure rules. What the tool takes, what bitrate each quality preset asks of the encoder, and the
// size of the compressed picture.

/**
 * Compress video takes videos up to 2 minutes and 200 MB for now (spec §3): longer clips are slow, and could run a
 * device out of memory. Video to GIF has only the 200 MB cap: it decodes no more than its ≤ 15 s span.
 */
export const MAX_SECONDS = 120;
export const MAX_BYTES = 200_000_000;

/** The video tools: each op's limits. */
export type VideoOp = 'compress' | 'gif';

export type Preset = 'small' | 'balanced' | 'better';
/** Original, or a short side of at most 1080 or 720 pixels ("1080p", "720p"). */
export type Resolution = null | 1080 | 720;

/**
 * Set as `detectedType` on an `unsupported` failure when the file reads fine but this browser can't decode its picture
 * (HEVC in Firefox, say): a matter of the browser, not of the format. (Here, not in demux.ts, so the page needn't load
 * mp4box to know it.)
 */
export const UNDECODABLE = 'codec';

/**
 * The size is known before the file is read, so a file too large is said to be that, whatever its length. Only
 * Compress caps the length.
 */
export function checkLimits(meta: { durationS: number; bytes: number }, op: VideoOp): 'ok' | 'too-long' | 'too-large' {
  if (meta.bytes > MAX_BYTES) return 'too-large';
  if (op === 'compress' && meta.durationS > MAX_SECONDS) return 'too-long';
  return 'ok';
}

/** Bits per pixel per frame, at 30 fps: about 2.2 Mbit/s for 720p and 5 Mbit/s for 1080p at Balanced. */
const BITS_PER_PIXEL: Record<Preset, number> = { small: 0.05, balanced: 0.08, better: 0.12 };
const FPS = 30;
/** Below this even a tiny picture looks broken. */
const MIN_BITRATE = 100_000;

/** The bitrate (bits per second) asked of the H.264 encoder. */
export function targetBitrate(preset: Preset, w: number, h: number): number {
  return Math.max(MIN_BITRATE, Math.round(w * h * FPS * BITS_PER_PIXEL[preset]));
}

const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);

/**
 * The compressed picture's size. 720p and 1080p limit the short side (a 1920 × 1080 video at 720p is 1280 × 720,
 * a portrait 1080 × 1920 one 720 × 1280), keeping the aspect ratio. Never larger than the video. H.264 needs even sides.
 */
export function outputSize(width: number, height: number, resolution: Resolution): { width: number; height: number } {
  const short = Math.min(width, height);
  const scale = resolution && short > resolution ? resolution / short : 1;
  return { width: even(Math.round(width * scale)), height: even(Math.round(height * scale)) };
}

/** H.264 levels as [level_idc, max frame size in macroblocks, max macroblocks per second] (ITU-T H.264 Table A-1). */
const LEVELS: [number, number, number][] = [
  [0x1f, 3600, 108_000], // 3.1
  [0x20, 5120, 216_000], // 3.2
  [0x28, 8192, 245_760], // 4.0
  [0x2a, 8704, 522_240], // 4.2
  [0x32, 22_080, 589_824], // 5.0
  [0x33, 36_864, 983_040], // 5.1
  [0x34, 36_864, 2_073_600], // 5.2
];

/** The lowest level that holds this picture at this frame rate. */
function avcLevel(w: number, h: number, fps: number): number {
  const frame = Math.ceil(w / 16) * Math.ceil(h / 16);
  return (LEVELS.find(([, fs, mbps]) => frame <= fs && frame * fps <= mbps) ?? LEVELS.at(-1)!)[0];
}

const hex = (n: number) => n.toString(16).padStart(2, '0');

/**
 * The H.264 codec strings to offer the encoder, best first: High (4.0), then Main (3.1), then Baseline (3.1), each
 * raised to the level this picture and frame rate need.
 */
export function encoderCodecs(w: number, h: number, fps: number): string[] {
  const level = avcLevel(w, h, fps);
  return [`avc1.6400${hex(Math.max(0x28, level))}`, `avc1.4d40${hex(Math.max(0x1f, level))}`, `avc1.4200${hex(Math.max(0x1f, level))}`];
}
