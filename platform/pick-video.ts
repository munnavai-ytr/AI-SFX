/**
 * Platform video picker abstraction.
 * On Web, uses a hidden <input type="file" accept="video/*">.
 * Native Android picker can be swapped in here in future steps.
 */
export async function pickVideo(): Promise<File | null> {
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

    // Fallback if user cancels file dialog on some browsers
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
