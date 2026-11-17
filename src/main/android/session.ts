import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import type { MediaEvent, Settings } from '../../shared/types';
import { adb } from '../adb';
import { adbPath, scrcpyServerPath } from '../paths';
import type { MediaSource } from '../sessions';
import { ScrcpyStreamParser, type ScrcpyEvent } from './scrcpy-stream';

const SERVER_VERSION = '5.0.1';
const DEVICE_SERVER_PATH = '/data/local/tmp/scrcpy-server.jar';
const CODEC_H264 = 0x68323634;
const CODEC_RAW = 0x00726177;
const OUTPUT_LINES = 20;
const CONNECT_ATTEMPTS = 100;
const DEVICE_META_TIMEOUT_MS = 10000;
const DISCONNECTED = 'Koneksi ke HP terputus';

/**
 * Argumen scrcpy-server. Satu-satunya tempat `audio_source` ditentukan: hanya `output`
 * (REMOTE_SUBMIX) atau `playback` (AudioPlaybackCapture) — keduanya audio digital, tidak pernah mic.
 */
export function buildServerArgs(o: Settings['android'], scid: string): string[] {
  const args = [
    `scid=${scid}`,
    'log_level=info',
    'tunnel_forward=true',
    'control=false',
    `video_bit_rate=${Math.round(o.videoBitRateMbps * 1_000_000)}`,
  ];
  if (o.maxSize > 0) args.push(`max_size=${Math.round(o.maxSize)}`);
  if (o.maxFps > 0) args.push(`max_fps=${Math.round(o.maxFps)}`);
  args.push('audio_codec=raw');
  if (o.keepPhoneAudio === true) args.push('audio_source=playback', 'audio_dup=true');
  else args.push('audio_source=output');
  return args;
}

/** Sesi mirror Android lewat adb + scrcpy-server. Event: 'media' (MediaEvent), 'closed' (reason). */
export class AndroidSession extends EventEmitter implements MediaSource {
  private readonly serial: string;
  private readonly opts: Settings['android'];
  private started = false;
  private running = false;
  private stopped = false;
  private stopPromise: Promise<void> | null = null;
  /** Alasan sesi berakhir (pertama yang tercatat). */
  private failure: string | null = null;
  private closedEmitted = false;
  private child: ChildProcess | null = null;
  private port: number | null = null;
  private video: net.Socket | null = null;
  private audio: net.Socket | null = null;
  private deviceName: string | null = null;
  private audioDisabled = false;
  private readonly output: string[] = [];
  private readonly waiters = new Set<() => void>();
  /** Media sebelum listener 'media' pertama terpasang (config H.264 datang sebelum openSession). */
  private pending: MediaEvent[] | null = [];

  constructor(serial: string, opts: Settings['android']) {
    super();
    this.serial = serial;
    this.opts = { ...opts };
    this.on('newListener', (event: string | symbol) => {
      if (event === 'media' && this.pending) process.nextTick(() => this.flushPending());
      if (event === 'closed' && this.failure !== null && this.running) process.nextTick(() => this.emitClosed());
    });
  }

  async start(): Promise<{ deviceName: string }> {
    if (this.started) throw new Error('Sesi Android sudah dimulai');
    this.started = true;
    try {
      this.checkAlive();
      const serverFile = scrcpyServerPath();
      if (!fs.existsSync(serverFile)) throw new Error('scrcpy-server belum diunduh (npm run fetch:android)');

      const pushed = await adb(['-s', this.serial, 'push', serverFile, DEVICE_SERVER_PATH], 30000);
      this.checkAlive();
      if (pushed.code !== 0) throw new Error(`Gagal mengirim scrcpy-server ke HP: ${lastLine(pushed.stderr || pushed.stdout)}`);

      const scid = crypto.randomInt(1, 0x7fffffff).toString(16).padStart(8, '0');
      const forwarded = await adb(['-s', this.serial, 'forward', 'tcp:0', `localabstract:scrcpy_${scid}`]);
      const port = Number.parseInt(forwarded.stdout.trim(), 10);
      if (forwarded.code === 0 && port > 0 && port < 65536) this.port = port;
      this.checkAlive();
      if (this.port === null) throw new Error(`Gagal membuat adb forward: ${lastLine(forwarded.stderr || forwarded.stdout)}`);

      this.spawnServer(scid);

      const first = await this.connectVideo(this.port);
      this.video = first.socket;
      this.attachVideo(first.socket, first.rest);

      this.audio = await this.connectAudio(this.port);
      this.checkAlive();

      if (!(await this.waitUntil(() => this.deviceName !== null, DEVICE_META_TIMEOUT_MS))) {
        throw new Error('HP tidak mengirim info device');
      }
      this.checkAlive();

      const forwardPort = this.port;
      this.port = null;
      await adb(['-s', this.serial, 'forward', '--remove', `tcp:${forwardPort}`], 5000);
      this.checkAlive();

      this.running = true;
      return { deviceName: this.deviceName ?? this.serial };
    } catch (error) {
      await this.cleanup();
      const reason = this.stopped ? 'Mirror dibatalkan' : error instanceof Error ? error.message : String(error);
      const lines = this.output.slice(-5);
      throw new Error(lines.length > 0 ? `${reason}\n${lines.join('\n')}` : reason);
    }
  }

