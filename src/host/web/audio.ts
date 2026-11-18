/**
 * Sound channels (host-web tier): 10 sound slots + 1 bgm, driven from the page (workers have no audio).
 * Mirrors the original PLAYSOUND etc. The engine only sends SoundMsg; what plays is the shell's blobs.
 */
export type SoundMsg =
  | { op: 'play'; file: string; bgm: boolean; repeat: number }
  | { op: 'stop'; bgm: boolean }
  | { op: 'volume'; vol: number; bgm: boolean };

export interface AudioPlayer {
  /** apply one engine sound message */
  handle(m: SoundMsg): void;
  /** replace the sound table (lower-cased path under sound/ -> blob); stops everything and frees old object URLs */
  setSounds(map: Map<string, Blob>): void;
  stopAll(): void;
  /** retry sounds the browser refused for lack of a user gesture (call from your own first-gesture handler) */
  unlock(): void;
}

export interface AudioOptions {
  /** called for an undecodable file */
  onError?(file: string): void;
  /** register capture-phase pointerdown/keydown listeners on window that call unlock() (default true) */
  autoUnlock?: boolean;
}

export function createAudioPlayer(opts: AudioOptions = {}): AudioPlayer {
  let sounds = new Map<string, Blob>();
  const urls = new Map<string, string>();
  type Ch = { el: HTMLAudioElement | null; left: number };
  const chans: Ch[] = Array.from({ length: 10 }, () => ({ el: null, left: 0 }));
  const bgm: Ch = { el: null, left: 0 };
  let sVol = 1,
    bVol = 1;
  const waiting: (() => void)[] = [];
  const unlock = () => {
    for (const f of waiting.splice(0)) f();
  };
  if (opts.autoUnlock !== false) {
    addEventListener('pointerdown', unlock, true);
    addEventListener('keydown', unlock, true);
  }
  const playing = (c: Ch) => !!c.el && !c.el.paused && !c.el.ended;
  const start = (c: Ch, file: string, repeat: number, vol: number) => {
    const blob = sounds.get(file);
    if (!blob) return;
    let url = urls.get(file);
    if (!url) urls.set(file, (url = URL.createObjectURL(blob)));
    c.el?.pause();
    const el = new Audio(url);
    el.volume = vol;
    c.el = el;
    c.left = repeat;
    if (repeat < 0) el.loop = true;
    el.onended = () => {
      if (c.left > 1) {
        c.left--;
        el.currentTime = 0;
        void el.play().catch(() => {});
      }
    };
    el.onerror = () => {
      console.warn('Incompatible sound file: ' + file);
      opts.onError?.(file);
    };
    const go = () => {
      el.play().catch((e) => {
        if (e?.name === 'NotAllowedError') waiting.push(go);
      });
    };
    go();
  };
  const stop = (list: Ch[]) => {
    for (const c of list) {
      c.el?.pause();
      c.left = 0;
    }
  };
  return {
    handle(m) {
      if (m.op === 'play') {
        if (m.bgm) start(bgm, m.file, -1, bVol);
        else {
          let i = chans.findIndex((c) => !playing(c));
          if (i < 0) i = 0;
          start(chans[i], m.file, m.repeat, sVol);
        }
      } else if (m.op === 'stop') stop(m.bgm ? [bgm] : chans);
      else if (m.op === 'volume') {
        const v = m.vol / 100;
        if (m.bgm) {
          bVol = v;
          if (bgm.el) bgm.el.volume = v;
        } else {
          sVol = v;
          for (const c of chans) if (c.el) c.el.volume = v;
        }
      }
    },
    setSounds(map) {
      stop([bgm, ...chans]);
      waiting.length = 0;
      for (const u of urls.values()) URL.revokeObjectURL(u);
      urls.clear();
      sounds = map;
    },
    stopAll() {
      stop([bgm, ...chans]);
    },
    unlock,
  };
}
