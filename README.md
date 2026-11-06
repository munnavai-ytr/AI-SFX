# SFX AI (Step 1)

AI-assisted sound effects workflow for video creators.
Step 1 establishes project setup, the two-color volt/ink design system, 3 state-based screens, browser-only IndexedDB video management, and Gemini API key configuration with real live testing.

## Prerequisites & Installation

Install dependencies:

```bash
npm install
```

## Development

Start the local development server:

```bash
npm run dev
```

The app will be available on `http://localhost:3000`.

## Production Build

Build the static export (`output: 'export'`):

```bash
npm run build
```

The compiled static export bundle is emitted into the `out/` directory ready for Capacitor or static hosting.

## Architecture

- **State-based navigation**: Managed via Zustand (`stores/use-app-store.ts`), bypassing router overhead for seamless mobile/desktop transitions.
- **Client-side storage**: IndexedDB via `idb-keyval` (`lib/storage.ts`). Metadata stored under `sfx_ai_projects_list`, video files stored as individual Blobs. Temporary object URLs are created exclusively in memory at runtime and revoked on unmount.
- **Platform abstraction**: `platform/pick-video.ts` exports `pickVideo(): Promise<File | null>`, ready for native Android integration in later steps.
- **Video Probing**: `lib/probe-video.ts` validates file sizes (max 150 MB) and duration (max 120s), probes video metadata with an offscreen video element, and captures a frame at ~10% timestamp into an image thumbnail.
- **Analysis State Store**: `stores/use-analysis-store.ts` tracks exact real step states, elapsed time (250 ms ticker), real progress or indeterminate spinners, and retry/cancel flows.
- **Design System**: 2 brand colors (ink `#0B0D12` / cards `#14171E` and volt `#B6FF3B` accent), Inter UI typography, JetBrains Mono for timecodes, flat design with soft volt glow on active elements.
