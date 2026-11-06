export interface AnalysisBundle {
  projectId: string;
  fileKey: string;
  createdAt: number;
  duration: number;
  width: number;
  height: number;
  fps: number | null;
  hasAudio: boolean;
  audioWav16k: Blob | null; // 16 kHz mono 16-bit PCM WAV, for Gemini only
  envelopeDb: number[]; // loudness in dBFS at 50 values/second
  transients: { t: number; strengthDb: number }[];
  quietGaps: { start: number; end: number }[];
  cuts: { t: number; strength: number }[];
  samples: { t: number; jpeg: Blob }[]; // 1 frame/second, 384 px wide, JPEG q 0.7
  stats: {
    audioBytes: number;
    frameBytes: number;
    payloadMB: number;
    tookMs: number;
    mode: 'realtime-capture' | 'seek-fallback';
  };
}
