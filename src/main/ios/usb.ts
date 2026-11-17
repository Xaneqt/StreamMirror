import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { promisify } from 'node:util';
import type { MediaEvent, OpResult, UsbIphoneInfo } from '../../shared/types';
import { usbRuntimeDir, userDataDir } from '../paths';
import { MediaBridgeServer } from './media-bridge';

const execFileAsync = promisify(execFile);
const DRIVER_STATES: readonly UsbIphoneInfo['driver'][] = ['ready', 'replug', 'missing'];
/** Batas tunggu helper memulihkan konfigurasi USB iPhone setelah `stop` sebelum di-kill. */
const STOP_TIMEOUT_MS = 30_000;
const helperPath = (): string => path.join(usbRuntimeDir(), 'iphone-usb.exe');

/** true jika runtime USB (iphone-usb.exe) sudah dibuild. */
export function usbRuntimeAvailable(): boolean {
  return fs.existsSync(helperPath());
}

/** Daftar iPhone yang tercolok USB menurut `iphone-usb.exe --list`. Gagal → []. */
export async function listUsbIphones(): Promise<Omit<UsbIphoneInfo, 'mirroring'>[]> {
  try {
    const { stdout } = await execFileAsync(helperPath(), ['--list'], {
      cwd: usbRuntimeDir(),
      timeout: 12_000,
      windowsHide: true,
    });
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return [];
    const result: Omit<UsbIphoneInfo, 'mirroring'>[] = [];
    for (const item of parsed as Record<string, unknown>[]) {
      if (typeof item?.serial !== 'string' || item.serial === '') continue;
      const driver = DRIVER_STATES.find((d) => d === item.driver) ?? 'missing';
      result.push({
        serial: item.serial,
        name: typeof item.name === 'string' && item.name !== '' ? item.name : 'iPhone',
        model: typeof item.model === 'string' ? item.model : '',
        osVersion: typeof item.osVersion === 'string' ? item.osVersion : '',
        driver,
      });
    }
    return result;
  } catch {
    return [];
  }
}

/**
 * Memasang (atau dengan `remove`, melepas) filter driver libusb0 untuk satu iPhone lewat
 * usb-driver.ps1 yang dijalankan elevated (satu prompt UAC). Tidak menyentuh settings.
 */
export async function setupUsbDriver(serial: string, remove: boolean): Promise<OpResult & { replug: boolean }> {
  if (!/^[0-9A-Fa-f-]{16,48}$/.test(serial)) return { ok: false, message: 'Serial iPhone tidak valid', replug: false };
  const script = path.join(usbRuntimeDir(), 'usb-driver.ps1');
  if (!fs.existsSync(script)) return { ok: false, message: 'Runtime USB belum dibuild (npm run build:usb)', replug: false };
  const resultFile = path.join(userDataDir(), 'usb-driver-result.json');
  fs.rmSync(resultFile, { force: true });

  // Isi -ArgumentList berada di string PowerShell berkutip tunggal: kutip tunggal digandakan.
  const inner = `-NoProfile -ExecutionPolicy Bypass -File "${script}" -Serial "${serial}" -Result "${resultFile}"${remove ? ' -Remove' : ''}`;
  const command = `Start-Process -FilePath powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '${inner.replaceAll("'", "''")}'`;
  try {
    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      timeout: 180_000,
      windowsHide: true,
    });
  } catch (error) {
    // UAC ditolak membuat Start-Process gagal; hasil ditentukan dari ada/tidaknya file hasil.
    console.warn('[ios-usb] usb-driver.ps1:', error instanceof Error ? error.message : error);
  }

  let text: string;
  try {
    text = fs.readFileSync(resultFile, 'utf8');
  } catch {
    return { ok: false, message: 'Dibatalkan', replug: false };
  }
  try {
    const parsed = JSON.parse(text.replace(/^\uFEFF/, '')) as { ok?: unknown; message?: unknown; replug?: unknown };
    return {
      ok: parsed.ok === true,
      message: typeof parsed.message === 'string' ? parsed.message : '',
      replug: parsed.replug === true,
    };
  } catch {
    return { ok: false, message: 'Hasil setup driver USB tidak bisa dibaca', replug: false };
  }
}

/** Sesi capture QuickTime USB satu iPhone. Event: 'media' (MediaEvent), 'closed' (reason: string). */
export class UsbIphoneSession extends EventEmitter {
  private readonly bridge = new MediaBridgeServer();
  private child: ChildProcess | null = null;
  private exited: Promise<void> = Promise.resolve();
  private lastStderr = '';
  private closed = false;
  private stopping: Promise<void> | null = null;

  constructor(private readonly serial: string) {
    super();
    this.bridge.on('media', (ev: MediaEvent) => this.emit('media', ev));
    this.bridge.on('error', (error: unknown) =>
      console.error(`[ios-usb ${serial}] bridge:`, error instanceof Error ? error.message : error),
    );
  }

  async start(): Promise<void> {
    const exe = helperPath();
    if (!fs.existsSync(exe)) throw new Error('Runtime USB belum dibuild (npm run build:usb)');
    const port = await this.bridge.listen();
    if (this.stopping) throw new Error('Dibatalkan');
    const logs = path.join(userDataDir(), 'logs');
    fs.mkdirSync(logs, { recursive: true });

    const child = spawn(exe, ['--capture', this.serial], {
      cwd: usbRuntimeDir(),
      env: {
        ...process.env,
        MIRRORLAB_MEDIA_PORT: String(port),
        IPHONE_MIRROR_LOG_FILE: path.join(logs, 'iphone-usb.log'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    try {
      await once(child, 'spawn');
    } catch (error) {
      this.closed = true;
      this.bridge.close();
      throw new Error(`Gagal menjalankan iphone-usb.exe: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.child = child;
    const prefix = `[ios-usb ${this.serial}]`;
    child.on('error', (error) => console.error(prefix, error.message));
    // Menulis `stop` setelah helper keluar tidak boleh membuat main process crash (EPIPE).
    child.stdin?.on('error', () => undefined);
    if (child.stdout) readline.createInterface({ input: child.stdout }).on('line', (line) => console.log(`${prefix} ${line}`));
    if (child.stderr) {
      readline.createInterface({ input: child.stderr }).on('line', (line) => {
        console.warn(`${prefix} ${line}`);
        if (line.trim() !== '') this.lastStderr = line.trim();
      });
    }
    // 'close' (bukan 'exit'): stdout/stderr sudah habis dibaca, jadi baris stderr terakhir lengkap.
    child.once('close', (code) => {
      console.log(`${prefix} helper keluar (kode ${code ?? '-'})`);
      this.bridge.close();
      if (!this.closed) {
        this.closed = true;
        this.emit('closed', this.lastStderr || 'USB capture berhenti');
      }
    });
    this.exited = once(child, 'close').then(() => undefined);
  }

  /** Idempoten. Lewat `stop` di stdin supaya helper mengembalikan iPhone ke konfigurasi USB normal. */
  stop(): Promise<void> {
    this.stopping ??= (async () => {
      const child = this.child;
      if (child && child.exitCode === null && child.signalCode === null) {
        child.stdin?.end('stop\n');
        const timer = setTimeout(() => child.kill(), STOP_TIMEOUT_MS);
        await this.exited;
        clearTimeout(timer);
      }
      this.bridge.close();
    })();
    return this.stopping;
  }
}
