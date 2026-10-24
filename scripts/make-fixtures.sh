#!/usr/bin/env bash
# Generates tests/fixtures/*. macOS only (needs sips).
# Large fixtures (iphone-48mp.heic, huge-63mp.jpg) are gitignored; run `npm run fixtures`.
set -euo pipefail

missing=()
for tool in sips exiftool img2webp cwebp heif-enc magick qpdf node; do
  command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "Missing tools: ${missing[*]}" >&2
  echo "sips ships with macOS. Install the rest with:" >&2
  echo "  brew install exiftool webp libheif imagemagick qpdf" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/tests/fixtures"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$OUT"

GPS=(-GPSLatitude=37.7749 -GPSLatitudeRef=N -GPSLongitude=122.4194 -GPSLongitudeRef=W)

# Smooth, colourful source image at a given size (kept compressible so fixtures stay small).
base() { # w h out
  magick -size "${1}x${2}" gradient:'#ff7a18-#2b5876' \
    \( -size "${1}x${2}" radial-gradient:white-'#555555' \) \
    -compose multiply -composite "$3"
}

# --- HEIC ---
base 4032 3024 "$TMP/12mp.png"
sips -s format heic "$TMP/12mp.png" --out "$OUT/iphone-12mp.heic" >/dev/null
exiftool -q -overwrite_original "${GPS[@]}" "$OUT/iphone-12mp.heic"

base 8064 6048 "$TMP/48mp.png"
sips -s format heic "$TMP/48mp.png" --out "$OUT/iphone-48mp.heic" >/dev/null

base 400 300 "$TMP/400.png"
sips -s format heic "$TMP/400.png" --out "$OUT/rotated-6.heic" >/dev/null
exiftool -q -overwrite_original -n -Orientation=6 "$OUT/rotated-6.heic"

magick -size 400x300 gradient:'#ff7a18-#2b5876' "$TMP/m1.jpg"
magick -size 200x150 gradient:'#00ff88-#ff0088' "$TMP/m2.jpg"
heif-enc -q 80 "$TMP/m1.jpg" "$TMP/m2.jpg" -o "$OUT/multi.heic" >/dev/null || \
  heif-enc -q 80 "$TMP/m1.jpg" "$TMP/m2.jpg" --output "$OUT/multi.heic" >/dev/null

# --- JPG ---
base 1600 1200 "$TMP/photo.png"
magick "$TMP/photo.png" -quality 85 "$OUT/photo.jpg"
exiftool -q -overwrite_original "${GPS[@]}" "$OUT/photo.jpg"

# A 400 x 300 JPEG whose EXIF Orientation says "rotate 90": it should read as 300 x 400 once upright.
magick -size 400x300 gradient:'#ff7a18-#2b5876' -quality 85 "$OUT/rotated-6.jpg"
exiftool -q -overwrite_original -n -Orientation=6 "$OUT/rotated-6.jpg"

magick -size 9000x7000 gradient:'#ff7a18-#2b5876' -quality 60 "$OUT/huge-63mp.jpg"

# --- WebP ---
base 800 600 "$TMP/w.png"
cwebp -q 75 -quiet "$TMP/w.png" -o "$OUT/lossy.webp"
cwebp -lossless -quiet "$TMP/w.png" -o "$OUT/lossless.webp"
magick -size 200x150 gradient:'#ff7a18-#2b5876' "$TMP/f1.png"
magick -size 200x150 gradient:'#00ff88-#ff0088' "$TMP/f2.png"
img2webp -lossy -d 100 "$TMP/f1.png" -d 100 "$TMP/f2.png" -o "$OUT/animated.webp" >/dev/null

# --- PNG / alpha ---
magick -size 200x150 gradient:'#ff7a18-#2b5876' -alpha set -channel A -fx 'i<100?0:1' +channel PNG32:"$TMP/alpha-src.png"
cp "$TMP/alpha-src.png" "$OUT/alpha.png"
cwebp -lossless -exact -quiet "$OUT/alpha.png" -o "$OUT/alpha.webp"
magick -size 200x150 gradient:'#ff7a18-#2b5876' -depth 16 PNG48:"$OUT/png16.png"
magick -size 200x150 gradient:'#ffffff-#000000' -colorspace Gray -type Grayscale -depth 8 PNG:"$OUT/grey.png"
magick -size 200x150 gradient:'#ff7a18-#2b5876' -colors 16 PNG8:"$OUT/palette.png"

# Remove background: just over its 25 MP cap (one flat colour, so the file stays small).
magick -size 5200x5000 xc:'#3a7a5c' -depth 8 PNG24:"$OUT/bg-26mp.png"

# --- Broken / disguised ---
head -c 2048 "$OUT/iphone-12mp.heic" > "$OUT/truncated.heic"
: > "$OUT/empty.heic"
printf 'This is plain text, not an image.\n' > "$OUT/text-as.heic"
cp "$OUT/iphone-12mp.heic" "$OUT/heic-named.jpg"

# --- PDF ---
mkdir -p "$OUT/pdf"
node "$ROOT/scripts/make-pdf-fixtures.mjs" "$OUT/pdf"
qpdf --encrypt user owner 256 -- "$OUT/pdf/three-pages.pdf" "$OUT/pdf/encrypted.pdf"
printf 'This is plain text, not a PDF.\n' > "$OUT/pdf/not-a.pdf"
head -c 400 "$OUT/pdf/three-pages.pdf" > "$OUT/pdf/truncated.pdf"

