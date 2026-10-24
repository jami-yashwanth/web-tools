import { createFile, DataStream, Endianness, Log, type ISOFile, type Movie, type Track } from 'mp4box';
import { AiError } from '../ai/errors';
import { sniff } from '../engine/sniff';
import { UNDECODABLE } from './limits';

// Reads an MP4 or MOV with mp4box.js: its tracks, and where each sample lies in the file. Only the boxes are read
// (mp4box skips the media data); the samples are read from the File one at a time as they are decoded, so a
// 200 MB video is never held in memory whole.

/** One sample (a video frame or a run of audio): where it lies in the file, and when it plays (µs). */
export interface SampleRef {
  offset: number;
  size: number;
  timestamp: number;
  duration: number;
  key: boolean;
}

export interface VideoTrack {
  /** The codec string for VideoDecoder (avc1.64001e, hvc1.1.6.L93.B0…). */
  codec: string;
  width: number;
  height: number;
  /** The decoder configuration record (avcC, hvcC, vpcC or av1C), without its box header. */
  description?: Uint8Array;
  /** Clockwise, from the track's matrix (phones record portrait video as landscape, turned). */
  rotation: 0 | 90 | 180 | 270;
  frameRate: number;
  samples: SampleRef[];
}

export interface AudioTrack {
  /** mp4a.40.2 for AAC-LC; Opus, ac-3… for others. */
  codec: string;
  sampleRate: number;
  channels: number;
  /** For AAC: the AudioSpecificConfig from its esds box. */
  description?: Uint8Array;
  samples: SampleRef[];
}

export interface Demuxed {
  durationS: number;
  video: VideoTrack;
  audio?: AudioTrack;
}

/** How much of the file is handed to mp4box at a time while it looks for the boxes. */
const CHUNK = 1 << 20;

/** Is this AAC (MPEG-4 audio object types 2, 5, 29: LC, HE, HE v2), which an MP4 can carry as it is? */
export const isAac = (codec: string): boolean => /^mp4a\.40\.(2|5|29)$/.test(codec);

/** Image and document types someone may drop here by mistake: said to be what they are. */
const WRONG_TYPES = new Set(['jpg', 'png', 'webp', 'heic']);

/** Read a file's tracks. Rejects with AiError: wrong-type, unsupported (WebM, no video), corrupt. */
export async function demux(file: Blob): Promise<Demuxed> {
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  // WebM and Matroska start with an EBML header: not read this round (spec ruling, Task 8).
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) throw new AiError('unsupported', { detectedType: 'webm' });
  const isPdf = String.fromCharCode(...head.subarray(0, 5)) === '%PDF-';
  if (isPdf) throw new AiError('wrong-type', { detectedType: 'pdf' });
  const { type } = await sniff(file);
  if (WRONG_TYPES.has(type)) throw new AiError('wrong-type', { detectedType: type });

  Log.setLogLevel(Log.error);
  const mp4 = createFile(false); // keep no media data: only the boxes
  let info: Movie | undefined;
  let failed = false;
  mp4.onReady = (i) => (info = i);
  mp4.onError = () => (failed = true);
  // Hand mp4box the file in chunks, from wherever it asks for next (past the media data), until it has read every
  // box. A fragmented MP4's samples are listed in boxes throughout the file, so it reads them all.
  let pos = 0;
  while (pos < file.size && !failed) {
    const end = Math.min(file.size, pos + CHUNK);
    const buf = (await file.slice(pos, end).arrayBuffer()) as ArrayBuffer & { fileStart: number };
    buf.fileStart = pos;
    const next = mp4.appendBuffer(buf, end === file.size);
    pos = next > pos ? next : end;
  }
  mp4.flush();
  if (!info || failed) throw new AiError('corrupt');

  const v = info.videoTracks[0];
  if (!v) throw new AiError('unsupported', { detectedType: 'no-video' });
  const video = videoTrack(mp4, v);
  const a = info.audioTracks[0];
  const audio = a ? audioTrack(mp4, a) : undefined;
  // A file cut short still lists every sample, at offsets past its end.
  for (const s of [...video.samples, ...(audio?.samples ?? [])]) if (s.offset + s.size > file.size) throw new AiError('corrupt');
  if (!video.samples.length) throw new AiError('corrupt');

  const last = video.samples.at(-1)!;
  const fromSamples = (last.timestamp + last.duration - video.samples[0]!.timestamp) / 1e6;
  const durationS = Math.max(info.timescale ? info.duration / info.timescale : 0, fromSamples);
  return { durationS, video, ...(audio ? { audio } : {}) };
}

