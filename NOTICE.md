# StreamMirror — komponen pihak ketiga

Aplikasi ini (kode di `src/`) memanggil program-program berikut sebagai proses terpisah atau membundel binernya tanpa modifikasi, kecuali disebutkan lain.

| Komponen | Versi / commit | Lisensi | Lokasi di bundel | Sumber |
|---|---|---|---|---|
| scrcpy-server | v5.0.1 (SHA-256 `764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536`) | Apache-2.0 | `resources/scrcpy-server` | https://github.com/Genymobile/scrcpy |
| Android Debug Bridge (`adb.exe`, `AdbWinApi.dll`, `AdbWinUsbApi.dll`) | dari `scrcpy-win64-v5.0.1.zip` (SHA-256 `b12a2c4ee8be317422451fc7dcf8ee20a71b5ea7ef9ad73ddd825a25316227a5`) | Apache-2.0 | `resources/adb/win32/` | https://developer.android.com/tools/adb |
| UxPlay (penerima AirPlay) + patch `mirrorlab.patch` | v1.73.7, commit `df67c212a433cf6dda3676dd40c097900d24e645` | GPL-3.0-or-later | `resources/airplay/win32/uxplay.exe`; source + patch di `resources/airplay/source/` | https://github.com/FDH2/UxPlay |
| GStreamer, FFmpeg, OpenSSL, libplist, dan runtime MinGW (paket MSYS2 UCRT64, tidak dimodifikasi) | lihat `resources/airplay/source/msys2-packages.txt` | lihat `resources/airplay/source/licenses/` | `resources/airplay/win32/` | https://packages.msys2.org |
| iPhoneMirror (protokol + transport USB QuickTime) | commit `31acd8a78e7038d46c7e1a6ee987b9035cf36dde` | GPL-3.0 | `resources/usb/win32/iphone-usb.exe`, `iPhoneMirror.UsbConfigurationSwitch.exe`; source di `resources/usb/source/` | https://github.com/RayrenSX/iPhoneMirror |
| `native/iphone-usb.cpp`, `native/mirrorlab_bridge.h`, `native/usb-driver.ps1` (yang terakhir dimodifikasi: hash 1.4.0.2 + rollback) | Mirrorlab commit `40fe5e1dc42395a5760eeae5a0f600bf5e8810c9` | GPL-3.0-or-later | `resources/usb/win32/`, `resources/usb/source/` | https://github.com/SimonDaBoss/mirrorlab |
| libusb-win32 (`libusb0.sys`, `libusb0.dll`, `install-filter.exe`) | 1.4.0.2 (zip SHA-256 `00004c92cdb99be36e17fb2377165eb97e63b48ba895bfc04a642ea9c3e26d94`) | driver GPL, library LGPL | `resources/usb/win32/`; lisensi di `resources/usb/source/libusb-win32/` | https://github.com/mcuee/libusb-win32 |
| Script build yang di-port (`scripts/prepare-airplay.mjs`, `scripts/build-usb.mjs`) | Mirrorlab commit `40fe5e1dc42395a5760eeae5a0f600bf5e8810c9` | Apache-2.0 | tidak dibundel | https://github.com/SimonDaBoss/mirrorlab |

`uxplay.exe` dan `iphone-usb.exe` adalah program GPL yang berdiri sendiri; aplikasi berkomunikasi dengannya lewat TCP/UDP localhost. Jika bundel ini dibagikan ke orang lain, folder `resources/airplay/source/` dan `resources/usb/source/` wajib ikut disertakan.

Teks lisensi untuk file pihak ketiga yang ada di repo ini: `LICENSES/GPL-3.0-or-later.txt` (berlaku untuk `native/iphone-usb.cpp`, `native/mirrorlab_bridge.h`, `native/usb-driver.ps1`) dan `LICENSES/Apache-2.0.txt` (berlaku untuk bagian `scripts/prepare-airplay.mjs` dan `scripts/build-usb.mjs` yang di-port dari Mirrorlab).
