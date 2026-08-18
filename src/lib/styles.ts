// ---- Style definitions: voicings, rhythm patterns, groove settings ----
import type { Chord } from './theory';
import { anatomy } from './theory';

export type StyleId = 'jazz' | 'neosoul' | 'pop' | 'ballad';
export type Hand = 'lh' | 'rh';
export type HitKind = 'chord' | 'bass' | 'arp';
export type Feel = 'swing8' | 'straight8' | 'sixteenth' | 'shuffle16';

/** User-adjustable groove parameters (styles provide defaults). */
export interface GrooveSettings {
  feel: Feel;
  swing: number;      // 0.5 (straight) .. 0.75 (hard swing) — offbeat position
  density: number;    // 0..1 rhythmic busyness
  tension: 0 | 1 | 2; // voicing richness
  register: number;   // -12..+12 semitone shift of RH voicings
  pushProb: number;   // 0..1 probability of anticipating bar-line chord changes
  humanize: number;   // 0..1 velocity / timing looseness
  embellish: number;  // 0..1 probability of inner-voice clichés (9→3, 4→3, maj7→6)
  fills: number;      // 0..1 probability of pickup fills / obbligato runs into chord changes
  /** fill vocabulary — see FILL_VOCABS in generate.ts */
  fillStyle: 'basic' | 'blues' | 'gospel' | 'jazz' | 'contemporary' | 'mix';
}

/** One rhythmic attack. t/d are in 16th notes relative to segment start. */
export interface Hit { t: number; d: number; hand: Hand; kind: HitKind; vel: number }
export interface Pattern { hits: Hit[]; sixteenth?: boolean }

export interface VoiceCtx {
  prevRh: number[] | null;
  prevRoot: number | null;
  tension: 0 | 1 | 2;
  register: number;
  /** chord-scale recommendation from the harmony analyzer */
  harmony?: { tensions: number[]; avoid: number[] };
}

export interface StyleDef {
  id: StyleId;
  name: string;
  desc: string;
  defaults: GrooveSettings;
  patterns: Record<number, Pattern[]>;
  voice(chord: Chord, ctx: VoiceCtx): { lh: number[]; rh: number[] };
}

// ---------- voicing helpers ----------

function near(pc: number, target: number): number {
  let n = pc + 12 * Math.round((target - pc) / 12);
  while (n < target - 6) n += 12;
  while (n > target + 6) n -= 12;
  return n;
}

/** Choose a register for the bass root, minimizing motion from the previous root. */
function bassNote(c: Chord, low: number, high: number, prevRoot: number | null): number {
  const pc = c.bass ?? c.root;
  const candidates: number[] = [];
  for (let n = pc + 12 * Math.ceil((low - pc) / 12); n <= high; n += 12) candidates.push(n);
  if (candidates.length === 0) return near(pc, (low + high) / 2);
  const target = prevRoot ?? (low + high) / 2;
  return candidates.reduce((a, b) => (Math.abs(a - target) <= Math.abs(b - target) ? a : b));
}

/**
 * Voice-led stacking: try every rotation/octave placement of the pitch-class set
 * and pick the one whose voices move least from the previous voicing.
 */
function voiceLead(intervals: number[], rootPc: number, low: number, high: number, prev: number[] | null, avoidNotes: number[] = []): number[] {
  const pcs = [...new Set(intervals.map(iv => (rootPc + iv) % 12))];
  if (pcs.length === 0) return [near(rootPc, (low + high) / 2)];
  let best: number[] | null = null;
  let bestCost = Infinity;

  for (let rot = 0; rot < pcs.length; rot++) {
    const order = [...pcs.slice(rot), ...pcs.slice(0, rot)];
    for (let shift = -1; shift <= 1; shift++) {
      const notes: number[] = [];
      for (const pc of order) {
        let n = pc + 12 * Math.ceil((low + shift * 12 - pc) / 12);
        while (notes.length && n <= notes[notes.length - 1]) n += 12;
        notes.push(n);
      }
      const top = notes[notes.length - 1];
      const bottom = notes[0];
      let cost = 0;
      if (top > high) cost += (top - high) * 4;
      if (bottom < low) cost += (low - bottom) * 4;
      if (top > high + 4 || bottom < low - 6) continue;
      // never double a left-hand note at the exact same pitch
      for (const n of notes) if (avoidNotes.includes(n)) cost += 4;
      if (prev && prev.length > 0) {
        // total voice movement: each new note to its nearest previous note
        for (const n of notes) {
          let dmin = Infinity;
          for (const p of prev) dmin = Math.min(dmin, Math.abs(n - p));
          cost += dmin;
        }
        // weighted top-voice continuity (the ear follows the top)
        cost += Math.abs(top - prev[prev.length - 1]) * 1.5;
        // reward kept common tones
        const common = notes.filter(n => prev.includes(n)).length;
        cost -= common * 1.2;
      } else {
        cost += Math.abs(top - (low + (high - low) * 0.7));
      }
      if (cost < bestCost) { bestCost = cost; best = notes; }
    }
  }
  return best ?? pcs.map((pc, i) => near(pc, low + 4 + i * 3)).sort((a, b) => a - b);
}

