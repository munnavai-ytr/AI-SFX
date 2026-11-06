export interface VideoProbeResult {
  duration: number;
  width: number;
  height: number;
  thumbnailDataUrl: string;
}

export const MAX_FILE_SIZE_BYTES = 150 * 1024 * 1024; // 150 MB
export const MAX_DURATION_SECONDS = 120; // 120 seconds

/**
 * Validates file size before processing.
 */
export function validateVideoFileSize(file: File | Blob): void {
  if (file.size > MAX_FILE_SIZE_BYTES) {
    const actualMb = (file.size / (1024 * 1024)).toFixed(1);
    throw new Error(`Video file size (${actualMb} MB) exceeds the 150 MB limit.`);
  }
}

/**
 * Probes video metadata using a hidden HTML5 video element.
 * Extracts duration, resolution, and draws a clean frame at ~10% timestamp.
 */
export async function probeVideoFile(file: File | Blob): Promise<VideoProbeResult> {
  validateVideoFileSize(file);

  return new Promise((resolve, reject) => {
    const tempUrl = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;

    let cleanupDone = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (cleanupDone) return;
      cleanupDone = true;
      if (timeoutId) clearTimeout(timeoutId);
      video.pause();
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(tempUrl);
    };

    // Timeout failsafe after 20 seconds
    timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error('Video probing timed out. Please check if the video format is supported.'));
    }, 20000);

    video.onerror = () => {
      const err = video.error;
      cleanup();
      reject(new Error(`Failed to load video: ${err?.message || 'Unsupported format or corrupted file'}`));
    };

    video.onloadedmetadata = () => {
      const duration = video.duration;
      const width = video.videoWidth || 0;
      const height = video.videoHeight || 0;

      if (!duration || isNaN(duration)) {
        cleanup();
        reject(new Error('Unable to determine video duration.'));
        return;
      }

      if (duration > MAX_DURATION_SECONDS) {
        cleanup();
        reject(new Error(`Video duration (${duration.toFixed(1)}s) exceeds the 120-second limit.`));
        return;
      }

      // Seek to ~10% of duration (or at least 0.1s, max duration - 0.1s)
      const seekTarget = Math.min(Math.max(duration * 0.1, 0.05), Math.max(duration - 0.05, 0.05));

      const captureFrame = () => {
        try {
          // Verify that readyState >= 2 (HAVE_CURRENT_DATA or higher)
          if (video.readyState < 2) {
            // Wait slightly for frame decoding if needed
            video.addEventListener('canplay', () => captureFrame(), { once: true });
            return;
          }

          const canvas = document.createElement('canvas');
          const maxThumbWidth = 480;
          const scale = width > 0 ? Math.min(maxThumbWidth / width, 1) : 1;
          const targetWidth = Math.max(1, Math.round(width * scale));
          const targetHeight = Math.max(1, Math.round(height * scale));

          canvas.width = targetWidth;
          canvas.height = targetHeight;
          const ctx = canvas.getContext('2d');

          if (!ctx) {
            cleanup();
            reject(new Error('Failed to create canvas context for video thumbnail.'));
            return;
          }

          ctx.drawImage(video, 0, 0, targetWidth, targetHeight);
          const thumbnailDataUrl = canvas.toDataURL('image/jpeg', 0.82);

          cleanup();
          resolve({
            duration,
            width,
            height,
            thumbnailDataUrl,
          });
        } catch (captureErr) {
          cleanup();
          reject(new Error(`Failed to capture video thumbnail: ${(captureErr as Error).message}`));
        }
      };

      video.addEventListener('seeked', () => {
        captureFrame();
      }, { once: true });

      video.currentTime = seekTarget;
    };

    video.src = tempUrl;
  });
}
