import { SfxType } from '@/ai/sfx-types';

export interface SfxSound {
  samples: Float32Array;
  sampleRate: number;
  anchor: number;
  duration: number;
  peakDb: number;
}

export interface SfxProvider {
  get(type: SfxType, variant: number): Promise<SfxSound | null>;
}
