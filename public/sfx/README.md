# Custom SFX Audio Pack Instructions

To add custom CC0 / royalty-free audio samples to SFX AI:

1. Place your `.wav` or `.mp3` audio files in this `public/sfx/` directory.
2. Create or update `manifest.json` in `public/sfx/manifest.json` with the following structure:

```json
{
  "whoosh_fast": [
    { "file": "custom_whoosh_1.wav", "anchor": 0.31 },
    { "file": "custom_whoosh_2.wav", "anchor": 0.28 }
  ],
  "impact_hard": [
    { "file": "custom_hit.wav", "anchor": 0.005 }
  ]
}
```

3. `anchor` is the time (in seconds) from the start of the audio file to its key moment / peak impact. If omitted, the app will auto-detect the anchor at the first sample exceeding -30 dBFS.
4. Document the source and license of all added audio files in `public/sfx/LICENSES.md`.
