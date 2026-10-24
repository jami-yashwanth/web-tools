// JPG to PDF keeps a JPEG's own bytes (no re-encoding), so it would also keep the photo's metadata: where it was taken
// (EXIF GPS), the camera, the date. This drops those segments losslessly before the JPEG goes into the PDF: APP1
// (EXIF and XMP) and APP13 (Photoshop IPTC). Everything else, the colour profile (APP2) and the picture itself, is kept
// byte for byte.

const APP1 = 0xe1;
const APP13 = 0xed;
const SOS = 0xda;

/**
 * `jpeg` without its APP1 and APP13 segments. Returns the input itself when there is nothing to remove, or when the
 * header can't be followed (not a JPEG, or cut short): the embed then reports a broken file as before.
 */
export function stripJpegMetadata(jpeg: Uint8Array): Uint8Array {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return jpeg;
  const keep: [number, number][] = [[0, 2]]; // SOI
  let removed = false;
  let p = 2;
  for (;;) {
    if (p + 1 >= jpeg.length || jpeg[p] !== 0xff) return jpeg;
    // Fill bytes: any number of 0xFF may come before a marker.
    let m = p + 1;
    while (m < jpeg.length && jpeg[m] === 0xff) m++;
    if (m + 2 >= jpeg.length) return jpeg;
    const marker = jpeg[m]!;
    if (marker === SOS) {
      keep.push([p, jpeg.length]); // the scan and all after it, as it is
      break;
    }
    // Markers without a length (TEM, RSTn) don't appear before the scan in a real file; anything else has one.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) return jpeg;
    const end = m + 1 + ((jpeg[m + 1]! << 8) | jpeg[m + 2]!);
    if (end > jpeg.length || end < m + 3) return jpeg;
    if (marker === APP1 || marker === APP13) removed = true;
    else keep.push([p, end]);
    p = end;
  }
  if (!removed) return jpeg;
  const out = new Uint8Array(keep.reduce((n, [a, b]) => n + b - a, 0));
  let o = 0;
  for (const [a, b] of keep) {
    out.set(jpeg.subarray(a, b), o);
    o += b - a;
  }
  return out;
}