type Mp4 = ISOFile<unknown, unknown>;
/** mp4box's sample entry, loosely: the boxes it may hold. */
type Entry = Record<string, unknown> & { type: string };

function samplesOf(mp4: Mp4, track: Track): SampleRef[] {
  const trak = mp4.getTrackById(track.id);
  return (trak.samples ?? []).map((s) => ({
    offset: s.offset,
    size: s.size,
    timestamp: Math.round((s.cts * 1e6) / s.timescale),
    duration: Math.round((s.duration * 1e6) / s.timescale),
    key: s.is_sync,
  }));
}

function entryOf(mp4: Mp4, track: Track): Entry | undefined {
  return mp4.getTrackById(track.id).mdia?.minf?.stbl?.stsd?.entries?.[0] as unknown as Entry | undefined;
}

/** A box written out by mp4box, less its 8-byte header. */
function boxBody(box: { write(stream: DataStream): void }): Uint8Array {
  const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
  box.write(stream);
  return new Uint8Array(stream.buffer, 8);
}

function videoTrack(mp4: Mp4, track: Track): VideoTrack {
  const entry = entryOf(mp4, track);
  const config = entry && (['avcC', 'hvcC', 'vpcC', 'av1C'] as const).map((k) => entry[k]).find(Boolean);
  const samples = samplesOf(mp4, track);
  const seconds = track.samples_duration && track.timescale ? track.samples_duration / track.timescale : 0;
  return {
    codec: track.codec,
    width: track.video?.width ?? track.track_width,
    height: track.video?.height ?? track.track_height,
    ...(config ? { description: boxBody(config as { write(s: DataStream): void }) } : {}),
    rotation: rotationOf(track.matrix as unknown as ArrayLike<number>),
    frameRate: seconds > 0 ? samples.length / seconds : 30,
    samples,
  };
}

/** The rotation in a track matrix [a b u; c d v; x y w], to the nearest quarter turn. */
export function rotationOf(m: ArrayLike<number> | undefined): 0 | 90 | 180 | 270 {
  if (!m || m.length < 4) return 0;
  const deg = Math.round((Math.atan2(m[1]! | 0, m[0]! | 0) * 180) / Math.PI / 90) * 90;
  return (((deg % 360) + 360) % 360) as 0 | 90 | 180 | 270;
}

function audioTrack(mp4: Mp4, track: Track): AudioTrack {
  const entry = entryOf(mp4, track);
  // esds → ES descriptor → DecoderConfigDescriptor → DecoderSpecificInfo: the AudioSpecificConfig.
  const esds = entry?.esds as { esd?: { descs?: { descs?: { data?: Uint8Array }[] }[] } } | undefined;
  const asc = esds?.esd?.descs?.[0]?.descs?.[0]?.data;
  return {
    codec: track.codec,
    sampleRate: track.audio?.sample_rate ?? 0,
    channels: track.audio?.channel_count ?? 0,
    ...(asc ? { description: new Uint8Array(asc) } : {}),
    samples: samplesOf(mp4, track),
  };
}


/** The VideoDecoder configuration for a track. */
export function decoderConfig(video: VideoTrack): VideoDecoderConfig {
  return {
    codec: video.codec,
    codedWidth: video.width,
    codedHeight: video.height,
    ...(video.description ? { description: video.description } : {}),
  };
}

/**
 * Check this browser decodes the track's picture, and give its decoder configuration. Rejects with AiError: device
 * (no WebCodecs at all), unsupported with detectedType UNDECODABLE (a codec this browser can't play).
 */
export async function checkDecodable(video: VideoTrack): Promise<VideoDecoderConfig> {
  if (typeof VideoDecoder === 'undefined') throw new AiError('device');
  const config = decoderConfig(video);
  const ok = await VideoDecoder.isConfigSupported(config).then((s) => s.supported === true, () => false);
  if (!ok) throw new AiError('unsupported', { detectedType: UNDECODABLE });
  return config;
}
