// A minimal PCM WAV writer for the Transcribe audio tests and fixtures (scripts/make-audio-fixtures.ts).

/** A WAV file of `channels` (each a list of samples in -1..1) at `rate`, as 8- or 16-bit PCM. */
export function wav(channels: Float32Array[], rate: number, bits: 8 | 16 = 16): Buffer {
  const n = channels[0]!.length;
  const block = channels.length * (bits / 8);
  const data = n * block;
  const out = Buffer.alloc(44 + data);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + data, 4);
  out.write('WAVE', 8);
  out.write('fmt ', 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(channels.length, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * block, 28);
  out.writeUInt16LE(block, 32);
  out.writeUInt16LE(bits, 34);
  out.write('data', 36);
  out.writeUInt32LE(data, 40);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (const ch of channels) {
      const v = Math.max(-1, Math.min(1, ch[i]!));
      if (bits === 16) out.writeInt16LE(Math.round(v * 32767), o);
      else out.writeUInt8(Math.round(v * 127) + 128, o);
      o += bits / 8;
    }
  }
  return out;
}

/** `seconds` of a tone (speech-level, about -20 dBFS) at `rate`. */
export function tone(seconds: number, rate: number, hz = 220): Float32Array {
  return Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => 0.1 * Math.sin((2 * Math.PI * hz * i) / rate));
}
