// Port dari SimonDaBoss/mirrorlab@40fe5e1dc42395a5760eeae5a0f600bf5e8810c9 scripts/prepare-airplay.mjs (Apache-2.0).
// Build ulang UxPlay yang di-pin sebagai penerima mandiri, lalu kumpulkan hanya dependency runtime-nya.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { MSYS, ROOT, WORK, download, msysBash, run } from './lib.mjs';

const bin = `${MSYS}/ucrt64/bin`;
const source = `${WORK}/UxPlay`;
const build = `${WORK}/uxplay-build`;
const sdk = `${WORK}/bonjour-sdk`;
const runtime = `${ROOT}/resources/airplay/win32`;
const legal = `${ROOT}/resources/airplay/source`;
const bridgeHeader = `${ROOT}/native/mirrorlab_bridge.h`;
const commit = 'df67c212a433cf6dda3676dd40c097900d24e645'; // UxPlay v1.73.7
const patchedFiles = ['lib/fairplay_playfair.c', 'uxplay.cpp'];

function imports(file) {
  const b = fs.readFileSync(file);
  const pe = b.readUInt32LE(0x3c), count = b.readUInt16LE(pe + 6), optionalSize = b.readUInt16LE(pe + 20), optional = pe + 24;
  const directory = optional + (b.readUInt16LE(optional) === 0x20b ? 112 : 96);
  const offset = (rva) => {
    for (let i = 0; i < count; i++) {
      const s = optional + optionalSize + i * 40, start = b.readUInt32LE(s + 12);
      if (rva >= start && rva < start + Math.max(b.readUInt32LE(s + 8), b.readUInt32LE(s + 16))) return b.readUInt32LE(s + 20) + rva - start;
    }
    throw new Error(`Bad PE import address: ${file}`);
  };
  const table = b.readUInt32LE(directory + 8);
  if (!table) return [];
  let at = offset(table);
  const names = [];
  while (b.readUInt32LE(at + 12)) {
    const str = offset(b.readUInt32LE(at + 12));
    names.push(b.subarray(str, b.indexOf(0, str)).toString('ascii'));
    at += 20;
  }
  return names;
}

/**
 * Ganti tiap anchor (wajib ada tepat sekali) dengan teks penggantinya. Anchor tidak ketemu atau file tidak berubah →
 * throw: build tetap akan sukses tanpa patch, tapi video tidak pernah keluar.
 */
function patch(relative, edits) {
  const file = `${source}/${relative}`;
  const original = fs.readFileSync(file, 'utf8');
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  let text = original;
  for (const [anchor, replacement] of edits) {
    const found = text.split(anchor).length - 1;
    if (found !== 1) throw new Error(`Anchor patch ditemukan ${found}× (harus tepat 1×) di ${relative}: ${anchor}`);
    text = text.replace(anchor, () => replacement.replaceAll('\n', eol));
  }
  if (text === original) throw new Error(`Patch tidak mengubah ${relative}`);
  fs.writeFileSync(file, text);
}

fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(runtime, { recursive: true });
if (!fs.existsSync(`${source}/.git`)) run('git', ['clone', 'https://github.com/FDH2/UxPlay.git', source]);
run('git', ['-C', source, 'fetch', '--depth', '1', 'origin', commit]);
// Jangan buang perubahan lain di salinan source native milik developer.
const dirty = execFileSync('git', ['-C', source, 'diff', '--name-only'], { encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean);
if (dirty.some((f) => !patchedFiles.includes(f))) throw new Error('Source native berisi perubahan lokal lain');
// Patch dari run sebelumnya dikembalikan dulu supaya tiap anchor diterapkan tepat sekali.
run('git', ['-C', source, 'checkout', '--', ...patchedFiles]);
run('git', ['-C', source, 'checkout', commit]);

fs.copyFileSync(bridgeHeader, `${source}/mirrorlab_bridge.h`);
patch('uxplay.cpp', [
  ['    std::vector<char> server_hw_addr;', '    setvbuf(stdout, NULL, _IONBF, 0); // Mirrorlab: immediate process events\n    std::vector<char> server_hw_addr;'],
  ['    if (open_connections == 0) {', '    if (open_connections == 0) {\n        printf("MIRRORLAB_DISCONNECTED\\n");'],
  ['#include "lib/raop.h"', '#include "mirrorlab_bridge.h"\n#include "lib/raop.h"'],
  [
    'extern "C" void video_process (void *cls, raop_ntp_t *ntp, video_decode_struct *data) {',
    'extern "C" void video_process (void *cls, raop_ntp_t *ntp, video_decode_struct *data) {\n    if (mirrorlab_bridge_enabled()) {\n        mirrorlab_send_media(1, 0, data->ntp_time_remote / 1000, data->data, data->data_len);\n        return;\n    }',
  ],
]);
patch('lib/fairplay_playfair.c', [['    int mode = req[14];', '    int mode = req[14];\n    if (mode < 0 || mode > 3) return -1;']]);
const changed = execFileSync('git', ['-C', source, 'diff', '--name-only'], { encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean).sort();
if (changed.join('\n') !== patchedFiles.join('\n')) {
  throw new Error(`git diff UxPlay harus tepat ${patchedFiles.join(', ')}; didapat: ${changed.join(', ') || '(kosong)'}`);
}

// dnssd.lib hanya untuk memenuhi CMake UxPlay; dibuat dari native/dnssd.def sehingga build tidak
// butuh Bonjour terpasang (mis. di GitHub Actions). Saat jalan dnssd.dll dimuat dari Bonjour Service.
for (const d of ['Lib/x64', 'Include']) fs.mkdirSync(`${sdk}/${d}`, { recursive: true });
// Header ikut dibundel bersama source native supaya rebuild offline tetap bisa.
await download('https://raw.githubusercontent.com/apple-oss-distributions/mDNSResponder/main/mDNSShared/dns_sd.h', `${sdk}/Include/dns_sd.h`);
const env = { ...process.env, MSYSTEM: 'UCRT64', CHERE_INVOKING: '1', BONJOUR_SDK_HOME: sdk };
run(`${bin}/dlltool.exe`, ['-d', `${ROOT}/native/dnssd.def`, '-l', 'dnssd.lib'], { cwd: `${sdk}/Lib/x64`, env });
msysBash(`cmake -S ${source} -B ${build} -G Ninja -DNO_MARCH_NATIVE=ON -DCMAKE_BUILD_TYPE=Release && cmake --build ${build} -j 8`, {
  env: { BONJOUR_SDK_HOME: sdk },
});

const seeds = [
  [`${build}/uxplay.exe`, 'uxplay.exe'],
  [`${bin}/gst-launch-1.0.exe`, 'gst-launch-1.0.exe'],
  [`${bin}/gst-inspect-1.0.exe`, 'gst-inspect-1.0.exe'],
];
const plugins = ['app', 'coreelements', 'playback', 'autodetect', 'typefindfunctions', 'videoparsersbad', 'rtp', 'udp', 'audioconvert', 'audioresample', 'volume', 'libav', 'fdkaac', 'videoconvertscale', 'jpeg', 'imagefreeze', 'pango', 'audiotestsrc'];
for (const p of plugins) seeds.push([`${MSYS}/ucrt64/lib/gstreamer-1.0/libgst${p}.dll`, `lib/gstreamer-1.0/libgst${p}.dll`]);
const done = new Set();
for (let i = 0; i < seeds.length; i++) {
  const [file, relative] = seeds[i];
  if (done.has(relative.toLowerCase())) continue;
  done.add(relative.toLowerCase());
  const target = path.join(runtime, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(file, target);
  for (const name of imports(file)) {
    const dep = path.join(bin, name);
    if (fs.existsSync(dep)) seeds.push([dep, name]);
  }
}

// Source lengkap + patch lokal, lisensi, dan versi dependency ikut bersama penerima mandiri ini.
fs.mkdirSync(legal, { recursive: true });
fs.copyFileSync(`${source}/LICENSE`, path.join(legal, 'UXPLAY-GPL-3.0.txt'));
fs.copyFileSync(`${source}/lib/playfair/LICENSE.md`, path.join(legal, 'PLAYFAIR-LICENSE.txt'));
fs.copyFileSync(bridgeHeader, path.join(legal, 'mirrorlab_bridge.h'));
fs.writeFileSync(path.join(legal, 'mirrorlab.patch'), execFileSync('git', ['-C', source, 'diff'], { encoding: 'utf8' }));
run('git', ['-C', source, 'archive', '--format=tar.gz', `--output=${path.join(legal, 'uxplay-source.tar.gz')}`, commit]);
fs.copyFileSync(`${sdk}/Include/dns_sd.h`, path.join(legal, 'dns_sd.h'));
fs.cpSync(`${MSYS}/ucrt64/share/licenses`, path.join(legal, 'licenses'), { recursive: true });
fs.writeFileSync(path.join(legal, 'msys2-packages.txt'), msysBash('pacman -Q', { encoding: 'utf8' }));
fs.writeFileSync(
  path.join(legal, 'README.txt'),
  `UxPlay ${commit} (v1.73.7), https://github.com/FDH2/UxPlay\n` +
    'patch: mirrorlab.patch (terapkan ke uxplay-source.tar.gz). Build: npm run build:airplay.\n' +
    'Lisensi: GPL-3.0-or-later, program terpisah; StreamMirror berkomunikasi dengannya lewat TCP localhost berbingkai (video) dan RTP (audio).\n' +
    'Client Bonjour (dnssd.dll) memakai Bonjour Service Windows yang sudah terpasang; tidak ikut dibundel.\n' +
    'Source Apple mDNSResponder (dns_sd.h): https://github.com/apple-oss-distributions/mDNSResponder\n' +
    'Dependency runtime adalah paket MSYS2 UCRT64 tanpa modifikasi, tercantum di msys2-packages.txt.\n' +
    'Resep source paket: https://github.com/msys2/MINGW-packages\n' +
    'Arsip source: https://repo.msys2.org/mingw/sources/\n' +
    'Tiap resep paket mencantumkan URL source upstream dan checksum-nya. Lisensi ada di licenses/.\n',
);
fs.writeFileSync(path.join(runtime, 'manifest.json'), JSON.stringify({ uxplay: commit, files: [...done].sort(), builtAt: new Date().toISOString() }, null, 2));
console.log(`UxPlay dan ${done.size} file runtime dibundel di ${runtime}`);