// tension helpers — explicit symbols win, then the analyzer's chord-scale, then a plain 9
function pickNine(c: Chord, ctx?: VoiceCtx): number | null {
  if (c.quality === 'dim') return null;
  const a = anatomy(c);
  const written = a.tensions.find(t => t >= 13 && t <= 15);
  if (written != null) return written;
  const h = ctx?.harmony;
  if (h) {
    const rec = h.tensions.find(t => t >= 13 && t <= 15);
    if (rec != null) return rec;
    if (h.avoid.includes(14)) return null;
  }
  if (c.quality === 'aug' || c.quality === 'hdim') return null;
  return 14;
}

function pickThirteen(c: Chord, ctx?: VoiceCtx): number | null {
  const a = anatomy(c);
  const written = a.tensions.find(t => t === 20 || t === 21);
  if (written != null) return written;
  const h = ctx?.harmony;
  if (h) {
    const rec = h.tensions.find(t => t === 20 || t === 21);
    if (rec != null) return rec;
    if (h.avoid.includes(21)) return null;
  }
  return 21;
}

function wantsSharp11(c: Chord, ctx?: VoiceCtx): boolean {
  return anatomy(c).tensions.includes(18) || (ctx?.harmony?.tensions.includes(18) ?? false);
}

// ---------- per-style voicings ----------

function jazzVoice(c: Chord, ctx: VoiceCtx) {
  const a = anatomy(c);
  const root = bassNote(c, 40, 52, ctx.prevRoot);
  const seventh = a.seventh ?? a.sixth;
  const lh = [root];
  const shellIv = seventh ?? a.third;
  if (shellIv != null && ctx.tension >= 1) lh.push(near((c.root + shellIv) % 12, root + 9));

  const ivs: number[] = [];
  if (a.third != null) ivs.push(a.third);
  if (seventh != null) ivs.push(seventh);
  if (ctx.tension >= 1) {
    const nine = pickNine(c, ctx);
    if (nine != null) ivs.push(nine);
    const th = c.quality === 'dom' ? pickThirteen(c, ctx) : null;
    if (th != null) ivs.push(th);
    else if (a.fifth != null) ivs.push(a.fifth);
  } else if (a.fifth != null) {
    ivs.push(a.fifth);
  }
  if (ctx.tension >= 2) {
    if (wantsSharp11(c, ctx)) ivs.push(18);
    else if (c.quality === 'maj' || c.quality === 'dom') {
      const th = pickThirteen(c, ctx);
      if (th != null) ivs.push(th);
    } else if (c.quality === 'min' && !ctx.harmony?.avoid.includes(17)) ivs.push(17);
  }
  const low = Math.max(58 + ctx.register, lh[0] + 5);
  const rh = voiceLead([...new Set(ivs)].slice(0, 5), c.root, low, Math.max(low + 12, 76 + ctx.register), ctx.prevRh, lh);
  return { lh, rh };
}

