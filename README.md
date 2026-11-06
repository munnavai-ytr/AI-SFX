# SFX AI

Professional AI sound design app for video content. Upload a video, run AI analysis to auto-detect cuts and sound moments, refine sound effects in the Studio timeline, and export mixed videos with fast, zero-re-encode stream copying.

## Features
- **Video Upload**: Native file picker on Android, browser input on web with client-side probe.
- **Measurable Signal Analysis**: Scene cut detection, audio envelope, transient peaks, speech detection.
- **AI Sound Director**: Powered by Gemini flash models to map scene beats to 30 deterministic DSP sound effect types.
- **Studio Sound Mixer**: Live audio preview scheduler, timeline drag/snap, variant switching, master volume & sync offset.
- **Fast Video Export**: Lossless video stream copying (`-c:v copy`) + 44.1 kHz AAC audio muxing via `@ffmpeg/ffmpeg`.
- **WAV Fallbacks**: Export SFX audio only or mixed audio directly to WAV files.
- **Privacy First**: All video processing runs locally in your browser/device. Only minimal 1 fps frames and low-quality audio are sent to Gemini for analysis.

## How to Get the Android APK
1. Push your changes to the `main` branch on GitHub.
2. Go to the **Actions** tab in your GitHub repository.
3. Select the **Build Android APK** workflow.
4. Download the `sfx-ai-debug-apk` artifact containing `app-debug.apk`.

## Local Development & Testing
```bash
# Install dependencies
npm install

# Prebuild copies FFmpeg assets to public/ffmpeg/
npm run dev

# Run unit test suite
npm test

# Build static production export
npm run build
```
