/**
 * Downsamples 16 kHz mono 16-bit WAV to 8 kHz mono 16-bit WAV using a 2-tap average + decimation.
 * Halves the byte count and token payload of the audio track for Gemini input.
 */

export async function downsampleWav16kTo8k(wav16kBlob: Blob): Promise<Blob> {
  const arrayBuffer = await wav16kBlob.arrayBuffer();
  const view = new DataView(arrayBuffer);

  // Verify RIFF and WAVE headers
  const isRiff =
    String.fromCharCode(
      view.getUint8(0),
      view.getUint8(1),
      view.getUint8(2),
      view.getUint8(3)
    ) === 'RIFF';

  const isWave =
    String.fromCharCode(
      view.getUint8(8),
      view.getUint8(9),
      view.getUint8(10),
      view.getUint8(11)
    ) === 'WAVE';

  if (!isRiff || !isWave) {
    // If not standard WAV, return as-is
    return wav16kBlob;
  }

  // Find 'data' chunk
  let offset = 12;
  let dataOffset = 44;
  let dataLength = 0;

  while (offset + 8 <= arrayBuffer.byteLength) {
    const chunkId = String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3)
    );
    const chunkSize = view.getUint32(offset + 4, true);

    if (chunkId === 'data') {
      dataOffset = offset + 8;
      dataLength = chunkSize;
      break;
    }
    offset += 8 + chunkSize;
  }

  if (dataLength <= 0 || dataOffset + dataLength > arrayBuffer.byteLength) {
    // Fallback: standard 44-byte header assumption
    dataOffset = 44;
    dataLength = Math.max(0, arrayBuffer.byteLength - 44);
  }

  const numSamples16k = Math.floor(dataLength / 2);
  if (numSamples16k <= 0) {
    return wav16kBlob;
  }

  // 2-tap average + decimation: 16 kHz -> 8 kHz
  const numSamples8k = Math.ceil(numSamples16k / 2);
  const outDataByteLength = numSamples8k * 2;
  const outBuffer = new ArrayBuffer(44 + outDataByteLength);
  const outView = new DataView(outBuffer);

  const writeString = (bufOffset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      outView.setUint8(bufOffset + i, str.charCodeAt(i));
    }
  };

  const sampleRate = 8000;
  const numChannels = 1;
  const bytesPerSample = 2;

  // RIFF header
  writeString(0, 'RIFF');
  outView.setUint32(4, 36 + outDataByteLength, true);
  writeString(8, 'WAVE');

  // fmt chunk
  writeString(12, 'fmt ');
  outView.setUint32(16, 16, true);
  outView.setUint16(20, 1, true); // PCM
  outView.setUint16(22, numChannels, true);
  outView.setUint32(24, sampleRate, true);
  outView.setUint32(28, sampleRate * numChannels * bytesPerSample, true); // byte rate = 16000
  outView.setUint16(32, numChannels * bytesPerSample, true); // block align = 2
  outView.setUint16(34, 16, true); // 16 bits

  // data chunk
  writeString(36, 'data');
  outView.setUint32(40, outDataByteLength, true);

  // Write downsampled samples
  let inOffset = dataOffset;
  let outOffset = 44;

  for (let i = 0; i < numSamples16k; i += 2) {
    const s1 = view.getInt16(inOffset, true);
    let s2 = s1;
    if (i + 1 < numSamples16k) {
      s2 = view.getInt16(inOffset + 2, true);
    }
    inOffset += 4;

    // 2-tap average
    const avg = Math.round((s1 + s2) / 2);
    const clamped = Math.max(-32768, Math.min(32767, avg));
    outView.setInt16(outOffset, clamped, true);
    outOffset += 2;
  }

  return new Blob([outBuffer], { type: 'audio/wav' });
}
