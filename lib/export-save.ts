/**
 * Cross-platform saving and sharing helper for Step 5 Export.
 * Supports Web downloads and native Android Capacitor FileSystem / Share.
 */

import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { createFileChunks } from './ffmpeg-utils';

/**
 * Converts Uint8Array to base64 string safely.
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export interface SaveResult {
  savedPath: string;
  isNative: boolean;
  fileUri?: string;
}

/**
 * Saves exported video or audio file.
 */
export async function saveExportedFile(
  blob: Blob,
  fileName: string,
  onProgress?: (writtenBytes: number, totalBytes: number) => void
): Promise<SaveResult> {
  const isNative = Capacitor.isNativePlatform();

  if (!isNative) {
    // Web download
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);

    onProgress?.(blob.size, blob.size);
    return {
      savedPath: `Browser Downloads/${fileName}`,
      isNative: false,
    };
  }

  // Capacitor Native FileSystem Saving (Chunked 3MB writes)
  const arrayBuffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  const chunks = createFileChunks(bytes, 3 * 1024 * 1024);
  const dirName = 'SFX AI';
  const relativePath = `${dirName}/${fileName}`;

  try {
    // Ensure directory exists in Documents
    try {
      await Filesystem.mkdir({
        path: dirName,
        directory: Directory.Documents,
        recursive: true,
      });
    } catch {
      // Directory may already exist
    }

    let written = 0;
    for (let i = 0; i < chunks.length; i++) {
      const b64Data = uint8ArrayToBase64(chunks[i]);

      if (i === 0) {
        await Filesystem.writeFile({
          path: relativePath,
          data: b64Data,
          directory: Directory.Documents,
        });
      } else {
        await Filesystem.appendFile({
          path: relativePath,
          data: b64Data,
          directory: Directory.Documents,
        });
      }

      written += chunks[i].length;
      onProgress?.(written, bytes.length);
    }

    const uriResult = await Filesystem.getUri({
      path: relativePath,
      directory: Directory.Documents,
    });

    return {
      savedPath: uriResult.uri,
      isNative: true,
      fileUri: uriResult.uri,
    };
  } catch (err) {
    console.error('Filesystem write error:', err);
    throw new Error(`Failed to save file to Documents: ${(err as Error).message}`);
  }
}

/**
 * Shares saved file using Capacitor Share sheet on mobile, or Web Share API.
 */
export async function shareExportedFile(
  blob: Blob,
  fileName: string,
  fileUri?: string
): Promise<void> {
  const isNative = Capacitor.isNativePlatform();

  if (isNative && fileUri) {
    await Share.share({
      title: fileName,
      text: `Exported video created with SFX AI`,
      url: fileUri,
      dialogTitle: 'Share exported video',
    });
    return;
  }

  // Web fallback share or download
  const file = new File([blob], fileName, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    await navigator.share({
      files: [file],
      title: fileName,
      text: 'Exported video with SFX AI',
    });
  } else {
    await saveExportedFile(blob, fileName);
  }
}
