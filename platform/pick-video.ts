/**
 * Platform video picker abstraction.
 * On Native Android (Capacitor), uses @capawesome/capacitor-file-picker FilePicker.pickVideos().
 * On Web, uses a hidden <input type="file" accept="video/*">.
 */
import { Capacitor } from '@capacitor/core';
import { FilePicker } from '@capawesome/capacitor-file-picker';

export async function pickVideo(): Promise<File | null> {
  const isNative = typeof window !== 'undefined' && Capacitor.isNativePlatform();

  if (isNative) {
    try {
      const result = await FilePicker.pickVideos({
        limit: 1,
        readData: false,
      });

      if (!result.files || result.files.length === 0) {
        return null;
      }

      const picked = result.files[0];
      const fileName = picked.name || 'imported-video.mp4';
      const mimeType = picked.mimeType || 'video/mp4';

      if (picked.blob) {
        return new File([picked.blob], fileName, { type: mimeType });
      }

      if (picked.path) {
        const webUrl = Capacitor.convertFileSrc(picked.path);
        const res = await fetch(webUrl);
        const blob = await res.blob();
        return new File([blob], fileName, { type: mimeType });
      }

      return null;
    } catch (err) {
      console.error('Native FilePicker error:', err);
      return null;
    }
  }

  // Web File Input Fallback
  return new Promise((resolve) => {
    if (typeof document === 'undefined') {
      resolve(null);
      return;
    }

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'video/*';
    input.style.position = 'fixed';
    input.style.top = '-9999px';
    input.style.left = '-9999px';
    input.style.opacity = '0';
    document.body.appendChild(input);

    let resolved = false;

    const cleanup = () => {
      window.removeEventListener('focus', onFocusCheck);
      if (input.parentNode) {
        input.parentNode.removeChild(input);
      }
    };

    const onChange = () => {
      if (resolved) return;
      resolved = true;
      const file = input.files && input.files.length > 0 ? input.files[0] : null;
      cleanup();
      resolve(file);
    };

    const onFocusCheck = () => {
      setTimeout(() => {
        if (!resolved) {
          if (input.files && input.files.length > 0) {
            onChange();
          } else {
            resolved = true;
            cleanup();
            resolve(null);
          }
        }
      }, 500);
    };

    input.addEventListener('change', onChange, { once: true });
    window.addEventListener('focus', onFocusCheck, { once: true });

    input.click();
  });
}
