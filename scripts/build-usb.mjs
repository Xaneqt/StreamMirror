// Build host USB QuickTime (program GPL terpisah) dari source iPhoneMirror yang di-pin,
// plus payload driver libusb-win32 1.4.0.2 dari zip rilis resmi.
// Di-port dari scripts/build-usb.mjs mirrorlab (Apache-2.0).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { MSYS, ROOT, WORK, download, msysBash, run, unzip } from './lib.mjs';

const source = `${WORK}/iPhoneMirror`;
const commit = '31acd8a78e7038d46c7e1a6ee987b9035cf36dde';
const runtime = `${ROOT}/resources/usb/win32`;
const legal = `${ROOT}/resources/usb/source`;
const libusbZip = `${WORK}/libusb-win32-bin-1.4.0.2.zip`;
const libusbDir = `${WORK}/libusb-win32-bin-1.4.0.2`;

if (!fs.existsSync(`${ROOT}/native/mirrorlab_bridge.h`)) {
  throw new Error(`${ROOT}/native/mirrorlab_bridge.h tidak ada; header bridge wajib ada sebelum build USB.`);
}
if (!fs.existsSync(`${MSYS}/ucrt64/bin/g++.exe`)) {
  throw new Error(`${MSYS}/ucrt64/bin/g++.exe tidak ada; jalankan dulu node scripts/setup-msys.mjs.`);
}

fs.mkdirSync(runtime, { recursive: true });
fs.mkdirSync(legal, { recursive: true });
fs.mkdirSync(WORK, { recursive: true });

if (!fs.existsSync(`${source}/.git`)) run('git', ['clone', 'https://github.com/RayrenSX/iPhoneMirror.git', source]);
run('git', ['-C', source, 'fetch', '--depth', '1', 'origin', commit]);
if (execFileSync('git', ['-C', source, 'status', '--porcelain'], { encoding: 'utf8' }).trim()) {
  throw new Error(`Source USB upstream (${source}) punya perubahan lokal`);
}
run('git', ['-C', source, 'checkout', commit]);

// Driver libusb-win32 1.4.0.2 (1.2.6.0 tidak lolos Memory Integrity; 1.4.0.x memakai NX pool).
await download(
  'https://github.com/mcuee/libusb-win32/releases/download/release_1.4.0.2/libusb-win32-bin-1.4.0.2.zip',
  libusbZip,
  '00004c92cdb99be36e17fb2377165eb97e63b48ba895bfc04a642ea9c3e26d94',
);
fs.rmSync(libusbDir, { recursive: true, force: true });
unzip(libusbZip, libusbDir);
// Zip bisa berisi folder induk atau langsung isinya: cari folder yang memuat bin/amd64/libusb0.sys.
const libusbRoot = [libusbDir, ...fs.readdirSync(libusbDir, { recursive: true }).map((rel) => `${libusbDir}/${rel}`.replaceAll('\\', '/'))].find(
  (dir) => fs.existsSync(`${dir}/bin/amd64/libusb0.sys`),
);
if (!libusbRoot) throw new Error(`bin/amd64/libusb0.sys tidak ditemukan di ${libusbDir}`);

// Capture memakai backend filter per-device libusb-win32 (libusb0). UsbDk tidak dipakai:
// tabel pipe-nya hanya mencakup konfigurasi 1, sedangkan endpoint QuickTime ada di
// konfigurasi tersembunyi (5 pada iPhone saat ini).
const units = ['Protocol/Plist', 'Protocol/QuickTimePacket', 'Protocol/QuickTimeSession', 'Media/CoreMedia', 'Media/H264', 'Transport/QtUsbTransport', 'Transport/LibUsb0Transport', 'Transport/UsbMuxClient', 'Transport/Socket', 'Device/AppleUsbDiscovery', 'Logging'];
const cxx = 'g++ -std=c++20 -O2 -D_WIN32_WINNT=0x0A00 -DWIN32_LEAN_AND_MEAN -DNOMINMAX';
const command = [
  cxx,
  `-I '${ROOT}/native' -I ${source}/src/Core/src -I ${source}/third_party/libusb/include -I ${source}/third_party/libusb-win32/include`,
  `'${ROOT}/native/iphone-usb.cpp'`,
  ...units.map((u) => `${source}/src/Core/src/${u}.cpp`),
  `${source}/third_party/libusb/lib/x64/libusb-1.0.lib ${source}/third_party/libusb-win32/lib/x64/libusb0-dynamic.lib`,
  `-lws2_32 -lsetupapi -lcfgmgr32 -ladvapi32 -lbcrypt -lshell32 -o ${WORK}/iphone-usb.exe`,
  // Pengalih konfigurasi milik upstream memegang handle HP selama re-enumerasi ke mode
  // QuickTime. LibUsb0Transport menjalankannya berdasarkan nama.
  '&&',
  cxx,
  `-DUNICODE -D_UNICODE -municode -I ${source}/src/Core/src -I ${source}/third_party/libusb-win32/include ${source}/src/Core/tools/UsbConfigurationSwitch.cpp ${source}/src/Core/tools/UsbDeviceReconnect.cpp ${source}/third_party/libusb-win32/lib/x64/libusb0-dynamic.lib -lcfgmgr32 -lsetupapi -ladvapi32 -o ${WORK}/iPhoneMirror.UsbConfigurationSwitch.exe`,
].join(' ');
msysBash(command);