  stop(): Promise<void> {
    if (!this.stopPromise) {
      this.stopped = true;
      this.notify();
      this.stopPromise = this.cleanup();
    }
    return this.stopPromise;
  }

  private checkAlive(): void {
    if (this.stopped) throw new Error('Mirror dibatalkan');
    if (this.failure !== null) throw new Error(this.failure);
  }

  /** Mencatat akhir sesi. Saat start: membangunkan start() yang menunggu. Saat jalan: 'closed' sekali + cleanup. */
  private fail(reason: string): void {
    if (this.stopped || this.failure !== null) return;
    this.failure = reason;
    this.notify();
    if (this.running) {
      void this.cleanup();
      this.emitClosed();
    }
  }

  private emitClosed(): void {
    if (this.closedEmitted || this.failure === null || this.listenerCount('closed') === 0) return;
    this.closedEmitted = true;
    this.emit('closed', this.failure);
  }

  private emitMedia(ev: MediaEvent): void {
    if (this.pending) this.pending.push(ev);
    else this.emit('media', ev);
  }

  private flushPending(): void {
    const queued = this.pending;
    if (!queued || this.listenerCount('media') === 0) return;
    this.pending = null;
    for (const ev of queued) this.emit('media', ev);
  }

  private notify(): void {
    for (const waiter of [...this.waiters]) waiter();
  }

