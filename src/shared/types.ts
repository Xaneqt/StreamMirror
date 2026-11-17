export type SourceKind = 'android' | 'airplay' | 'ios-usb';

export type MediaEvent =
  // H.264 Annex B; pts mikrodetik; config=true → hanya SPS+PPS
  | { kind: 'video'; config: boolean; keyFrame: boolean; pts: number; rotation: 0 | 1 | 2 | 3; data: Uint8Array }
  // interleaved
  | { kind: 'pcm'; sampleRate: number; channels: number; data: Float32Array }
  | { kind: 'notice'; message: string };

/** paced: true untuk iOS (frame dijadwalkan menurut timestamp pengirim). */
export interface MirrorInfo {
  sessionId: string;
  source: SourceKind;
  title: string;
  paced: boolean;
}

export interface OpResult {
  ok: boolean;
  message: string;
}

export type Theme = 'dark' | 'light';

export interface Settings {
  android: { maxSize: number; videoBitRateMbps: number; maxFps: number; keepPhoneAudio: boolean };
  /** outputLabel '' = default Windows */
  audio: { outputLabel: string; volume: number; muted: boolean };
  airplay: { enabled: boolean; name: string };
  /** serial yang pernah dipasangi filter libusb0 */
  iosUsbDriverSerials: string[];
  theme: Theme;
}

export const DEFAULT_SETTINGS: Settings = {
  android: { maxSize: 1920, videoBitRateMbps: 8, maxFps: 60, keepPhoneAudio: false },
  audio: { outputLabel: '', volume: 1, muted: false },
  airplay: { enabled: true, name: 'StreamMirror' },
  iosUsbDriverSerials: [],
  theme: 'dark',
};

export type SettingsPatch = { [K in keyof Settings]?: Settings[K] extends unknown[] ? Settings[K] : Partial<Settings[K]> };

export interface AndroidDeviceInfo {
  serial: string;
  state: string;
  model: string;
  wireless: boolean;
  mirroring: boolean;
}

export interface UsbIphoneInfo {
  serial: string;
  name: string;
  model: string;
  osVersion: string;
  driver: 'ready' | 'replug' | 'missing';
  mirroring: boolean;
}

export interface AirplayStatus {
  state: 'disabled' | 'unavailable' | 'starting' | 'ready' | 'mirroring' | 'error';
  message: string;
}

export interface AppState {
  android: AndroidDeviceInfo[];
  iosUsbAvailable: boolean;
  iosUsb: UsbIphoneInfo[];
  airplay: AirplayStatus;
  sessions: { sessionId: string; title: string; source: SourceKind }[];
  settings: Settings;
}

export interface MirrorReady {
  info: MirrorInfo;
  audio: Settings['audio'];
}

export interface MirrorStats {
  decoded: number;
  drawn: number;
  pcmChunks: number;
}
