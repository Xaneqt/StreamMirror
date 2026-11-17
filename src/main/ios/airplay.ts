import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { AirplayStatus, MediaEvent, Settings } from '../../shared/types';
import { airplayRuntimeDir, userDataDir } from '../paths';
import { MediaBridgeServer } from './media-bridge';
import { l16ToFloat32, parseRtp } from './rtp';

/**
 * Port TCP UxPlay diturunkan dari satu konstanta: argumen `-p tcp <base+1>,<base>,<base+2>`,
 * dan port `<base>` (server AirPlay) dipakai probe kesiapan. Port terpakai → ganti ke 7100.
 */
const AIRPLAY_BASE_PORT = 7000;
const TCP_PORTS = `${AIRPLAY_BASE_PORT + 1},${AIRPLAY_BASE_PORT},${AIRPLAY_BASE_PORT + 2}`;
const READY_TIMEOUT_MS = 15000;
const PROBE_INTERVAL_MS = 200;
const STOP_TIMEOUT_MS = 5000;
const LOG_LINES = 20;
const AUDIO_PAYLOAD_TYPE = 97;
const CONNECTION_RE = /^connection request from (.+?) \(([^)\r\n]*)\) with deviceID/;

/** true jika TCP connect ke 127.0.0.1:port berhasil. */
function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    const finish = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1000, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/**
 * Penerima AirPlay (UxPlay sebagai proses terpisah). Video lewat MediaBridgeServer (MLB1), audio lewat RTP L16 di UDP localhost.
 * Event: 'status' (AirplayStatus), 'connected' ({ deviceName: string | null }), 'media' (MediaEvent), 'disconnected'.
 */
export class AirplayReceiver extends EventEmitter {
  private current: AirplayStatus = { state: 'disabled', message: 'Penerima AirPlay belum dijalankan' };
  private chain: Promise<void> = Promise.resolve();
  /** Naik tiap stop; callback milik child lama membandingkan nilainya supaya tidak mengubah state baru. */
  private generation = 0;
  private child: ChildProcess | null = null;
  private bridge: MediaBridgeServer | null = null;
  private udp: dgram.Socket | null = null;
  private lines: string[] = [];
  private deviceName: string | null = null;
  private connected = false;

  constructor(private readonly getSettings: () => Settings['airplay']) {
    super();
  }

  get status(): AirplayStatus {
    return this.current;
  }

  /** Tidak pernah reject: kegagalan menjadi status `error` / `unavailable` / `disabled`. */
  start(): Promise<void> {
    return this.serialize(() => this.launch());
  }

  /** Kill child, tutup bridge + socket UDP. Idempoten. */
  stop(): Promise<void> {
    this.generation++;
    return this.serialize(() => this.shutdown());
  }

  restart(): Promise<void> {
    this.generation++;
    return this.serialize(async () => {
      await this.shutdown();
      await this.launch();
    });
  }

