/**
 * FFmpeg helper utilities and container validation for Step 5 Export.
 */

const SUPPORTED_EXTENSIONS = ['.mp4', '.m4v', '.mov'];

/**
 * Checks if a filename or MIME type uses a supported container for lossless video stream copying.
 */
export function isSupportedContainer(filenameOrMime: string): boolean {
  if (!filenameOrMime) return false;
  const lower = filenameOrMime.toLowerCase();

  if (lower.includes('video/mp4') || lower.includes('video/quicktime')) {
    return true;
  }

  return SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Message returned when an unsupported container format is passed to export.
 */
export function getUnsupportedMessage(): string {
  return "This format can't be exported without re-encoding. Convert the video to MP4 first.";
}

/**
 * Builds the exact FFmpeg command array for lossless video copy and AAC audio muxing.
 */
export function buildFFmpegArgs(): string[] {
  return [
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
  ];
}

/**
 * Sanitizes original filename into `<original-base>-sfx.mp4`.
 */
export function sanitizeFileName(originalName: string): string {
  if (!originalName) return 'video-sfx.mp4';
  const cleanName = originalName.replace(/\.[^/.]+$/, '');
  const safeBase = cleanName.replace(/[^a-zA-Z0-9_\-]/g, '_');
  return `${safeBase}-sfx.mp4`;
}

/**
 * Splits a Uint8Array into chunks of chunkSize (default 3 MB).
 */
export function createFileChunks(
  bytes: Uint8Array,
  chunkSize = 3 * 1024 * 1024
): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const end = Math.min(bytes.length, offset + chunkSize);
    chunks.push(bytes.subarray(offset, end));
    offset = end;
  }
  return chunks;
}

/**
 * Verifies that output duration is within tolerance (0.15s) of original duration.
 */
export function verifyDuration(originalDuration: number, outputDuration: number): boolean {
  return Math.abs(originalDuration - outputDuration) <= 0.15;
}