# --- OCR (tests/fixtures/ocr). Gaussian noise is random: low-confidence.png is committed, and a regenerated one may
# read slightly differently (it must stay non-empty with a mean confidence below 70; check with tests/e2e/ocr.spec.ts).
mkdir -p "$OUT/ocr"
FONT=/System/Library/Fonts/Supplemental/Arial.ttf
magick -size 900x160 xc:white -font "$FONT" -pointsize 56 -fill black -gravity center -annotate 0 'The quick brown fox 12345' "$OUT/ocr/hello.png"
magick -size 900x160 xc:white "$OUT/ocr/blank.png"
# Stored turned a quarter anticlockwise, with EXIF Orientation 6 saying "turn it back": reads only if orientation is applied.
magick "$OUT/ocr/hello.png" -rotate -90 -quality 92 "$OUT/ocr/hello-rotated-6.jpg"
exiftool -q -overwrite_original -Orientation#=6 "$OUT/ocr/hello-rotated-6.jpg"
magick -size 900x160 xc:white -font "$FONT" -pointsize 56 -fill '#999' -gravity center -annotate 0 'The quick brown fox 12345' \
  -blur 0x2.5 -attenuate 1 +noise Gaussian "$OUT/ocr/low-confidence.png"

# --- Transcribe audio (tests/fixtures/audio) ---
node "$ROOT/scripts/make-audio-fixtures.ts" "$OUT/audio"

# --- Video (tests/fixtures/video). ffmpeg (`brew install ffmpeg`) is a dev-only tool: nothing it makes ships. ---
if command -v ffmpeg >/dev/null 2>&1; then
  mkdir -p "$OUT/video"
  FF=(ffmpeg -hide_banner -loglevel error -y)
  SRC=(-f lavfi -i "testsrc2=size=640x360:rate=30" -f lavfi -i "sine=frequency=440:sample_rate=48000")
  # 3 s, H.264 High + AAC, 640 x 360 at 30 fps. Grain and a generous bitrate, so compressing it makes it smaller.
  "${FF[@]}" -f lavfi -i "testsrc2=size=640x360:rate=30,noise=alls=20:allf=t" -f lavfi -i "sine=frequency=440:sample_rate=48000" \
    -t 3 -c:v libx264 -profile:v high -pix_fmt yuv420p -b:v 2200k -maxrate 2400k -bufsize 2400k -c:a aac -b:a 96k \
    -movflags +faststart "$OUT/video/clip.mp4"
  # The same picture as VP9 + Opus in WebM (not supported: the tool says so).
  "${FF[@]}" "${SRC[@]}" -t 3 -c:v libvpx-vp9 -b:v 300k -c:a libopus -b:a 64k "$OUT/video/clip.webm"
  # H.264 with Opus sound in MP4: the picture is compressed, the sound can't be kept.
  "${FF[@]}" -f lavfi -i "testsrc2=size=640x360:rate=30,noise=alls=20:allf=t" -f lavfi -i "sine=frequency=440:sample_rate=48000" \
    -t 2 -c:v libx264 -pix_fmt yuv420p -b:v 1500k -maxrate 1600k -bufsize 1600k -c:a libopus -b:a 48k "$OUT/video/opus-sound.mp4"
  # 1 s at 1920 x 1080 (no sound): 720p makes it 1280 x 720.
  "${FF[@]}" -f lavfi -i "testsrc2=size=1920x1080:rate=30" -t 1 -c:v libx264 -pix_fmt yuv420p -crf 35 -an "$OUT/video/hd.mp4"
  # A phone's portrait video: stored 640 x 360, with a display matrix turning it a quarter clockwise (as an iPhone
  # records it; ffmpeg counts anticlockwise, hence -90). It plays as 360 x 640.
  "${FF[@]}" -f lavfi -i "testsrc2=size=640x360:rate=30" -t 1 -c:v libx264 -pix_fmt yuv420p -crf 35 -an "$TMP/upright.mp4"
  "${FF[@]}" -display_rotation:v:0 -90 -i "$TMP/upright.mp4" -c copy "$OUT/video/rotated.mp4"
  # Grain squeezed into 80 kbit/s, no sound: any encoder spends more than that on it, so the result isn't smaller.
  "${FF[@]}" -f lavfi -i "testsrc2=size=640x360:rate=30,noise=alls=20:allf=t" -t 2 -c:v libx264 -pix_fmt yuv420p \
    -b:v 80k -maxrate 80k -bufsize 160k -an "$OUT/video/well-compressed.mp4"
  # 2 min 1 s (over the 2 minute limit) but only a few KB: 32 x 32 at 1 fps.
  "${FF[@]}" -f lavfi -i "color=c=0x3a7a5c:size=32x32:rate=1" -t 121 -c:v libx264 -pix_fmt yuv420p -crf 45 -an \
    "$OUT/video/too-long.mp4"
  # 2 min 10 s, low-res: over Compress's 2 minute limit, but Video to GIF takes it (it decodes only the span).
  "${FF[@]}" -f lavfi -i "testsrc2=size=160x90:rate=10" -t 130 -c:v libx264 -pix_fmt yuv420p -crf 40 -g 50 -an \
    "$OUT/video/long-130s.mp4"
  head -c 30000 "$OUT/video/clip.mp4" > "$OUT/video/truncated.mp4"
else
  echo "ffmpeg not found: skipping tests/fixtures/video (brew install ffmpeg)" >&2
fi

echo "Fixtures written to $OUT"
