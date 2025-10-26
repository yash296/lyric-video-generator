# Lyric Video Generator (Browser, No AI)

Generate a lyric video by combining an MP3 audio file and an SRT subtitle file. Renders animated backgrounds and synchronized lyrics on a Canvas and records to WebM via MediaRecorder. All processing runs locally in your browser — no AI or network calls.

## Features

- Upload MP3 and SRT; parse SRT into precise timestamps
- Two background modes: animated gradient, moving shapes (configurable speed)
- Lyric styling: font family, size, fill/stroke colors, vertical position
- Smooth lyric fade in/out (~150ms), multi-line support
- Custom resolution (720p, 1080p, square, vertical) and FPS (15–60)
- Combined canvas + audio recording to WebM (VP8/VP9)
- Fully offline; no generative AI

## Usage

1. Open `index.html` in a modern desktop browser (Chrome, Edge, Firefox).
2. Select your MP3 file.
3. Select your SRT file.
4. Optionally adjust settings (resolution, FPS, background, fonts, etc.).
5. Click "Start Render". A preview will render in real-time while recording.
6. When complete, click "Download" to save the WebM video.

Tip: Chrome tends to perform best for MediaRecorder + Canvas at 1080p.

## SRT Format

Standard SubRip text with timestamps `HH:MM:SS,mmm --> HH:MM:SS,mmm`. Example:

```
1
00:00:01,000 --> 00:00:03,500
First line of the lyric

2
00:00:03,600 --> 00:00:06,000
Second line
```

The parser strips HTML tags and supports `\N` for manual line breaks.

## Configuration Notes

- Background speed controls the motion intensity.
- Lyric position is a percentage of canvas height (0–100), measured to the last line's baseline.
- Stroke width scales with font size for readability.
- FPS controls the recording frame rate. 30 FPS is a good default.

## Performance

- For tracks under 5 minutes at 1080p/30 FPS, recording typically completes near real-time on modern hardware.
- Close other heavy tabs/apps if you see frame drops. Lower FPS or resolution if necessary.

## Browser Compatibility

- Tested on latest Chrome and Edge. Firefox works but may choose different codecs. Safari support for MediaRecorder is improving; Chrome is recommended.

## Export Format

- Output is `video/webm` (VP8/VP9). If you need MP4/H.264, you can transcode locally via FFmpeg:

```bash
ffmpeg -i lyric-video.webm -c:v libx264 -pix_fmt yuv420p -c:a aac lyric-video.mp4
```

## Node.js CLI (Headless Rendering)

Render without a browser using the provided Node-based CLI. It draws frames with `@napi-rs/canvas` and muxes with `ffmpeg-static`.

### Install

```bash
npm install
```

On Linux you may also need system packages for font rendering (freetype, fontconfig). `@napi-rs/canvas` docs have details.

### Usage

```bash
npm run render -- \
  --audio /path/to/song.mp3 \
  --srt /path/to/lyrics.srt \
  --out out.mp4 \
  --resolution 1920x1080 \
  --fps 30 \
  --bg gradient \
  --bg-speed 0.3 \
  --font-family "Inter, system-ui, sans-serif" \
  --font-size 56 \
  --font-color #ffffff \
  --stroke-color #000000 \
  --lyric-y 50 \
  --pipe-format raw \
  --preset veryfast \
  --crf 18 \
  --threads 0
```

Optional: register a custom font for consistent output

```bash
npm run render -- --audio song.mp3 --srt lyrics.srt --font-file ./fonts/MyFont.otf --font-family "MyFont"
```

Notes:

- Output is H.264 MP4 with AAC (`--crf 18`, `--preset veryfast` by default). Adjust with flags or edit `cli/render.js`.
- Duration is read via `ffprobe-static`; if missing, it falls back to the SRT’s last timestamp.
- Backgrounds and lyric styling match the browser logic closely for parity.

### Performance tuning

- Pipe format: `--pipe-format raw` is fastest (streams raw RGBA). Use `--pipe-format png` to reduce pipe bandwidth at the cost of per-frame PNG encoding.
- Encoder speed/quality: tune `--preset` and `--crf`.
  - Lower `--crf` = higher quality, larger files. Typical range 18–23.
  - Faster `--preset` (e.g., `ultrafast`) = faster encodes, larger files.
- Threads: `--threads 0` lets x264 auto-pick; set a number to limit CPU.

Examples:

```bash
# Max speed (larger file)
npm run render -- --audio song.mp3 --srt lyrics.srt \
  --pipe-format raw --preset ultrafast --crf 20 --threads 0

# Balanced
npm run render -- --audio song.mp3 --srt lyrics.srt \
  --pipe-format raw --preset veryfast --crf 18 --threads 0
```

## License

MIT