function neosoulVoice(c: Chord, ctx: VoiceCtx) {
  const a = anatomy(c);
  const root = bassNote(c, 38, 50, ctx.prevRoot);
  const lh = [root];
  const lhColor = c.quality === 'hdim' || ctx.tension >= 2 ? (a.seventh ?? a.fifth) : a.fifth;
  if (lhColor != null) lh.push(near((c.root + lhColor) % 12, root + 8));

  const seventh = a.seventh ?? a.sixth ?? null;
  const ivs: number[] = [];
  if (a.third != null) ivs.push(a.third);
  if (seventh != null) ivs.push(seventh);
  else if (a.fifth != null) ivs.push(a.fifth);
  const nine = pickNine(c, ctx);
  if (nine != null) ivs.push(nine);
  if (ctx.tension >= 1) {
    if (c.quality === 'min' && !ctx.harmony?.avoid.includes(17)) ivs.push(17);
    if (c.quality === 'dom') {
      const th = pickThirteen(c, ctx);
      if (th != null) ivs.push(th);
    }
    if (c.quality === 'maj' && a.seventh === 11) {
      const th = pickThirteen(c, ctx);
      if (th != null) ivs.push(th);
    }
  }
  if (ctx.tension >= 2 && wantsSharp11(c, ctx)) ivs.push(18);
  const low = Math.max(60 + ctx.register, lh[0] + 5);
  const rh = voiceLead([...new Set(ivs)].slice(0, 5), c.root, low, Math.max(low + 12, 80 + ctx.register), ctx.prevRh, lh);
  return { lh, rh };
}

function popVoice(c: Chord, ctx: VoiceCtx) {
  const a = anatomy(c);
  const root = bassNote(c, 36, 48, ctx.prevRoot);
  const lh = [root, root + 12];
  const ivs: number[] = [0];
  if (a.third != null) ivs.push(a.third);
  if (a.fifth != null) ivs.push(a.fifth);
  if (a.seventh != null && (ctx.tension >= 1 || c.tones.includes(10) || c.tones.includes(11))) ivs.push(a.seventh);
  if (a.sixth != null) ivs.push(a.sixth);
  if (ctx.tension >= 2 || c.tones.includes(14)) {
    const nine = pickNine(c, ctx);
    if (nine === 14) ivs.push(14);
  }
  const low = Math.max(57 + ctx.register, lh[0] + 5);
  const rh = voiceLead([...new Set(ivs)].slice(0, ctx.tension >= 2 ? 5 : 4), c.root, low, Math.max(low + 12, 74 + ctx.register), ctx.prevRh, lh);
  return { lh, rh };
}

function balladVoice(c: Chord, ctx: VoiceCtx) {
  const a = anatomy(c);
  const root = bassNote(c, 36, 48, ctx.prevRoot);
  const lh = [root];
  if (a.fifth != null) lh.push(root + a.fifth);
  const ivs: number[] = [0];
  if (a.third != null) ivs.push(a.third);
  if (a.fifth != null) ivs.push(a.fifth);
  if (ctx.tension >= 1 && (a.seventh ?? a.sixth) != null) ivs.push((a.seventh ?? a.sixth)!);
  if (ctx.tension >= 2) {
    const nine = pickNine(c, ctx);
    if (nine === 14) ivs.push(14);
  }
  const low = Math.max(55 + ctx.register, lh[0] + 5);
  const rh = voiceLead([...new Set(ivs)].slice(0, 5), c.root, low, Math.max(low + 12, 74 + ctx.register), ctx.prevRh, lh);
  return { lh, rh };
}

// ---------- rhythm patterns ----------
// NOTE: within one hand, hits must never overlap in time (keeps notation clean).

const V = (t: number, d: number, hand: Hand, kind: HitKind, vel: number): Hit => ({ t, d, hand, kind, vel });

const jazzPatterns: Record<number, Pattern[]> = {
  16: [
    { hits: [V(0, 16, 'lh', 'chord', 62), V(0, 6, 'rh', 'chord', 78), V(6, 10, 'rh', 'chord', 70)] },
    { hits: [V(0, 16, 'lh', 'chord', 60), V(0, 4, 'rh', 'chord', 76), V(6, 6, 'rh', 'chord', 68), V(12, 4, 'rh', 'chord', 72)] },
    { hits: [V(0, 8, 'lh', 'chord', 58), V(8, 8, 'lh', 'chord', 55), V(2, 4, 'rh', 'chord', 70), V(6, 6, 'rh', 'chord', 74), V(14, 2, 'rh', 'chord', 66)] },
    { hits: [V(0, 16, 'lh', 'chord', 60), V(2, 10, 'rh', 'chord', 74), V(12, 4, 'rh', 'chord', 64)] },
    { hits: [V(0, 16, 'lh', 'chord', 58), V(4, 4, 'rh', 'chord', 74), V(12, 4, 'rh', 'chord', 70)] },
    // funkier 16th comp
    { sixteenth: true, hits: [V(0, 16, 'lh', 'chord', 60), V(0, 3, 'rh', 'chord', 76), V(3, 3, 'rh', 'chord', 64), V(10, 3, 'rh', 'chord', 72), V(13, 3, 'rh', 'chord', 62)] },
  ],
  8: [
    { hits: [V(0, 8, 'lh', 'chord', 60), V(0, 3, 'rh', 'chord', 76), V(6, 2, 'rh', 'chord', 68)] },
    { hits: [V(0, 8, 'lh', 'chord', 58), V(2, 6, 'rh', 'chord', 72)] },
    { hits: [V(0, 8, 'lh', 'chord', 60), V(0, 6, 'rh', 'chord', 74), V(6, 2, 'rh', 'chord', 66)] },
    { sixteenth: true, hits: [V(0, 8, 'lh', 'chord', 60), V(0, 3, 'rh', 'chord', 74), V(3, 5, 'rh', 'chord', 64)] },
  ],
  4: [
    { hits: [V(0, 4, 'lh', 'chord', 60), V(0, 4, 'rh', 'chord', 74)] },
    { hits: [V(0, 4, 'lh', 'chord', 58), V(2, 2, 'rh', 'chord', 70)] },
  ],
};

