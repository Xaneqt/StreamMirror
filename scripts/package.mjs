// Paket portable Windows x64 → dist/StreamMirror-win32-x64/. Jalankan lewat `npm run package`.
import fs from 'node:fs';
import path from 'node:path';
import { packager } from '@electron/packager';
import { ROOT } from './lib.mjs';

const required = ['resources/adb', 'resources/scrcpy-server'];
const optional = ['resources/airplay', 'resources/usb'];

for (const item of required) {
  if (!fs.existsSync(path.join(ROOT, item))) {
    throw new Error(`${item} tidak ada. Jalankan \`npm run fetch:android\` dulu.`);
  }
}
if (!fs.existsSync(path.join(ROOT, 'out/main/index.js'))) {
  throw new Error('out/main/index.js tidak ada. Jalankan `npm run build` dulu.');
}
const skipped = optional.filter((item) => !fs.existsSync(path.join(ROOT, item)));
if (skipped.length > 0) console.warn(`Tidak dibundel (belum dibuild): ${skipped.join(', ')}`);

const [appPath] = await packager({
  dir: ROOT,
  name: 'StreamMirror',
  icon: path.join(ROOT, 'assets/icon.ico'),
  platform: 'win32',
  arch: 'x64',
  out: path.join(ROOT, 'dist'),
  overwrite: true,
  asar: true,
  prune: true,
  ignore: [/^\/(src|test|scripts|native|resources|dist|assets|\.omp)($|\/)/],
  extraResource: [...required, ...optional]
    .filter((item) => !skipped.includes(item))
    .map((item) => path.join(ROOT, item)),
});
// Lisensi aplikasi + daftar komponen pihak ketiga ikut di bundel. Nama berbeda karena
// `LICENSE` di root bundel sudah dipakai lisensi Electron.
fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(appPath, 'LICENSE.StreamMirror.txt'));
fs.copyFileSync(path.join(ROOT, 'NOTICE.md'), path.join(appPath, 'NOTICE.md'));
console.log(`Paket siap: ${appPath}`);
