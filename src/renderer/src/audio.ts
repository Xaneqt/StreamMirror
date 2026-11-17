import type { Settings } from '../../shared/types';

let permissionTried = false;

/**
 * Daftar output audio Windows (tanpa entri semu 'default'/'communications').
 * Bila semua label kosong, izin media diminta sekali lewat getUserMedia (track langsung dihentikan)
 * lalu dienumerasi ulang; tetap gagal → daftar kosong (hanya "Default Windows").
 */
export async function audioOutputs(): Promise<MediaDeviceInfo[]> {
  let outputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput');
  if (outputs.every((d) => d.label === '')) {
    if (permissionTried) return [];
    permissionTried = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
      outputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput');
    } catch (err) {
      console.warn('[audio] label output tidak tersedia', err);
      return [];
    }
  }
  return outputs.filter((d) => d.label !== '' && d.deviceId !== 'default' && d.deviceId !== 'communications');
}

export class AudioPipeline {
  private readonly ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
  private readonly gain = this.ctx.createGain();
  private readonly onNotice: (message: string) => void;
  private next = 0;
  private count = 0;
  private applying: Promise<void> = Promise.resolve();

  constructor(onNotice: (message: string) => void) {
    this.onNotice = onNotice;
    this.gain.connect(this.ctx.destination);
  }

  /** Volume/mute langsung; output device dipilih lewat label (deviceId berbeda per origin). Dipanggil berurutan. */
  apply(s: Settings['audio']): Promise<void> {
    this.gain.gain.value = s.muted ? 0 : s.volume;
    this.applying = this.applying.catch(() => undefined).then(() => this.applySink(s.outputLabel));
    return this.applying;
  }

  push(ev: { sampleRate: number; channels: number; data: Float32Array }): void {
    const { channels, data } = ev;
    if (this.ctx.state === 'closed' || channels < 1) return;
    const frames = Math.floor(data.length / channels);
    if (frames === 0) return;
    const buf = this.ctx.createBuffer(channels, frames, ev.sampleRate);
    for (let c = 0; c < channels; c++) {
      const out = buf.getChannelData(c);
      for (let i = 0, j = c; i < frames; i++, j += channels) out[i] = data[j];
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);
    const now = this.ctx.currentTime;
    if (this.next < now + 0.02 || this.next > now + 0.25) this.next = now + 0.04;
    src.start(this.next);
    this.next += buf.duration;
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    this.count++;
  }

  /** Jumlah chunk PCM sejak panggilan terakhir. */
  chunks(): number {
    const n = this.count;
    this.count = 0;
    return n;
  }

  close(): void {
    if (this.ctx.state !== 'closed') void this.ctx.close();
  }

  private async applySink(label: string): Promise<void> {
    const sink = this.ctx as unknown as { setSinkId(id: string): Promise<void> };
    if (label === '') {
      await sink.setSinkId('');
      return;
    }
    const device = (await audioOutputs()).find((d) => d.label === label);
    if (device) {
      await sink.setSinkId(device.deviceId);
      return;
    }
    await sink.setSinkId('');
    this.onNotice(`Output '${label}' tidak ditemukan, pakai default`);
  }
}
