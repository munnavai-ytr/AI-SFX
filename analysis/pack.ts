import { AnalysisBundle } from '@/types/analysis';

export interface PackOptions {
  projectId: string;
  fileKey: string;
  createdAt: number;
  duration: number;
  width: number;
  height: number;
  fps: number | null;
  hasAudio: boolean;
  audioWav16k: Blob | null;
  envelopeDb: number[];
  transients: { t: number; strengthDb: number }[];
  quietGaps: { start: number; end: number }[];
  cuts: { t: number; strength: number }[];
  samples: { t: number; jpeg: Blob }[];
  mode: 'realtime-capture' | 'seek-fallback';
  tookMs: number;
  onProgress?: (progress: number, detail: string) => void;
}

/**
 * Resizes a JPEG blob using an offscreen canvas.
 */
async function reencodeSample(blob: Blob, targetWidth = 320, quality = 0.6): Promise<Blob> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob);
    const scale = targetWidth / bitmap.width;
    const targetHeight = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return blob;
    ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
    bitmap.close();
    return new Promise((resolve) => {
      canvas.toBlob((b) => resolve(b || blob), 'image/jpeg', quality);
    });
  }

  // Fallback to Image element
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = targetWidth / img.width;
      const targetHeight = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(blob);
        return;
      }
      ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
      canvas.toBlob((b) => resolve(b || blob), 'image/jpeg', quality);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(blob);
    };
    img.src = url;
  });
}

/**
 * Packs analysis result, checks payload size constraints (< 18 MB), applies optimization if needed.
 */
export async function packAnalysisBundle(opts: PackOptions): Promise<AnalysisBundle> {
  const audioBytes = opts.audioWav16k ? opts.audioWav16k.size : 0;
  let currentSamples = [...opts.samples];
  let frameBytes = currentSamples.reduce((sum, s) => sum + s.jpeg.size, 0);
  let payloadMB = Number((((audioBytes + frameBytes) * 1.34) / 1e6).toFixed(2));

  let detailMsg = `Package size: ${payloadMB} MB (${(audioBytes / 1e6).toFixed(1)} MB audio, ${(frameBytes / 1e6).toFixed(1)} MB frames)`;

  // Check 18 MB threshold
  if (payloadMB > 18) {
    opts.onProgress?.(0.3, `Payload (${payloadMB} MB) exceeds 18 MB threshold. Compressing frame samples (320px, q 0.6)...`);
    const reencoded: { t: number; jpeg: Blob }[] = [];
    for (const sample of currentSamples) {
      const smallerBlob = await reencodeSample(sample.jpeg, 320, 0.6);
      reencoded.push({ t: sample.t, jpeg: smallerBlob });
    }
    currentSamples = reencoded;
    frameBytes = currentSamples.reduce((sum, s) => sum + s.jpeg.size, 0);
    payloadMB = Number((((audioBytes + frameBytes) * 1.34) / 1e6).toFixed(2));

    detailMsg = `Compressed samples to 320px (q 0.6): ${payloadMB} MB`;

    // Second threshold check: drop to 0.5 fps if still over 18 MB
    if (payloadMB > 18) {
      opts.onProgress?.(0.7, `Payload still ${payloadMB} MB. Downsampling frames to 0.5 fps...`);
      currentSamples = currentSamples.filter((_, idx) => idx % 2 === 0);
      frameBytes = currentSamples.reduce((sum, s) => sum + s.jpeg.size, 0);
      payloadMB = Number((((audioBytes + frameBytes) * 1.34) / 1e6).toFixed(2));
      detailMsg = `Downsampled frames to 0.5 fps & 320px: ${payloadMB} MB`;
    }
  }

  opts.onProgress?.(1.0, detailMsg);

  const bundle: AnalysisBundle = {
    projectId: opts.projectId,
    fileKey: opts.fileKey,
    createdAt: opts.createdAt,
    duration: opts.duration,
    width: opts.width,
    height: opts.height,
    fps: opts.fps,
    hasAudio: opts.hasAudio,
    audioWav16k: opts.audioWav16k,
    envelopeDb: opts.envelopeDb,
    transients: opts.transients,
    quietGaps: opts.quietGaps,
    cuts: opts.cuts,
    samples: currentSamples,
    stats: {
      audioBytes,
      frameBytes,
      payloadMB,
      tookMs: opts.tookMs,
      mode: opts.mode,
    },
  };

  return bundle;
}
