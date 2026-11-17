import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import type { OpResult } from '../shared/types';
import { adbPath } from './paths';

export interface AdbResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Menjalankan adb (argv, tanpa shell). Tidak pernah reject: gagal spawn / timeout → code -1, pesan di stderr. */
export function adb(args: string[], timeoutMs = 15000): Promise<AdbResult> {
  return new Promise((resolve) => {
    execFile(
      adbPath(),
      args,
      { windowsHide: true, timeout: timeoutMs, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stdout, stderr });
        } else if (typeof error.code === 'number' && !error.killed) {
          resolve({ code: error.code, stdout, stderr });
        } else {
          const reason = error.killed ? `adb ${args.join(' ')}: timeout ${timeoutMs} ms` : error.message;
          resolve({ code: -1, stdout, stderr: stderr ? `${stderr}\n${reason}` : reason });
        }
      },
    );
  });
}

/** Output adb yang paling informatif untuk ditampilkan ke user. */
function outputText(r: AdbResult): string {
  return `${r.stdout}\n${r.stderr}`.trim().split(/\r?\n/).filter(Boolean).join(' ') || `kode ${r.code}`;
}

/** `adb start-server`; true jika daemon baru dijalankan oleh panggilan ini. */
export async function startServer(): Promise<boolean> {
  const r = await adb(['start-server']);
  return `${r.stdout}\n${r.stderr}`.includes('daemon started successfully');
}

/** Parse `adb devices -l`. Gagal → []. */
export async function listDevices(): Promise<{ serial: string; state: string; model: string; wireless: boolean }[]> {
  const r = await adb(['devices', '-l']);
  if (r.code !== 0) return [];
  const devices: { serial: string; state: string; model: string; wireless: boolean }[] = [];
  for (const raw of r.stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('List of devices') || line.startsWith('*')) continue;
    const [serial, state, ...kv] = line.split(/\s+/);
    if (!serial || !state) continue;
    const model = kv.find((t) => t.startsWith('model:'))?.slice('model:'.length).replaceAll('_', ' ') || serial;
    devices.push({
      serial,
      state,
      model,
      wireless: serial.includes(':') || serial.includes('_adb-tls-connect._tcp'),
    });
  }
  return devices;
}

export async function pair(address: string, code: string): Promise<OpResult> {
  const r = await adb(['pair', address, code], 30000);
  return r.stdout.includes('Successfully paired')
    ? { ok: true, message: `Pairing berhasil: ${outputText(r)}` }
    : { ok: false, message: `Pairing gagal: ${outputText(r)}` };
}

export async function connect(address: string): Promise<OpResult> {
  const r = await adb(['connect', address], 20000);
  return /connected to|already connected/.test(r.stdout)
    ? { ok: true, message: `Terhubung: ${outputText(r)}` }
    : { ok: false, message: `Connect gagal: ${outputText(r)}` };
}

export async function disconnect(address: string): Promise<OpResult> {
  const r = await adb(['disconnect', address], 10000);
  return r.code === 0
    ? { ok: true, message: `Terputus: ${outputText(r)}` }
    : { ok: false, message: `Disconnect gagal: ${outputText(r)}` };
}

/** Mengalihkan device USB ke adb over Wi-Fi (`tcpip 5555`) lalu connect ke IP wlan0-nya. */
export async function goWireless(serial: string): Promise<OpResult> {
  const ipInfo = await adb(['-s', serial, 'shell', 'ip', '-f', 'inet', 'addr', 'show', 'wlan0']);
  const ip = /inet (\d+\.\d+\.\d+\.\d+)/.exec(ipInfo.stdout)?.[1];
  if (!ip) return { ok: false, message: 'HP tidak terhubung ke Wi-Fi' };

  const tcpip = await adb(['-s', serial, 'tcpip', '5555']);
  if (tcpip.code !== 0) return { ok: false, message: `Gagal mengaktifkan mode wireless: ${outputText(tcpip)}` };

  await delay(1000);
  let result: OpResult = { ok: false, message: `Connect gagal: ${ip}:5555` };
  for (let attempt = 0; attempt < 10; attempt++) {
    if (attempt > 0) await delay(500);
    result = await connect(`${ip}:5555`);
    if (result.ok) break;
  }
  return result;
}
