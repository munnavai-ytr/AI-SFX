/**
 * Pure audio functions for Step 5 Export: mixdown with soft-limiting and 16-bit WAV encoding.
 */

/**
 * Mixes original video audio and SFX bus audio.
 * Soft-limits ONLY samples above threshold th = 10^(-1/20) dB (~ -1 dBFS).
 * Quiet material (samples <= th) is untouched.
 */
export function mixdown(
  orig: [Float32Array, Float32Array],
  sfx: [Float32Array, Float32Array]
): [Float32Array, Float32Array] {
  const th = Math.pow(10, -1 / 20); // ~0.89125 (-1 dBFS)
  const len0 = Math.max(orig[0].length, sfx[0]?.length || 0);
  const len1 = Math.max(orig[1].length, sfx[1]?.length || 0);

  const out: [Float32Array, Float32Array] = [
    new Float32Array(len0),
    new Float32Array(len1),
  ];

  for (let c = 0; c < 2; c++) {
    const origChan = orig[c] || new Float32Array(0);
    const sfxChan = sfx[c] || new Float32Array(0);
    const target = out[c];
    const len = target.length;

    for (let i = 0; i < len; i++) {
      const v = (origChan[i] ?? 0) + (sfxChan[i] ?? 0);
      const a = Math.abs(v);
      if (a <= th) {
        target[i] = v;
      } else {
        // Soft-limiting equation specified in requirements
        target[i] = Math.sign(v) * (th + (1 - th) * Math.tanh((a - th) / (1 - th)));
      }
    }
  }

  return out;
}

/**
 * Encodes 2-channel stereo Float32Array audio buffers into a 16-bit signed PCM WAV buffer.
 */
export function encodeWav16(
  channels: [Float32Array, Float32Array] | Float32Array[],
  sampleRate = 44100
): Uint8Array {
  const left = channels[0] || new Float32Array(0);
  const right = channels[1] || left;
  const numSamples = Math.max(left.length, right.length);
  const numChannels = 2;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numSamples * blockAlign;
  const chunkSize = 36 + dataSize;

  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  // RIFF Header
  writeString(0, 'RIFF');
  view.setUint32(4, chunkSize, true);
  writeString(8, 'WAVE');

  // fmt Subchunk
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true); // AudioFormat (1 for PCM)
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data Subchunk
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  // Write PCM Samples
  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    // Left Channel
    const sampleL = Math.max(-1, Math.min(1, left[i] ?? 0));
    const intL = sampleL < 0 ? sampleL * 0x8000 : sampleL * 0x7fff;
    view.setInt16(offset, intL, true);
    offset += 2;

    // Right Channel
    const sampleR = Math.max(-1, Math.min(1, right[i] ?? 0));
    const intR = sampleR < 0 ? sampleR * 0x8000 : sampleR * 0x7fff;
    view.setInt16(offset, intR, true);
    offset += 2;
  }

  return new Uint8Array(buffer);
}