for (const [from, to] of [
  [`${WORK}/iphone-usb.exe`, 'iphone-usb.exe'],
  [`${WORK}/iPhoneMirror.UsbConfigurationSwitch.exe`, 'iPhoneMirror.UsbConfigurationSwitch.exe'],
  // Filter capture libusb-win32 1.4.0.2 bertanda tangan, dipasang per device oleh usb-driver.ps1.
  ...['libusb0.sys', 'libusb0.dll', 'install-filter.exe'].map((name) => [`${libusbRoot}/bin/amd64/${name}`, name]),
  [`${libusbRoot}/bin/x86/libusb0_x86.dll`, 'libusb0_x86.dll'],
  [`${source}/third_party/libusb/bin/x64/libusb-1.0.dll`, 'libusb-1.0.dll'],
  ...['libgcc_s_seh-1.dll', 'libstdc++-6.dll', 'libwinpthread-1.dll'].map((name) => [`${MSYS}/ucrt64/bin/${name}`, name]),
  [`${ROOT}/native/usb-driver.ps1`, 'usb-driver.ps1'],
]) fs.copyFileSync(from, path.join(runtime, to));

run('git', ['-C', source, 'archive', '--format=tar.gz', `--output=${legal}/iphonemirror-source.tar.gz`, commit]);
for (const name of ['iphone-usb.cpp', 'mirrorlab_bridge.h', 'usb-driver.ps1']) fs.copyFileSync(`${ROOT}/native/${name}`, `${legal}/${name}`);
fs.mkdirSync(`${legal}/libusb-win32`, { recursive: true });
for (const name of ['README.txt', 'COPYING_GPL.txt', 'COPYING_LGPL.txt']) fs.copyFileSync(`${libusbRoot}/${name}`, `${legal}/libusb-win32/${name}`);
fs.copyFileSync(`${ROOT}/scripts/build-usb.mjs`, `${legal}/build-usb.mjs`);
fs.writeFileSync(
  `${legal}/README.txt`,
  [
    'Host USB terpisah berlisensi GPL-3.0-or-later (iphone-usb.exe).',
    `Source iPhoneMirror: https://github.com/RayrenSX/iPhoneMirror commit ${commit}.`,
    'Source upstream tanpa perubahan, termasuk lisensinya, ada di iphonemirror-source.tar.gz; semua unit upstream, termasuk iPhoneMirror.UsbConfigurationSwitch.exe, dikompilasi tanpa perubahan. iphone-usb.cpp dan mirrorlab_bridge.h (GPL-3.0-or-later) berasal dari https://github.com/SimonDaBoss/mirrorlab commit 40fe5e1dc42395a5760eeae5a0f600bf5e8810c9. Build dari project StreamMirror: npm run build:usb (build-usb.mjs).',
    'Driver capture: libusb-win32 1.4.0.2 (libusb0.sys, libusb0.dll, libusb0_x86.dll, install-filter.exe) dari zip rilis resmi https://github.com/mcuee/libusb-win32/releases/download/release_1.4.0.2/libusb-win32-bin-1.4.0.2.zip (driver GPL, library LGPL; lisensi di folder libusb-win32). Filter hanya dipasang untuk satu iPhone saat pengguna memilih Pasang driver USB, lewat usb-driver.ps1 yang memverifikasi hash yang di-pin. Driver USB Apple dan usbccgp tidak diganti.',
    'Source dan lisensi runtime compiler menyertai resources/airplay/source.',
    '',
  ].join('\n'),
);
console.log('Host USB dan payload driver capture libusb0 1.4.0.2 siap.');
