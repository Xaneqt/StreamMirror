// Menyiapkan MSYS2 UCRT64 (gcc, cmake, GStreamer, …) di ${WORK}/msys64 untuk build:airplay dan build:usb. Idempoten.
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import { MSYS, SYSTEM_TAR, WORK, download, msysBash, run } from './lib.mjs';

const RELEASE = 'https://github.com/msys2/msys2-installer/releases/latest/download';
const PACKAGES = [
  'mingw-w64-ucrt-x86_64-gcc',
  'mingw-w64-ucrt-x86_64-cmake',
  'mingw-w64-ucrt-x86_64-ninja',
  'mingw-w64-ucrt-x86_64-tools',
  'mingw-w64-ucrt-x86_64-pkgconf',
  'mingw-w64-ucrt-x86_64-openssl',
  'mingw-w64-ucrt-x86_64-libplist',
  'mingw-w64-ucrt-x86_64-gstreamer',
  'mingw-w64-ucrt-x86_64-gst-plugins-base',
  'mingw-w64-ucrt-x86_64-gst-plugins-good',
  'mingw-w64-ucrt-x86_64-gst-plugins-bad',
  'mingw-w64-ucrt-x86_64-gst-libav',
];

const bash = `${MSYS}/usr/bin/bash.exe`;

if (fs.existsSync(`${MSYS}/ucrt64/bin/gcc.exe`) && fs.existsSync(`${MSYS}/ucrt64/lib/gstreamer-1.0/libgstlibav.dll`)) {
  console.log(`MSYS2 sudah siap di ${MSYS}`);
  process.exit(0);
}

fs.mkdirSync(WORK, { recursive: true });

if (!fs.existsSync(bash)) {
  const sfx = `${WORK}/msys2-base.sfx.exe`;
  try {
    await download(`${RELEASE}/msys2-base-x86_64-latest.sfx.exe`, sfx);
    run(sfx, ['-y', `-o${WORK}`]);
  } catch (error) {
    console.warn(`Self-extractor MSYS2 gagal: ${error instanceof Error ? error.message : error}`);
  }
  if (!fs.existsSync(bash)) {
    // Cadangan: arsip .tar.zst, dekompres dengan zstd bawaan Node lalu ekstrak dengan tar.exe Windows (tanpa xz/zstd).
    console.log('Memakai arsip msys2-base .tar.zst sebagai cadangan');
    fs.rmSync(MSYS, { recursive: true, force: true });
    const zst = `${WORK}/msys2-base.tar.zst`;
    const tar = `${WORK}/msys2-base.tar`;
    await download(`${RELEASE}/msys2-base-x86_64-latest.tar.zst`, zst);
    await pipeline(fs.createReadStream(zst), zlib.createZstdDecompress(), fs.createWriteStream(tar));
    run(SYSTEM_TAR, ['-xf', tar, '-C', WORK]);
    fs.rmSync(tar, { force: true });
    if (!fs.existsSync(bash)) throw new Error(`MSYS2 tidak terpasang: ${bash} tidak ada`);
  }
}

// Update pertama memperbarui runtime MSYS2 dan menutup shell-nya sendiri; exit code diabaikan.
msysBash('pacman -Syu --noconfirm', { ignoreExit: true });
msysBash(`pacman -Syu --noconfirm && pacman -S --needed --noconfirm ${PACKAGES.join(' ')}`);
console.log(`MSYS2 UCRT64 siap di ${MSYS}`);
