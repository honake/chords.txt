// ---- Standard MIDI File (format 1) writer ----
import type { Song } from './generate';
import { gridToBeats } from './generate';

const PPQ = 480;

function varLen(n: number): number[] {
  const bytes = [n & 0x7f];
  n >>= 7;
  while (n > 0) {
    bytes.unshift((n & 0x7f) | 0x80);
    n >>= 7;
  }
  return bytes;
}

function str(s: string): number[] {
  return [...s].map(c => c.charCodeAt(0));
}

function u32(n: number): number[] {
  return [(n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function u16(n: number): number[] {
  return [(n >> 8) & 0xff, n & 0xff];
}

interface MidiEv { tick: number; data: number[]; order: number }

function track(events: MidiEv[]): number[] {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const bytes: number[] = [];
  let lastTick = 0;
  for (const ev of events) {
    bytes.push(...varLen(ev.tick - lastTick), ...ev.data);
    lastTick = ev.tick;
  }
  bytes.push(...varLen(0), 0xff, 0x2f, 0x00); // end of track
  return [...str('MTrk'), ...u32(bytes.length), ...bytes];
}

export function songToMidi(song: Song, bpm: number, title: string): Uint8Array<ArrayBuffer> {
  const meta: MidiEv[] = [];
  const usPerBeat = Math.round(60000000 / bpm);
  const titleBytes = [...new TextEncoder().encode(title)];
  meta.push({ tick: 0, order: 0, data: [0xff, 0x03, ...varLen(titleBytes.length), ...titleBytes] });
  meta.push({ tick: 0, order: 1, data: [0xff, 0x51, 0x03, (usPerBeat >> 16) & 0xff, (usPerBeat >> 8) & 0xff, usPerBeat & 0xff] });
  meta.push({ tick: 0, order: 2, data: [0xff, 0x58, 0x04, 4, 2, 24, 8] }); // 4/4

  const mkHandTrack = (hand: 'lh' | 'rh', name: string): number[] => {
    const evs: MidiEv[] = [];
    evs.push({ tick: 0, order: 0, data: [0xff, 0x03, ...varLen(name.length), ...str(name)] });
    evs.push({ tick: 0, order: 1, data: [0xc0, 0x00] }); // acoustic grand
    for (const e of song.events) {
      if (e.hand !== hand) continue;
      const onTick = Math.round(gridToBeats(e.start, song.settings) * PPQ);
      const offTick = Math.round(gridToBeats(e.start + e.d, song.settings) * PPQ) - 2;
      evs.push({ tick: onTick, order: 10, data: [0x90, e.midi, e.vel] });
      evs.push({ tick: Math.max(onTick + 1, offTick), order: 5, data: [0x80, e.midi, 0x40] });
    }
    return track(evs);
  };

  const bytes = [
    ...str('MThd'), ...u32(6), ...u16(1), ...u16(3), ...u16(PPQ),
    ...track(meta),
    ...mkHandTrack('rh', 'Piano RH'),
    ...mkHandTrack('lh', 'Piano LH'),
  ];
  return new Uint8Array(bytes);
}

export function downloadBlob(data: BlobPart, filename: string, type: string) {
  const blob = new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
