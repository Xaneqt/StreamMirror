// Unduh runtime Android: scrcpy-server 5.0.1 resmi + adb dari rilis scrcpy-win64 5.0.1.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, WORK, download, sha256, unzip } from './lib.mjs';

const VERSION = '5.0.1';
const RELEASE = `https://github.com/Genymobile/scrcpy/releases/download/v${VERSION}`;
const SERVER_SHA256 = '764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536';
const ZIP_SHA256 = 'b12a2c4ee8be317422451fc7dcf8ee20a71b5ea7ef9ad73ddd825a25316227a5';
const ADB_FILES = ['adb.exe', 'AdbWinApi.dll', 'AdbWinUsbApi.dll'];

/** Folder pertama (rekursif) di bawah `dir` yang berisi `file`. */
function findDirContaining(dir, file) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  if (entries.some((e) => e.isFile() && e.name.toLowerCase() === file.toLowerCase())) return dir;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = findDirContaining(path.join(dir, entry.name), file);
    if (found) return found;
  }
  return null;
}

await download(`${RELEASE}/scrcpy-server-v${VERSION}`, `${ROOT}/resources/scrcpy-server`, SERVER_SHA256);

const zip = `${WORK}/scrcpy-win64-v${VERSION}.zip`;
await download(`${RELEASE}/scrcpy-win64-v${VERSION}.zip`, zip, ZIP_SHA256);

const extracted = `${WORK}/scrcpy-win64`;
fs.rmSync(extracted, { recursive: true, force: true });
unzip(zip, extracted);

const source = findDirContaining(extracted, 'adb.exe');
if (!source) throw new Error(`adb.exe tidak ditemukan di hasil ekstrak ${zip}`);

const dest = `${ROOT}/resources/adb/win32`;
fs.mkdirSync(dest, { recursive: true });
for (const name of ADB_FILES) {
  const from = path.join(source, name);
  if (!fs.existsSync(from)) throw new Error(`${name} tidak ditemukan di ${source}`);
  const to = `${dest}/${name}`;
  // File yang sama dilewati: adb.exe yang sedang jalan tidak bisa ditimpa.
  if (fs.existsSync(to) && sha256(to) === sha256(from)) continue;
  fs.copyFileSync(from, to);
}

console.log(`Runtime Android siap: ${ROOT}/resources/scrcpy-server, ${dest}/`);