  private serialize(op: () => Promise<void>): Promise<void> {
    const next = this.chain.then(op).catch((error: unknown) => {
      console.error('[airplay]', error);
      this.setStatus('error', `Penerima AirPlay gagal: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.chain = next;
    return next;
  }

  private setStatus(state: AirplayStatus['state'], message: string): void {
    if (this.current.state === state && this.current.message === message) return;
    this.current = { state, message };
    this.emit('status', this.current);
  }

  private async launch(): Promise<void> {
    if (this.child) return;
    const settings = this.getSettings();
    if (!settings.enabled) {
      this.setStatus('disabled', 'Penerima AirPlay dimatikan');
      return;
    }
    const runtime = airplayRuntimeDir();
    const exe = path.join(runtime, 'uxplay.exe');
    if (!fs.existsSync(exe)) {
      this.setStatus('unavailable', 'Runtime AirPlay belum dibuild (npm run build:airplay)');
      return;
    }
    this.setStatus('starting', 'Menyalakan penerima AirPlay…');
    const gen = ++this.generation;
    this.lines = [];
    this.deviceName = null;
    this.connected = false;

    const stateDir = path.join(userDataDir(), 'airplay');
    fs.mkdirSync(stateDir, { recursive: true });

    const bridge = new MediaBridgeServer();
    this.bridge = bridge;
    bridge.on('error', (error: unknown) => console.error('[airplay] media bridge:', error));
    bridge.on('media', (ev: MediaEvent) => {
      if (gen !== this.generation) return;
      if (ev.kind === 'video' && !this.connected) {
        this.connected = true;
        this.setStatus('mirroring', `Mirroring dari ${this.deviceName ?? 'iPhone'}`);
        this.emit('connected', { deviceName: this.deviceName });
      }
      this.emit('media', ev);
    });
    const videoPort = await bridge.listen();

    const udp = dgram.createSocket('udp4');
    this.udp = udp;
    udp.on('error', (error) => console.error('[airplay] udp:', error));
    udp.on('message', (msg, rinfo) => {
      if (gen !== this.generation || rinfo.address !== '127.0.0.1') return;
      const packet = parseRtp(msg);
      if (!packet || packet.payloadType !== AUDIO_PAYLOAD_TYPE || packet.payload.length % 4 !== 0) return;
      this.emit('media', { kind: 'pcm', sampleRate: 44100, channels: 2, data: l16ToFloat32(packet.payload) } satisfies MediaEvent);
    });
    await new Promise<void>((resolve, reject) => {
      udp.once('error', reject);
      udp.bind(0, '127.0.0.1', () => {
        udp.off('error', reject);
        resolve();
      });
    });
    const audioPort = udp.address().port;
    if (gen !== this.generation) return;

    const hash = crypto.createHash('sha256').update(os.hostname()).digest();
    const deviceId = `02:${[...hash.subarray(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join(':')}:01`;
    const args = [
      '-n', settings.name,
      '-nh',
      '-m', deviceId,
      '-p', 'tcp', TCP_PORTS,
      '-key', path.join(stateDir, 'identity.pem'),
      '-fps', '60',
      '-vsync', 'no',
      '-nofreeze',
      '-vs', 'fakesink',
      '-vrtp', '! fakesink sync=false async=false',
      '-artp', `pt=${AUDIO_PAYLOAD_TYPE} mtu=1200 ! udpsink host=127.0.0.1 port=${audioPort} sync=false async=false`,
    ];
    const env: NodeJS.ProcessEnv = { ...process.env };
    const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH');
    const inheritedPath = pathKey ? env[pathKey] : undefined;
    if (pathKey) delete env[pathKey];
    Object.assign(env, {
      MIRRORLAB_MEDIA_PORT: String(videoPort),
      PATH: inheritedPath ? `${runtime};${inheritedPath}` : runtime,
      GST_PLUGIN_PATH: path.join(runtime, 'lib', 'gstreamer-1.0'),
      GST_PLUGIN_SYSTEM_PATH: '',
      GST_REGISTRY: path.join(stateDir, 'gstreamer-registry.bin'),
      GST_REGISTRY_FORK: 'no',
      HOME: stateDir,
    });

    const child = spawn(exe, args, { cwd: stateDir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    for (const stream of [child.stdout, child.stderr]) {
      readline.createInterface({ input: stream, crlfDelay: Infinity }).on('line', (line) => this.onLine(gen, line));
    }
    child.on('error', (error) => {
      this.lines.push(error.message);
      console.error('[airplay]', error);
      // Gagal spawn: tidak ada 'close' yang bisa diandalkan.
      if (child.pid === undefined) this.onExit(gen, child, null);
    });
    // 'close' (bukan 'exit') supaya baris log terakhir sudah terbaca saat pesan error disusun.
    child.on('close', (code) => this.onExit(gen, child, code));
    void this.probe(gen, child);
  }

  private onLine(gen: number, line: string): void {
    console.log(`[airplay] ${line}`);
    if (gen !== this.generation) return;
    this.lines.push(line);
    if (this.lines.length > LOG_LINES) this.lines.splice(0, this.lines.length - LOG_LINES);
    if (line.startsWith('*** ERROR')) {
      // Exit code UxPlay tidak bisa dipercaya (gagal DNS-SD pun exit 0); baris ini satu-satunya tanda gagal.
      this.setStatus('error', line);
      return;
    }
    const request = CONNECTION_RE.exec(line);
    if (request) {
      this.deviceName = request[1];
      return;
    }
    if (line === 'MIRRORLAB_DISCONNECTED') {
      this.bridge?.resetSession();
      const wasConnected = this.connected;
      this.connected = false;
      this.deviceName = null;
      if (wasConnected) this.emit('disconnected');
      if (this.current.state !== 'error') {
        this.setStatus('ready', `Di iPhone: Control Center → Screen Mirroring → ${this.getSettings().name}`);
      }
    }
  }

  private onExit(gen: number, child: ChildProcess, code: number | null): void {
    if (this.child !== child) return;
    this.child = null;
    if (gen !== this.generation) return;
    // Proses berhenti sendiri (bukan lewat stop/restart).
    this.generation++;
    this.closeResources();
    const wasConnected = this.connected;
    this.connected = false;
    if (wasConnected) this.emit('disconnected');
    if (this.current.state !== 'error') {
      this.setStatus('error', `Penerima AirPlay berhenti (kode ${code ?? '?'})\n${this.lines.slice(-5).join('\n')}`);
    }
  }

  private async probe(gen: number, child: ChildProcess): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    const pending = (): boolean => gen === this.generation && this.child === child && this.current.state === 'starting';
    while (Date.now() < deadline) {
      if (!pending()) return;
      if (await canConnect(AIRPLAY_BASE_PORT)) {
        if (pending()) this.setStatus('ready', `Di iPhone: Control Center → Screen Mirroring → ${this.getSettings().name}`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS));
    }
    if (!pending()) return;
    this.generation++;
    this.setStatus('error', `Penerima AirPlay tidak siap dalam ${READY_TIMEOUT_MS / 1000} detik\n${this.lines.slice(-5).join('\n')}`);
    this.child = null;
    child.kill();
    this.closeResources();
  }

  private closeResources(): void {
    this.bridge?.close();
    this.bridge = null;
    this.udp?.close();
    this.udp = null;
  }

  private async shutdown(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.closeResources();
    const wasConnected = this.connected;
    this.connected = false;
    this.deviceName = null;
    if (wasConnected) this.emit('disconnected');
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS))]);
    }
    this.setStatus('disabled', 'Penerima AirPlay berhenti');
  }
}
