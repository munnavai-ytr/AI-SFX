import { SfxType } from '@/ai/sfx-types';
import { SfxSound, SfxProvider } from './provider';
import { SR, removeDc, fadeEdges, normalizePeak, peakDbOf } from './dsp';

interface ManifestItem {
  file: string;
  anchor?: number;
}

type ManifestMap = Partial<Record<SfxType, ManifestItem[]>>;

export class PackProvider implements SfxProvider {
  private manifestPromise: Promise<ManifestMap | null> | null = null;
  private audioCtx: AudioContext | null = null;

  private async loadManifest(): Promise<ManifestMap | null> {
    if (this.manifestPromise) return this.manifestPromise;

    this.manifestPromise = (async () => {
      if (typeof window === 'undefined') return null;
      try {
        const res = await fetch('/sfx/manifest.json');
        if (!res.ok) return null;
        const data = await res.json();
        return data as ManifestMap;
      } catch {
        return null;
      }
    })();

    return this.manifestPromise;
  }

  private getAudioContext(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (!this.audioCtx) {
      const AudioCtxClass =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtxClass) {
        this.audioCtx = new AudioCtxClass();
      }
    }
    return this.audioCtx;
  }

  async get(type: SfxType, variant: number): Promise<SfxSound | null> {
    const manifest = await this.loadManifest();
    if (!manifest || !manifest[type]) return null;

    const list = manifest[type]!;
    if (list.length === 0) return null;

    const item = list[variant % list.length];
    if (!item || !item.file) return null;

    try {
      const res = await fetch(`/sfx/${item.file}`);
      if (!res.ok) return null;
      const arrayBuf = await res.arrayBuffer();

      const ctx = this.getAudioContext();
      if (!ctx) return null;

      const audioBuf = await ctx.decodeAudioData(arrayBuf);
      const numSamples = audioBuf.length;
      const rawMono = new Float32Array(numSamples);

      // Downmix to mono if multi-channel
      const numCh = audioBuf.numberOfChannels;
      for (let ch = 0; ch < numCh; ch++) {
        const chData = audioBuf.getChannelData(ch);
        for (let i = 0; i < numSamples; i++) {
          rawMono[i] += chData[i] / numCh;
        }
      }

      // If sample rate differs, simple linear resample to 44100 Hz
      let samples: Float32Array;
      if (audioBuf.sampleRate !== SR) {
        const ratio = SR / audioBuf.sampleRate;
        const targetLen = Math.round(numSamples * ratio);
        samples = new Float32Array(targetLen);
        for (let i = 0; i < targetLen; i++) {
          const srcIdx = i / ratio;
          const i0 = Math.floor(srcIdx);
          const i1 = Math.min(numSamples - 1, i0 + 1);
          const frac = srcIdx - i0;
          samples[i] = rawMono[i0] * (1 - frac) + rawMono[i1] * frac;
        }
      } else {
        samples = rawMono;
      }

      samples = removeDc(samples);
      samples = fadeEdges(samples, 6);
      samples = normalizePeak(samples, -6);

      const duration = Number((samples.length / SR).toFixed(3));

      // Determine anchor
      let anchor = item.anchor;
      if (typeof anchor !== 'number') {
        // Auto-detect first sample above -30 dBFS (approx threshold = 10^(-30/20) ~ 0.0316)
        const threshold = 0.0316;
        let detected = 0;
        for (let i = 0; i < samples.length; i++) {
          if (Math.abs(samples[i]) >= threshold) {
            detected = i / SR;
            break;
          }
        }
        anchor = detected;
      }

      const validAnchor = Math.min(Math.max(0, anchor), duration);
      const peakDb = Number(peakDbOf(samples).toFixed(2));

      return {
        samples,
        sampleRate: SR,
        anchor: Number(validAnchor.toFixed(3)),
        duration,
        peakDb,
      };
    } catch (err) {
      console.warn(`Failed to load pack sound /sfx/${item.file}:`, err);
      return null;
    }
  }
}
