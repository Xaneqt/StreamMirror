// Helper bersama untuk script di scripts/. Dijalankan dari root project (npm run …).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Root project (folder berisi package.json), slash maju. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..').replaceAll('\\', '/');

/**
 * Workspace build native. Di luar folder project karena path project mengandung spasi
 * dan MSYS2 tidak mendukung path berspasi. Default: <drive>:/mh-work.
 */
export const WORK = path
  .resolve(process.env.MH_WORK ?? path.join(path.parse(process.cwd()).root, 'mh-work'))
  .replaceAll('\\', '/');

export const MSYS = `${WORK}/msys64`;

/** bsdtar bawaan Windows: bisa zip. `tar` milik Git tidak bisa. */
export const SYSTEM_TAR = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');

export function run(file, args, opts = {}) {
  return execFileSync(file, args, { stdio: 'inherit', ...opts });
}

export function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Unduh `url` ke `file`. Dengan `hash` (SHA-256 hex): file yang sudah ada dan cocok dilewati,
 * file yang tidak cocok dihapus lalu diunduh ulang; hasil unduhan yang tidak cocok dihapus dan melempar.
 */
export async function download(url, file, hash) {
  const expected = hash?.toLowerCase();
  if (fs.existsSync(file)) {
    if (!expected || sha256(file) === expected) return;
    fs.rmSync(file, { force: true });
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  console.log(`Mengunduh ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Unduhan gagal (${response.status}): ${url}`);
  fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
  if (expected && sha256(file) !== expected) {
    const actual = sha256(file);
    fs.rmSync(file, { force: true });
    throw new Error(`SHA-256 tidak cocok untuk ${url}: ${actual} (seharusnya ${expected})`);
  }
}

/** Ekstrak zip ke `dest` (dibuat bila belum ada). */
export function unzip(zip, dest) {
  fs.mkdirSync(dest, { recursive: true });
  run(SYSTEM_TAR, ['-xf', zip, '-C', dest]);
}

/**
 * Jalankan perintah di shell MSYS2 UCRT64 (cwd dipertahankan). `ignoreExit` untuk
 * `pacman -Syu` pertama yang menutup shell saat runtime di-update.
 */
export function msysBash(command, { ignoreExit = false, env = {}, encoding } = {}) {
  const options = {
    stdio: encoding ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding,
    env: { ...process.env, MSYSTEM: 'UCRT64', CHERE_INVOKING: '1', ...env },
  };
  try {
    return execFileSync(`${MSYS}/usr/bin/bash.exe`, ['-lc', command], options);
  } catch (error) {
    if (!ignoreExit) throw error;
    return undefined;
  }
}
