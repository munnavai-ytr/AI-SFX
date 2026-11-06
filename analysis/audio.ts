import { encodeWav16k } from './wav';
import { detectTransients, detectQuietGaps } from './detect';

export interface AudioAnalysisResult {
  hasAudio: boolean;
  audioWav16k: Blob | null;
  envelopeDb: number[];
  transients: { t: number; strengthDb: number }[];
  quietGaps: { start: number; end: number }[];
  audioBytes: number;
  skipReason?: string;
  decodedDurationSeconds?: number;
}

/**
 * Extracts, decodes, resamples audio to 16kHz mono WAV, and computes envelope/transients/gaps.
 */
export async function processAudioTrack(
  file: File | Blob,
  videoDuration: number,
  onProgress?: (progress: number, detail: string) => void
): Promise<AudioAnalysisResult> {
  const AudioContextClass =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;

  if (!AudioContextClass) {
    return {
      hasAudio: false,
      audioWav16k: null,
      envelopeDb: [],
      transients: [],
      quietGaps: [],
      audioBytes: 0,
      skipReason: 'Web Audio API is not supported in this browser.',
    };
  }

  let audioCtx: AudioContext | null = null;
  try {
    audioCtx = new AudioContextClass();
    onProgress?.(0.1, 'Extracting audio track from video container...');

    const arrayBuffer = await file.arrayBuffer();

    onProgress?.(0.3, 'Decoding audio samples...');
    let decoded: AudioBuffer | null = null;
    try {
      // Pass the buffer directly without slicing
      decoded = await audioCtx.decodeAudioData(arrayBuffer);
    } catch (decodeErr) {
      return {
        hasAudio: false,
        audioWav16k: null,
        envelopeDb: [],
        transients: [],
        quietGaps: [],
        audioBytes: 0,
        skipReason: `No decodable audio track: ${(decodeErr as Error).message || 'No audio stream'}`,
      };
    }

    if (!decoded || decoded.numberOfChannels === 0 || decoded.length === 0) {
      return {
        hasAudio: false,
        audioWav16k: null,
        envelopeDb: [],
        transients: [],
        quietGaps: [],
        audioBytes: 0,
        skipReason: 'No decodable audio track: 0 audio channels found.',
      };
    }

    const duration = decoded.duration || videoDuration;
    const numChannels = decoded.numberOfChannels;
    const length = decoded.length;
    const sampleRate = decoded.sampleRate;
    onProgress?.(0.5, `Decoded ${duration.toFixed(1)} s of audio track (${numChannels} ch, ${sampleRate} Hz)`);

    // Downmix to mono Float32Array
    let monoPcm: Float32Array<ArrayBuffer> | null = new Float32Array(length);

    for (let ch = 0; ch < numChannels; ch++) {
      const channelData = decoded.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        monoPcm[i] += channelData[i] / numChannels;
      }
    }

    // Release decoded reference early
    decoded = null;

    // Resample to 16 kHz using OfflineAudioContext
    onProgress?.(0.7, 'Resampling audio to 16 kHz mono...');
    const targetSampleRate = 16000;
    const targetLength = Math.max(1, Math.ceil(duration * targetSampleRate));

    const offlineCtx = new OfflineAudioContext(1, targetLength, targetSampleRate);
    const sourceBuffer = offlineCtx.createBuffer(1, length, sampleRate);
    if (monoPcm) {
      sourceBuffer.copyToChannel(monoPcm, 0);
    }

    // Release monoPcm reference early
    monoPcm = null;

    const sourceNode = offlineCtx.createBufferSource();
    sourceNode.buffer = sourceBuffer;
    sourceNode.connect(offlineCtx.destination);
    sourceNode.start(0);

    const renderedBuffer = await offlineCtx.startRendering();
    let resampledMono: Float32Array | null = renderedBuffer.getChannelData(0);

    // Encode to 16-bit PCM WAV Blob
    onProgress?.(0.85, 'Encoding 16-bit PCM WAV...');
    const audioWav16k = encodeWav16k(resampledMono, targetSampleRate);
    const audioBytes = audioWav16k.size;

    // Compute loudness envelope at 50 Hz (20 ms window, 20 ms hop)
    // 20 ms at 16000 Hz = 320 samples
    onProgress?.(0.95, 'Computing loudness envelope & dynamics...');
    const windowSamples = 320;
    const envelopeDb: number[] = [];

    for (let i = 0; i < resampledMono.length; i += windowSamples) {
      const count = Math.min(windowSamples, resampledMono.length - i);
      let sumSq = 0;
      for (let j = 0; j < count; j++) {
        const val = resampledMono[i + j];
        sumSq += val * val;
      }
      const rms = Math.sqrt(sumSq / count);
      const db = rms > 0.0000001 ? 20 * Math.log10(rms) : -100;
      envelopeDb.push(Math.max(-100, Math.min(0, db)));
    }

    // Release resampledMono reference early
    resampledMono = null;

    const transients = detectTransients(envelopeDb, 50);
    const quietGaps = detectQuietGaps(envelopeDb, 50);

    onProgress?.(1.0, `Audio processing complete (${transients.length} transients, ${quietGaps.length} quiet gaps)`);

    return {
      hasAudio: true,
      audioWav16k,
      envelopeDb,
      transients,
      quietGaps,
      audioBytes,
      decodedDurationSeconds: duration,
    };
  } catch (err) {
    return {
      hasAudio: false,
      audioWav16k: null,
      envelopeDb: [],
      transients: [],
      quietGaps: [],
      audioBytes: 0,
      skipReason: `No decodable audio track: ${(err as Error).message}`,
    };
  } finally {
    if (audioCtx && audioCtx.state !== 'closed') {
      try {
        await audioCtx.close();
      } catch {
        // ignore close error
      }
    }
  }
}