  /** true jika `done()` terpenuhi; false saat timeout. Juga selesai saat sesi gagal/dihentikan. */
  private waitUntil(done: () => boolean, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const finish = (value: boolean): void => {
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve(value);
      };
      const check = (): void => {
        if (done()) finish(true);
        else if (this.stopped || this.failure !== null) finish(false);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.waiters.add(check);
      check();
    });
  }

  private spawnServer(scid: string): void {
    const child = spawn(
      adbPath(),
      [
        '-s',
        this.serial,
        'shell',
        `CLASSPATH=${DEVICE_SERVER_PATH}`,
        'app_process',
        '/',
        'com.genymobile.scrcpy.Server',
        SERVER_VERSION,
        ...buildServerArgs(this.opts, scid),
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    this.child = child;
    for (const stream of [child.stdout, child.stderr]) {
      if (stream) createInterface({ input: stream, crlfDelay: Infinity }).on('line', (line) => this.log(line));
    }
    child.on('error', (error) => {
      this.log(`Gagal menjalankan adb: ${error.message}`);
      this.fail(this.running ? DISCONNECTED : 'Gagal menjalankan scrcpy-server');
    });
    child.on('exit', () => this.fail(this.running ? DISCONNECTED : 'scrcpy-server berhenti sebelum terhubung'));
  }

  private log(line: string): void {
    if (!line.trim()) return;
    this.output.push(line);
    if (this.output.length > OUTPUT_LINES) this.output.shift();
    console.log(`[android ${this.serial}] ${line}`);
  }

  /** Socket pertama (video): server siap jika chunk pertama diawali dummy byte 0. */
  private async connectVideo(port: number): Promise<{ socket: net.Socket; rest: Uint8Array }> {
    for (let attempt = 0; attempt < CONNECT_ATTEMPTS; attempt++) {
      if (attempt > 0) await delay(100);
      this.checkAlive();
      const result = await new Promise<{ socket: net.Socket; rest: Uint8Array } | null>((resolve) => {
        const socket = net.connect(port, '127.0.0.1');
        const finish = (value: { socket: net.Socket; rest: Uint8Array } | null): void => {
          clearTimeout(timer);
          socket.off('data', onData);
          socket.off('error', onError);
          socket.off('close', onClose);
          if (!value) socket.destroy();
          resolve(value);
        };
        const onData = (chunk: Buffer): void => {
          socket.pause();
          finish(chunk[0] === 0 ? { socket, rest: chunk.subarray(1) } : null);
        };
        const onError = (): void => finish(null);
        const onClose = (): void => finish(null);
        const timer = setTimeout(() => finish(null), 5000);
        socket.on('data', onData);
        socket.on('error', onError);
        socket.on('close', onClose);
      });
      if (result) {
        if (this.stopped || this.failure !== null) result.socket.destroy();
        this.checkAlive();
        return result;
      }
    }
    this.checkAlive();
    throw new Error('Tidak bisa terhubung ke scrcpy-server di HP');
  }

  private attachVideo(socket: net.Socket, rest: Uint8Array): void {
    socket.setNoDelay(true);
    const parser = new ScrcpyStreamParser({ deviceMeta: true });
    const handle = (chunk: Uint8Array): void => {
      for (const ev of parser.push(chunk)) this.onVideoEvent(ev);
    };
    socket.on('data', handle);
    socket.on('error', () => this.fail(DISCONNECTED));
    socket.on('close', () => this.fail(DISCONNECTED));
    handle(rest);
    socket.resume();
  }

  private onVideoEvent(ev: ScrcpyEvent): void {
    switch (ev.type) {
      case 'device':
        this.deviceName = ev.name || this.serial;
        this.notify();
        break;
      case 'codec':
        if (ev.id !== CODEC_H264) this.fail('Codec video tidak didukung');
        break;
      case 'session':
        this.log(`video ${ev.width}x${ev.height}`);
        break;
      case 'packet':
        this.emitMedia({ kind: 'video', config: ev.config, keyFrame: ev.keyFrame, pts: Number(ev.pts), rotation: 0, data: ev.data });
        break;
    }
  }

  private connectAudio(port: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1');
      this.audio = socket;
      const parser = new ScrcpyStreamParser({ deviceMeta: false });
      socket.setNoDelay(true);
      socket.on('data', (chunk: Buffer) => {
        for (const ev of parser.push(chunk)) this.onAudioEvent(ev);
      });
      socket.once('connect', () => resolve(socket));
      socket.on('error', () => {
        reject(new Error('Tidak bisa membuka socket audio scrcpy-server'));
        if (!this.audioDisabled) this.fail(DISCONNECTED);
      });
      // Audio yang dinonaktifkan HP boleh menutup socket-nya tanpa mengakhiri mirror video.
      socket.on('close', () => {
        reject(new Error(DISCONNECTED));
        if (!this.audioDisabled) this.fail(DISCONNECTED);
      });
    });
  }

  private onAudioEvent(ev: ScrcpyEvent): void {
    if (ev.type === 'codec') {
      if (ev.id === CODEC_RAW) return;
      this.audioDisabled = true;
      const message =
        ev.id === 0
          ? 'HP ini tidak bisa mengirim audio (butuh Android 11+)'
          : ev.id === 1
            ? 'Audio capture gagal di HP'
            : 'Codec audio tidak didukung';
      this.emitMedia({ kind: 'notice', message });
    } else if (ev.type === 'packet' && !ev.config && !this.audioDisabled) {
      const samples = new Int16Array(ev.data.buffer, ev.data.byteOffset, ev.data.byteLength >> 1);
      const data = new Float32Array(samples.length);
      for (let i = 0; i < samples.length; i++) data[i] = samples[i] / 32768;
      this.emitMedia({ kind: 'pcm', sampleRate: 48000, channels: 2, data });
    }
  }

  /** Idempoten: tutup socket, matikan proses server, hapus adb forward. */
  private async cleanup(): Promise<void> {
    if (this.pending) this.pending.length = 0;
    this.video?.destroy();
    this.video = null;
    this.audio?.destroy();
    this.audio = null;
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    const port = this.port;
    this.port = null;
    if (port !== null) await adb(['-s', this.serial, 'forward', '--remove', `tcp:${port}`], 5000);
  }
}

function lastLine(text: string): string {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  return lines[lines.length - 1] ?? 'tanpa pesan';
}
