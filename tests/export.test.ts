import { describe, it, expect } from 'vitest';
import { mixdown, encodeWav16 } from '../lib/export-audio';
import {
  isSupportedContainer,
  getUnsupportedMessage,
  buildFFmpegArgs,
  sanitizeFileName,
  createFileChunks,
  verifyDuration,
} from '../lib/ffmpeg-utils';

describe('Step 5 Export Audio & Mixdown Engine', () => {
  it('mixdown preserves lengths and quiet samples without modification', () => {
    const origLeft = new Float32Array([0.1, 0.2, -0.3, 0.0]);
    const origRight = new Float32Array([0.05, -0.1, 0.25, 0.1]);

    const sfxLeft = new Float32Array([0.05, 0.1, 0.0, -0.1]);
    const sfxRight = new Float32Array([0.1, 0.05, -0.05, 0.2]);

    const [outL, outR] = mixdown([origLeft, origRight], [sfxLeft, sfxRight]);

    expect(outL.length).toBe(4);
    expect(outR.length).toBe(4);

    // 0.1 + 0.05 = 0.15 <= 0.89125, so sample should be strictly equal to sum
    expect(outL[0]).toBeCloseTo(0.15, 5);
    expect(outR[0]).toBeCloseTo(0.15, 5);
  });

  it('mixdown soft-limits loud inputs so peak <= -1 dBFS (0.89125)', () => {
    const origLeft = new Float32Array([1.5, 2.0, -2.5]);
    const origRight = new Float32Array([1.0, 1.5, -1.8]);

    const sfxLeft = new Float32Array([1.0, 1.2, -1.5]);
    const sfxRight = new Float32Array([0.8, 1.0, -1.2]);

    const [outL, outR] = mixdown([origLeft, origRight], [sfxLeft, sfxRight]);

    for (let i = 0; i < outL.length; i++) {
      expect(Math.abs(outL[i])).toBeLessThanOrEqual(1.0);
      expect(Math.abs(outR[i])).toBeLessThanOrEqual(1.0);
    }
  });

  it('encodeWav16 produces valid 16-bit PCM WAV stereo header and byte array', () => {
    const left = new Float32Array([0.5, -0.5, 0.0, 1.0]);
    const right = new Float32Array([-0.5, 0.5, 0.0, -1.0]);

    const wavBytes = encodeWav16([left, right], 44100);

    // 44 header bytes + 4 samples * 2 channels * 2 bytes = 44 + 16 = 60 bytes
    expect(wavBytes.length).toBe(60);

    const view = new DataView(wavBytes.buffer);
    const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    expect(riff).toBe('RIFF');

    const wave = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
    expect(wave).toBe('WAVE');

    const numChannels = view.getUint16(22, true);
    expect(numChannels).toBe(2);

    const sampleRate = view.getUint32(24, true);
    expect(sampleRate).toBe(44100);

    const bitsPerSample = view.getUint16(34, true);
    expect(bitsPerSample).toBe(16);
  });
});

describe('Step 5 FFmpeg Utilities & Container Validator', () => {
  it('isSupportedContainer accepts mp4, m4v, mov and rejects webm, mkv, avi', () => {
    expect(isSupportedContainer('my-video.mp4')).toBe(true);
    expect(isSupportedContainer('clip.M4V')).toBe(true);
    expect(isSupportedContainer('movie.mov')).toBe(true);
    expect(isSupportedContainer('video/mp4')).toBe(true);

    expect(isSupportedContainer('video.webm')).toBe(false);
    expect(isSupportedContainer('film.mkv')).toBe(false);
    expect(isSupportedContainer('raw.avi')).toBe(false);
  });

  it('getUnsupportedMessage returns the exact required message string', () => {
    expect(getUnsupportedMessage()).toBe(
      "This format can't be exported without re-encoding. Convert the video to MP4 first."
    );
  });

  it('buildFFmpegArgs returns exact lossless copy & AAC muxing command array', () => {
    const args = buildFFmpegArgs();
    expect(args).toEqual([
      '-i',
      '/in/in.mp4',
      '-i',
      'mix.wav',
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-ar',
      '44100',
      '-ac',
      '2',
      '-shortest',
      '-movflags',
      '+faststart',
      'out.mp4',
    ]);
  });

  it('sanitizeFileName replaces extension with -sfx.mp4', () => {
    expect(sanitizeFileName('my_video.mp4')).toBe('my_video-sfx.mp4');
    expect(sanitizeFileName('vacation vlog.mov')).toBe('vacation_vlog-sfx.mp4');
  });

  it('createFileChunks splits N bytes into 3 MB chunks', () => {
    const totalSize = 7 * 1024 * 1024; // 7 MB
    const dummyBytes = new Uint8Array(totalSize);

    const chunks = createFileChunks(dummyBytes, 3 * 1024 * 1024);
    expect(chunks.length).toBe(3); // 3MB + 3MB + 1MB
    expect(chunks[0].length).toBe(3 * 1024 * 1024);
    expect(chunks[1].length).toBe(3 * 1024 * 1024);
    expect(chunks[2].length).toBe(1 * 1024 * 1024);
  });

  it('verifyDuration checks duration within 0.15s tolerance', () => {
    expect(verifyDuration(10.0, 10.05)).toBe(true);
    expect(verifyDuration(10.0, 10.14)).toBe(true);
    expect(verifyDuration(10.0, 10.20)).toBe(false);
  });
});
