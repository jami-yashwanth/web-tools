// gifenc 1.0.3 ships no types: the parts Video to GIF uses (see node_modules/gifenc/README.md).
declare module 'gifenc' {
  export type Format = 'rgb565' | 'rgb444' | 'rgba4444';
  export type Palette = number[][];
  export interface WriteFrameOptions {
    palette?: Palette;
    /** Milliseconds (written as hundredths of a second). */
    delay?: number;
    /** -1 plays once, 0 forever, n times. Written with the first frame. */
    repeat?: number;
    transparent?: boolean;
    transparentIndex?: number;
    dispose?: number;
  }
  export interface Encoder {
    writeFrame(index: Uint8Array, width: number, height: number, opts?: WriteFrameOptions): void;
    finish(): void;
    /** A copy of the bytes written so far. */
    bytes(): Uint8Array<ArrayBuffer>;
    /** The bytes written so far, without a copy. */
    bytesView(): Uint8Array<ArrayBuffer>;
  }
  export function GIFEncoder(opts?: { auto?: boolean; initialCapacity?: number }): Encoder;
  export function quantize(rgba: Uint8Array | Uint8ClampedArray, maxColors: number, opts?: { format?: Format; oneBitAlpha?: boolean | number }): Palette;
  export function applyPalette(rgba: Uint8Array | Uint8ClampedArray, palette: Palette, format?: Format): Uint8Array<ArrayBuffer>;
}
