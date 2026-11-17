import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SETTINGS, type Settings, type SettingsPatch } from '../shared/types';
import { userDataDir } from './paths';

/** Merge satu tingkat: tiap grup di-spread, array diganti utuh. Nilai bertipe salah diabaikan. */
export function mergeSettings(base: Settings, patch: SettingsPatch | null | undefined): Settings {
  const p = (patch ?? {}) as Record<string, unknown>;
  const group = <K extends 'android' | 'audio' | 'airplay'>(key: K): Settings[K] => {
    const out = { ...base[key] } as Record<string, unknown>;
    const src = p[key];
    if (src && typeof src === 'object') {
      for (const [k, v] of Object.entries(src)) {
        if (k in out && typeof v === typeof out[k]) out[k] = v;
      }
    }
    return out as Settings[K];
  };
  const serials = p.iosUsbDriverSerials;
  return {
    android: group('android'),
    audio: group('audio'),
    airplay: group('airplay'),
    iosUsbDriverSerials: Array.isArray(serials)
      ? serials.filter((s): s is string => typeof s === 'string')
      : [...base.iosUsbDriverSerials],
    theme: p.theme === 'dark' || p.theme === 'light' ? p.theme : base.theme,
  };
}

/** File hilang/rusak → default. */
export function loadSettings(): Settings {
  try {
    return mergeSettings(DEFAULT_SETTINGS, JSON.parse(fs.readFileSync(path.join(userDataDir(), 'settings.json'), 'utf8')));
  } catch {
    return mergeSettings(DEFAULT_SETTINGS, {});
  }
}

export function saveSettings(settings: Settings): void {
  fs.mkdirSync(userDataDir(), { recursive: true });
  fs.writeFileSync(path.join(userDataDir(), 'settings.json'), JSON.stringify(settings, null, 2));
}