const neosoulPatterns: Record<number, Pattern[]> = {
  16: [
    { hits: [V(0, 10, 'lh', 'bass', 66), V(10, 6, 'lh', 'chord', 58), V(0, 6, 'rh', 'chord', 66), V(6, 10, 'rh', 'chord', 62)] },
    { sixteenth: true, hits: [V(0, 16, 'lh', 'chord', 62), V(0, 7, 'rh', 'chord', 66), V(7, 9, 'rh', 'chord', 60)] },
    { sixteenth: true, hits: [V(0, 8, 'lh', 'bass', 66), V(8, 8, 'lh', 'chord', 58), V(0, 6, 'rh', 'chord', 64), V(6, 4, 'rh', 'chord', 60), V(10, 6, 'rh', 'chord', 63)] },
    { hits: [V(0, 16, 'lh', 'chord', 60), V(0, 12, 'rh', 'chord', 63), V(12, 4, 'rh', 'chord', 58)] },
    { sixteenth: true, hits: [V(0, 12, 'lh', 'bass', 66), V(12, 4, 'lh', 'chord', 56), V(0, 3, 'rh', 'chord', 66), V(3, 7, 'rh', 'chord', 60), V(10, 3, 'rh', 'chord', 62), V(13, 3, 'rh', 'chord', 58)] },
  ],
  8: [
    { sixteenth: true, hits: [V(0, 8, 'lh', 'chord', 62), V(0, 3, 'rh', 'chord', 64), V(3, 5, 'rh', 'chord', 60)] },
    { hits: [V(0, 8, 'lh', 'bass', 64), V(0, 6, 'rh', 'chord', 63), V(6, 2, 'rh', 'chord', 58)] },
    { hits: [V(0, 8, 'lh', 'chord', 62), V(2, 6, 'rh', 'chord', 62)] },
  ],
  4: [
    { hits: [V(0, 4, 'lh', 'chord', 62), V(0, 4, 'rh', 'chord', 63)] },
    { sixteenth: true, hits: [V(0, 4, 'lh', 'bass', 64), V(1, 3, 'rh', 'chord', 60)] },
  ],
};

const popPatterns: Record<number, Pattern[]> = {
  16: [
    { hits: [V(0, 16, 'lh', 'chord', 72), V(0, 6, 'rh', 'chord', 78), V(6, 6, 'rh', 'chord', 74), V(12, 4, 'rh', 'chord', 76)] },
    { hits: [V(0, 8, 'lh', 'chord', 72), V(8, 8, 'lh', 'chord', 68), V(0, 4, 'rh', 'chord', 78), V(4, 4, 'rh', 'chord', 72), V(8, 4, 'rh', 'chord', 75), V(12, 4, 'rh', 'chord', 72)] },
    { hits: [V(0, 16, 'lh', 'chord', 70), V(0, 8, 'rh', 'chord', 76), V(8, 6, 'rh', 'chord', 72), V(14, 2, 'rh', 'chord', 70)] },
    { hits: [V(0, 16, 'lh', 'chord', 72), V(0, 2, 'rh', 'chord', 80), V(2, 2, 'rh', 'chord', 68), V(4, 2, 'rh', 'chord', 72), V(6, 2, 'rh', 'chord', 68), V(8, 2, 'rh', 'chord', 76), V(10, 2, 'rh', 'chord', 68), V(12, 2, 'rh', 'chord', 72), V(14, 2, 'rh', 'chord', 68)] },
    { sixteenth: true, hits: [V(0, 16, 'lh', 'chord', 72), V(0, 3, 'rh', 'chord', 78), V(3, 3, 'rh', 'chord', 68), V(6, 2, 'rh', 'chord', 72), V(8, 2, 'rh', 'chord', 74), V(10, 6, 'rh', 'chord', 70)] },
  ],
  8: [
    { hits: [V(0, 8, 'lh', 'chord', 72), V(0, 4, 'rh', 'chord', 76), V(4, 4, 'rh', 'chord', 72)] },
    { hits: [V(0, 8, 'lh', 'chord', 70), V(0, 6, 'rh', 'chord', 76), V(6, 2, 'rh', 'chord', 70)] },
    { hits: [V(0, 8, 'lh', 'chord', 72), V(0, 8, 'rh', 'chord', 74)] },
  ],
  4: [
    { hits: [V(0, 4, 'lh', 'chord', 72), V(0, 4, 'rh', 'chord', 76)] },
  ],
};

