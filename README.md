# SFX AI (Step 2: Real Analysis Engine)

AI-assisted sound effects workflow for video creators.
Step 2 implements the real browser-only analysis engine without mock data or external API calls.

## Prerequisites & Installation

Install dependencies:

```bash
npm install
```

## Development

Start local development server:

```bash
npm run dev
```

App runs at `http://localhost:3000`.

## Testing

Run unit test suite with Vitest:

```bash
npm test
```

Verifies:
- `detectCuts`: pure signal scene boundary detection from frame difference arrays
- `detectTransients`: audio rise/hit detection above dB threshold
- `detectQuietGaps`: quiet window detection below noise floor
- `encodeWav16k`: RIFF/WAVE header fields and 16-bit PCM WAV byte structure

## Production Build

Build the static export (`output: 'export'`):

```bash
npm run build
```

The compiled static export bundle is emitted into `out/` ready for Capacitor or static hosting.

## Analysis Pipeline (Step 2 Engine)

1. **`read`**: Loads stored video Blob from IndexedDB, creates temporary object URL, primes offscreen `<video>` (`readyState >= 2`).
2. **`audio`**: Decodes audio track with `AudioContext`, downmixes to mono Float32, resamples to 16 kHz using `OfflineAudioContext`, encodes 16-bit PCM WAV Blob. Gracefully skips if file lacks audio.
3. **`frames`**: Realtime capture at 2x playbackRate using `requestVideoFrameCallback` (or sequential seek fallback). Compares 32x18 grayscale diffs and captures 384px JPEG frames at 1 fps. Estimates FPS from median frame spacing.
4. **`cuts`**: Computes scene transitions using adaptive window median difference scoring.
5. **`sound`**: Computes 50 Hz loudness envelope in dBFS, detects transient hits and quiet pauses.
6. **`pack`**: Packages bundle, enforces 18 MB inline payload budget (optimizing JPEG dimensions and frame rate if necessary), saves `AnalysisBundle` to IndexedDB.
