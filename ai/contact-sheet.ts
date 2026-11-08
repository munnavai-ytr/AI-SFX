import { FrameSample } from '@/types/analysis';

export interface ContactSheetResult {
  blob: Blob;
  base64: string;
  frameCount: number;
  startSec: number;
  endSec: number;
  sheetIndex: number;
  totalSheets: number;
}

/**
 * Converts a Blob to a raw base64 string safely.
 */
export async function blobToBase64(blob: Blob): Promise<string> {
  const arrayBuffer = await blob.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(arrayBuffer);
  const len = bytes.byteLength;
  const chunkSize = 0x8000;
  for (let i = 0; i < len; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, len));
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
}

/**
 * Loads an image from a Blob.
 */
function loadImageFromBlob(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (err) => {
      URL.revokeObjectURL(url);
      reject(err);
    };
    img.src = url;
  });
}

/**
 * Draws a rounded rectangle path on canvas.
 */
function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/**
 * Selects at most maxCount evenly spaced samples from an array.
 */
export function selectEquallySpacedSamples<T>(samples: T[], maxCount = 54): T[] {
  if (samples.length <= maxCount) return [...samples];
  const result: T[] = [];
  const step = (samples.length - 1) / (maxCount - 1);
  for (let i = 0; i < maxCount; i++) {
    const index = Math.min(samples.length - 1, Math.round(i * step));
    result.push(samples[index]);
  }
  return result;
}

/**
 * Builds contact sheets from frame samples:
 * - Up to 54 frames
 * - Max 6 contact sheets of 3x3 grids (at most 9 frames per sheet)
 * - Max tile dimension 360 px (preserving aspect ratio)
 * - Timestamp drawn top-left on dark rounded box (white bold 20 px)
 * - JPEG quality 0.7
 */
export async function generateContactSheets(
  samples: FrameSample[],
  maxFrames = 54
): Promise<ContactSheetResult[]> {
  if (!samples || samples.length === 0) return [];

  // Pick up to 54 frames
  const selected = selectEquallySpacedSamples(samples, maxFrames);

  // Group into chunks of up to 9 frames each (max 6 sheets)
  const chunkSize = 9;
  const chunks: FrameSample[][] = [];
  for (let i = 0; i < selected.length; i += chunkSize) {
    chunks.push(selected.slice(i, i + chunkSize));
  }

  // If running in environment without HTML Canvas (e.g. Node tests), fallback gracefully
  if (
    typeof window === 'undefined' ||
    typeof document === 'undefined' ||
    typeof document.createElement !== 'function'
  ) {
    const results: ContactSheetResult[] = [];
    for (let sIdx = 0; sIdx < chunks.length; sIdx++) {
      const chunk = chunks[sIdx];
      const fallbackBlob = chunk[0].jpeg;
      const base64 = await blobToBase64(fallbackBlob);
      results.push({
        blob: fallbackBlob,
        base64,
        frameCount: chunk.length,
        startSec: chunk[0].t,
        endSec: chunk[chunk.length - 1].t,
        sheetIndex: sIdx + 1,
        totalSheets: chunks.length,
      });
    }
    return results;
  }

  const results: ContactSheetResult[] = [];

  for (let sIdx = 0; sIdx < chunks.length; sIdx++) {
    const chunk = chunks[sIdx];
    const images = await Promise.all(chunk.map((c) => loadImageFromBlob(c.jpeg)));

    // Determine tile dimensions (max dimension 360px)
    const firstImg = images[0];
    const natW = firstImg.naturalWidth || firstImg.width || 320;
    const natH = firstImg.naturalHeight || firstImg.height || 180;

    let tileW = 360;
    let tileH = 202;

    if (natW >= natH) {
      tileW = 360;
      tileH = Math.max(1, Math.round(360 * (natH / natW)));
    } else {
      tileH = 360;
      tileW = Math.max(1, Math.round(360 * (natW / natH)));
    }

    const cols = 3;
    const rows = Math.min(3, Math.ceil(chunk.length / cols));

    const canvas = document.createElement('canvas');
    canvas.width = cols * tileW;
    canvas.height = rows * tileH;
    const ctx = canvas.getContext('2d');

    if (!ctx) {
      // Fallback if context creation fails
      const fallbackBlob = chunk[0].jpeg;
      const b64 = await blobToBase64(fallbackBlob);
      results.push({
        blob: fallbackBlob,
        base64: b64,
        frameCount: chunk.length,
        startSec: chunk[0].t,
        endSec: chunk[chunk.length - 1].t,
        sheetIndex: sIdx + 1,
        totalSheets: chunks.length,
      });
      continue;
    }

    // Fill background black
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (let i = 0; i < chunk.length; i++) {
      const sample = chunk[i];
      const img = images[i];
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = col * tileW;
      const y = row * tileH;

      // Draw frame tile
      ctx.drawImage(img, x, y, tileW, tileH);

      // Draw timestamp badge top-left: dark rounded rectangle + bold white 20px
      const timeText = `${sample.t.toFixed(1)}s`;
      ctx.font = 'bold 20px sans-serif';
      const textMetrics = ctx.measureText(timeText);
      const badgePaddingX = 8;
      const badgePaddingY = 5;
      const badgeW = textMetrics.width + badgePaddingX * 2;
      const badgeH = 28;
      const badgeX = x + 8;
      const badgeY = y + 8;

      ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
      drawRoundedRect(ctx, badgeX, badgeY, badgeW, badgeH, 5);
      ctx.fill();

      ctx.fillStyle = '#ffffff';
      ctx.textBaseline = 'middle';
      ctx.fillText(timeText, badgeX + badgePaddingX, badgeY + badgeH / 2);
    }

    const jpegBlob = await new Promise<Blob>((resolve) => {
      canvas.toBlob(
        (blob) => resolve(blob || chunk[0].jpeg),
        'image/jpeg',
        0.7
      );
    });

    const base64 = await blobToBase64(jpegBlob);

    results.push({
      blob: jpegBlob,
      base64,
      frameCount: chunk.length,
      startSec: chunk[0].t,
      endSec: chunk[chunk.length - 1].t,
      sheetIndex: sIdx + 1,
      totalSheets: chunks.length,
    });
  }

  return results;
}