const balladPatterns: Record<number, Pattern[]> = {
  16: [
    { hits: [V(0, 16, 'lh', 'chord', 62), ...[0, 2, 4, 6, 8, 10, 12, 14].map(t => V(t, 2, 'rh', 'arp', 60))] },
    { hits: [V(0, 4, 'lh', 'bass', 64), V(4, 4, 'lh', 'arp', 56), V(8, 4, 'lh', 'arp', 58), V(12, 4, 'lh', 'arp', 54), V(0, 16, 'rh', 'chord', 62)] },
    { hits: [V(0, 16, 'lh', 'chord', 60), V(0, 8, 'rh', 'chord', 62), V(8, 8, 'rh', 'chord', 58)] },
    { hits: [V(0, 16, 'lh', 'chord', 60), ...[0, 4, 8, 12].map(t => V(t, 4, 'rh', 'arp', 60))] },
  ],
  8: [
    { hits: [V(0, 8, 'lh', 'chord', 62), ...[0, 2, 4, 6].map(t => V(t, 2, 'rh', 'arp', 60))] },
    { hits: [V(0, 8, 'lh', 'chord', 60), V(0, 8, 'rh', 'chord', 62)] },
  ],
  4: [
    { hits: [V(0, 4, 'lh', 'chord', 62), V(0, 4, 'rh', 'chord', 62)] },
  ],
};

export const STYLES: StyleDef[] = [
  {
    id: 'jazz', name: 'Jazz', desc: 'Shell & rootless voicings',
    defaults: { feel: 'swing8', swing: 0.66, density: 0.5, tension: 1, register: 0, pushProb: 0.15, humanize: 0.5, embellish: 0.3, fills: 0.35, fillStyle: 'jazz' },
    patterns: jazzPatterns, voice: jazzVoice,
  },
  {
    id: 'neosoul', name: 'Neo-Soul', desc: '9th / 11th / 13th colors',
    defaults: { feel: 'sixteenth', swing: 0.56, density: 0.45, tension: 2, register: 0, pushProb: 0.25, humanize: 0.6, embellish: 0.5, fills: 0.45, fillStyle: 'contemporary' },
    patterns: neosoulPatterns, voice: neosoulVoice,
  },
  {
    id: 'pop', name: 'Pop', desc: 'Block chords',
    defaults: { feel: 'straight8', swing: 0.5, density: 0.6, tension: 0, register: 0, pushProb: 0.15, humanize: 0.3, embellish: 0.2, fills: 0.25, fillStyle: 'basic' },
    patterns: popPatterns, voice: popVoice,
  },
  {
    id: 'ballad', name: 'Ballad', desc: 'Arpeggiated',
    defaults: { feel: 'straight8', swing: 0.5, density: 0.35, tension: 1, register: 0, pushProb: 0, humanize: 0.5, embellish: 0.4, fills: 0.5, fillStyle: 'mix' },
    patterns: balladPatterns, voice: balladVoice,
  },
];

export function getStyle(id: StyleId): StyleDef {
  return STYLES.find(s => s.id === id)!;
}

export const FEELS: { id: Feel; name: string; swingable: boolean }[] = [
  { id: 'swing8', name: 'Swing 8ths', swingable: true },
  { id: 'straight8', name: 'Straight 8ths', swingable: false },
  { id: 'sixteenth', name: '16 Beat', swingable: true },
  { id: 'shuffle16', name: 'Shuffle 16ths', swingable: true },
];
