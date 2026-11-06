/**
 * Encodes Float32Array mono audio samples to a 16-bit PCM WAV Blob (16 kHz mono).
 */
export function encodeWav16k(samples: Float32Array, sampleRate = 16000): Blob {
  const numChannels = 1;
  const bytesPerSample = 2; // 16-bit
  const dataByteLength = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataByteLength);
  const view = new DataView(buffer);

  // Helper to write ASCII strings
  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  // RIFF identifier
  writeString(0, 'RIFF');
  // RIFF chunk length = 36 + data size
  view.setUint32(4, 36 + dataByteLength, true);
  // RIFF type
  writeString(8, 'WAVE');
  // format chunk identifier
  writeString(12, 'fmt ');
  // format chunk length
  view.setUint32(16, 16, true);
  // sample format (1 = PCM)
  view.setUint16(20, 1, true);
  // channel count (1 = mono)
  view.setUint16(22, numChannels, true);
  // sample rate
  view.setUint32(24, sampleRate, true);
  // byte rate (sampleRate * channels * bytesPerSample)
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
  // block align (channels * bytesPerSample)
  view.setUint16(32, numChannels * bytesPerSample, true);
  // bits per sample
  view.setUint16(34, 16, true);
  // data chunk identifier
  writeString(36, 'data');
  // data chunk length
  view.setUint32(40, dataByteLength, true);

  // Write 16-bit PCM samples with clamping
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    // Convert Float32 [-1, 1] to Int16 [-32768, 32767]
    const int16 = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
    view.setInt16(offset, int16, true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}
