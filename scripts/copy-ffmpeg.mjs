import fs from 'node:fs';
import path from 'node:path';

const srcCore = path.resolve('node_modules/@ffmpeg/core/dist/umd');
const srcFFmpeg = path.resolve('node_modules/@ffmpeg/ffmpeg/dist/umd');
const dest = path.resolve('public/ffmpeg');

if (!fs.existsSync(dest)) {
  fs.mkdirSync(dest, { recursive: true });
}

fs.copyFileSync(path.join(srcCore, 'ffmpeg-core.js'), path.join(dest, 'ffmpeg-core.js'));
fs.copyFileSync(path.join(srcCore, 'ffmpeg-core.wasm'), path.join(dest, 'ffmpeg-core.wasm'));

if (fs.existsSync(srcFFmpeg)) {
  const files = fs.readdirSync(srcFFmpeg);
  for (const file of files) {
    if (file.endsWith('.js')) {
      fs.copyFileSync(path.join(srcFFmpeg, file), path.join(dest, file));
    }
  }
}

console.log('FFmpeg files copied to public/ffmpeg successfully.');
