// ---- Progression parsing & backing generation ----
import type { Chord } from './theory';
import { parseChord, anatomy } from './theory';
import type { StyleId, Hand, GrooveSettings, Pattern } from './styles';
import { getStyle } from './styles';
import { analyzeProgression } from './harmony';
import type { ChordAnalysis } from './harmony';

export interface Segment {
  chord: Chord;
  startSixteenth: number;
  sixteenths: number;
  /** anticipation in 16ths: "^C7"=1 (16分食い), ">C7"=2 (8分食い), ">>C7"=4 (4分食い) */
  push?: number;
  stab?: boolean;  // "Cmaj7!" — short ensemble hit (キメ)
}

/** push marker for display: 1→^, 2→>, 4→>> */
export function pushMark(push: number | undefined): string {
  if (!push) return '';
  return push === 1 ? '^' : push === 4 ? '>>' : '>';
}
export interface BarSpec {
  segments: Segment[];
  figure?: string; // "[335] Cmaj7" — named rhythmic figure for the whole bar
}

// ---- named rhythm figures (キメ / シンコペーションの定番形) ----

export interface RhythmFigure {
  id: string;
  label: string;
  hits: { t: number; d: number }[]; // 16th grid, non-overlapping, ascending
}

function fromDurations(id: string, label: string, durs: number[]): RhythmFigure {
  let t = 0;
  const hits = durs.map(d => {
    const h = { t, d };
    t += d;
    return h;
  });
  return { id, label, hits };
}

/** Named figures — each is just a spelled-out duration list. */
export const FIGURES: RhythmFigure[] = [
  fromDurations('3-3-10', 'ta··ta··taa (3-3-2 hold)', [3, 3, 10]),
  fromDurations('3-3-2-3-3-2', 'double tresillo', [3, 3, 2, 3, 3, 2]),
  fromDurations('charleston', 'Charleston', [6, 10]),
  fromDurations('clave', 'son clave (3-2)', [3, 3, 4, 2, 4]),
  fromDurations('6-6-4', '1 · 2& · 4 (pop push)', [6, 6, 4]),
];

const FIGURE_ALIASES: Record<string, string> = {
  '335': '3-3-10', room335: '3-3-10', tresillo: '3-3-10', '332': '3-3-10',
  '3322': '3-3-2-3-3-2',
  synco: '6-6-4',
  son: 'clave',
};

/**
 * Resolve a figure id: a named figure ("charleston"), an alias ("335"),
 * or a literal duration list in 16ths like "3-3-10" (sum ≤ 16; remainder = rest).
 */
export function getFigure(id: string): RhythmFigure | undefined {
  const key = FIGURE_ALIASES[id] ?? id;
  const named = FIGURES.find(f => f.id === key);
  if (named) return named;
  if (/^\d+(-\d+)+$/.test(key)) {
    const durs = key.split('-').map(Number);
    if (durs.some(d => d < 1 || d > 16)) return undefined;
    if (durs.reduce((a, b) => a + b, 0) > 16) return undefined;
    return fromDurations(key, key, durs);
  }
  return undefined;
}

export interface SectionMark { bar: number; label: string }

export interface ParseResult {
  bars: BarSpec[];
  errors: string[];
  sections: SectionMark[];
}

/**
 * Parse text like:
 *   | Cmaj7 Am7 | Dm7 G7 |
 *   | Fmaj7 | % |
 * Bars split by '|', chords by whitespace. '%' repeats previous bar.
 * 1 chord = whole bar, 2 = half each, 3 = 2+1+1 beats, 4 = quarter each.
 * Markers: ">C7" anticipates the chord an 8th early, "C7!" plays it as a short stab.
 */
export function parseProgression(text: string): ParseResult {
  const errors: string[] = [];
  const bars: BarSpec[] = [];
  const sections: SectionMark[] = [];
  let pending: string | null = null;
  const commit = () => {
    if (pending != null) {
      sections.push({ bar: bars.length - 1, label: pending });
      pending = null;
    }
  };
  const cells: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const lt = line.trim();
    if (lt.length === 0) continue;
    if (lt.startsWith('#')) {
      cells.push('\u0000' + lt.replace(/^#+\s*/, ''));
      continue;
    }
    for (const c of lt.split('|').map(x => x.trim()).filter(x => x.length > 0)) cells.push(c);
  }

  for (let cell of cells) {
    if (cell.startsWith('\u0000')) {
      pending = cell.slice(1) || null;
      continue;
    }
    if (cell === '%' || cell === '％') {
      if (bars.length > 0) {
        const prev = bars[bars.length - 1];
        bars.push({ segments: prev.segments.map(s => ({ ...s })), figure: prev.figure });
        commit();
      } else {
        errors.push(`Bar ${bars.length + 1}: % cannot start the progression`);
      }
      continue;
    }
    // bar-level rhythm figure: "[335] Cmaj7"
    let figure: string | undefined;
    const fm = cell.match(/^\[([a-z0-9-]+)\]\s*(.*)$/i);
    if (fm) {
      const id = fm[1].toLowerCase();
      if (getFigure(id)) {
        figure = FIGURE_ALIASES[id] ?? id;
        cell = fm[2];
      } else {
        errors.push(`Bar ${bars.length + 1}: unknown figure "[${fm[1]}]" — use 16th durations like [3-3-10] (sum <= 16) or ${FIGURES.map(f => f.id).join(' / ')}`);
        cell = fm[2];
      }
    }
    const tokens = cell.split(/\s+/).filter(t => t.length > 0);
    const parsedTokens: { chord: Chord; push: number; stab: boolean }[] = [];
    let bad = false;
    for (let tk of tokens) {
      let push = 0;
      const pm = tk.match(/^(\^|>>|>)/);
      if (pm) {
        push = pm[1] === '^' ? 1 : pm[1] === '>' ? 2 : 4;
        tk = tk.slice(pm[1].length);
      }
      const stab = tk.endsWith('!');
      if (stab) tk = tk.slice(0, -1);
      const c = parseChord(tk);
      if (!c) {
        errors.push(`Bar ${bars.length + 1}: cannot parse "${tk}"`);
        bad = true;
      } else {
        parsedTokens.push({ chord: c, push, stab });
      }
    }
    if (bad || parsedTokens.length === 0) {
      if (!bad) errors.push(`Bar ${bars.length + 1}: empty bar`);
      continue;
    }
    if (figure) {
      // figure bar: chords map to hits in order (the last chord fills remaining hits)
      // e.g. "[335] Cmaj7 Cmaj7 Bm7" → hit1,2 = Cmaj7 / hit3 = Bm7
      const fig = getFigure(figure)!;
      if (parsedTokens.length > fig.hits.length) {
        errors.push(`Bar ${bars.length + 1}: [${figure}] takes at most ${fig.hits.length} chords (one per hit)`);
        continue;
      }
      const boundaries: { tok: typeof parsedTokens[number]; t: number }[] = [];
      fig.hits.forEach((h, i) => {
        const tok = parsedTokens[Math.min(i, parsedTokens.length - 1)];
        const prevTok = i > 0 ? parsedTokens[Math.min(i - 1, parsedTokens.length - 1)] : null;
        if (i === 0 || tok.chord.symbol !== prevTok!.chord.symbol) boundaries.push({ tok, t: h.t });
      });
      bars.push({
        segments: boundaries.map((b, i) => ({
          chord: b.tok.chord,
          startSixteenth: b.t,
          sixteenths: (i + 1 < boundaries.length ? boundaries[i + 1].t : 16) - b.t,
          push: b.tok.push,
          stab: b.tok.stab,
        })),
        figure,
      });
      commit();
      continue;
    }
    let layout: [number, number][] | null;
    switch (parsedTokens.length) {
      case 1: layout = [[0, 16]]; break;
      case 2: layout = [[0, 8], [8, 8]]; break;
      case 3: layout = [[0, 8], [8, 4], [12, 4]]; break;
      case 4: layout = [[0, 4], [4, 4], [8, 4], [12, 4]]; break;
      default:
        errors.push(`Bar ${bars.length + 1}: up to 4 chords per bar`);
        layout = null;
    }
    if (!layout) continue;
    bars.push({
      segments: parsedTokens.map((t, i) => ({
        chord: t.chord,
        startSixteenth: layout![i][0],
        sixteenths: layout![i][1],
        push: t.push,
        stab: t.stab,
      })),
      figure,
    });
    commit();
  }
  return { bars, errors, sections };
}

// ---- generation ----

export interface NoteEvent {
  start: number;  // absolute 16th from song start
  d: number;      // duration in 16ths
  midi: number;
  vel: number;    // 0-127
  hand: Hand;
  fill?: boolean; // part of an obbligato pickup run
}

export interface Song {
  bars: BarSpec[];
  events: NoteEvent[];
  styleId: StyleId;
  settings: GrooveSettings;
  seed: number;
  sections: SectionMark[];
}

/** RH voicings sit this many semitones below the style's written ranges — the sweet spot. */
const REGISTER_BASE = -8;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Weighted pattern choice honoring density (busyness) and feel (16th subdivision). */
function choosePattern(pool: Pattern[], settings: GrooveSettings, rnd: () => number, lastIdx: number): number {
  const counts = pool.map(p => p.hits.length);
  const min = Math.min(...counts);
  const max = Math.max(...counts);
  const target = min + settings.density * (max - min);
  const wantsSixteenth = settings.feel === 'sixteenth' || settings.feel === 'shuffle16';
  const weights = pool.map((p, i) => {
    let w = 1 / (1 + Math.abs(p.hits.length - target));
    // swing 8ths lives on the swing grid — 16th-subdivision comps would break the feel entirely
    if (p.sixteenth) w *= wantsSixteenth ? 2.2 : settings.feel === 'swing8' ? 0 : 0.35;
    else if (wantsSixteenth) w *= 0.8;
    if (i === lastIdx && pool.length > 1) w *= 0.25;
    return w;
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rnd() * total;
  for (let i = 0; i < pool.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return pool.length - 1;
}

export function generateSong(bars: BarSpec[], styleId: StyleId, seed: number, settings: GrooveSettings, sections: SectionMark[] = []): Song {
  const style = getStyle(styleId);
  const rnd = mulberry32(seed || 1);
  const events: NoteEvent[] = [];
  let prevRh: number[] | null = null;
  let prevRoot: number | null = null;
  let lastPatternIdx = -1;

  // chord-scale analysis, one entry per segment in reading order
  const flatForAnalysis = bars.flatMap(b => b.segments.map(s => ({ chord: s.chord, sixteenths: s.sixteenths })));
  const analyses: ChordAnalysis[] = analyzeProgression(flatForAnalysis);
  let segCursor = 0;
  const nextAnalysis = () => analyses[segCursor++] ?? null;
  const harmonyOf = (a: ChordAnalysis | null) =>
    a ? { tensions: a.tensions, avoid: a.avoid } : undefined;

  const humanVel = (base: number) =>
    Math.max(20, Math.min(120, Math.round(base + (rnd() - 0.5) * 22 * settings.humanize)));

  /** Truncate previously emitted events so nothing rings over an anticipated attack. */
  const truncateBefore = (cut: number) => {
    for (const e of events) {
      if (e.start < cut && e.start + e.d > cut) e.d = Math.max(1, cut - e.start);
      else if (e.start >= cut) e.d = 0; // stray hit inside the push window — drop
    }
  };

  bars.forEach((bar, barIdx) => {
    const isLastBar = barIdx === bars.length - 1;

    // --- named figure bar: both hands play the figure in rhythmic unison ---
    if (bar.figure) {
      const fig = getFigure(bar.figure)!;
      const voicings = bar.segments.map(seg => {
        const v = style.voice(seg.chord, {
          prevRh, prevRoot,
          tension: settings.tension,
          register: settings.register + REGISTER_BASE,
          harmony: harmonyOf(nextAnalysis()),
        });
        prevRh = v.rh;
        prevRoot = v.lh[0] ?? prevRoot;
        return v;
      });
      const segAt = (t: number) => {
        let idx = 0;
        bar.segments.forEach((s, i) => { if (s.startSixteenth <= t) idx = i; });
        return idx;
      };
      fig.hits.forEach((hit, hi) => {
        const v = voicings[segAt(hit.t)];
        const start = barIdx * 16 + hit.t;
        const d = Math.min(hit.d, 16 - hit.t);
        const accent = hi === 0 ? 6 : 0;
        for (const midi of v.rh) events.push({ start, d, midi, vel: humanVel(84 + accent), hand: 'rh' });
        for (const midi of v.lh) events.push({ start, d, midi, vel: humanVel(88 + accent), hand: 'lh' });
      });
      return;
    }

    bar.segments.forEach((seg, segIdx) => {
      const segAbs = barIdx * 16 + seg.startSixteenth;
      const { lh, rh } = style.voice(seg.chord, {
        prevRh, prevRoot,
        tension: settings.tension,
        register: settings.register,
        harmony: harmonyOf(nextAnalysis()),
      });
      prevRh = rh;
      prevRoot = lh[0] ?? prevRoot;

      // --- push (食い): anticipate this chord change (^=16分, >=8分, >>=4分) ---
      const atBarStart = seg.startSixteenth === 0;
      const prevBar = barIdx > 0 ? bars[barIdx - 1] : null;
      const autoPush = !seg.push && !seg.stab && atBarStart && prevBar != null &&
        !prevBar.figure && !prevBar.segments.some(s => s.stab) && rnd() < settings.pushProb;
      const pushAmt = seg.push ?? (autoPush ? 2 : 0);
      const pushed = pushAmt > 0 && segAbs >= pushAmt;
      if (pushed) truncateBefore(segAbs - pushAmt);

      // --- stab (キメ): one short accented hit, then silence ---
      if (seg.stab) {
        const t = pushed ? segAbs - pushAmt : segAbs;
        for (const midi of rh) events.push({ start: t, d: 2, midi, vel: humanVel(96), hand: 'rh' });
        for (const midi of lh) events.push({ start: t, d: 2, midi, vel: humanVel(100), hand: 'lh' });
        return;
      }

      const pool = style.patterns[seg.sixteenths] ?? style.patterns[4];
      const idx = choosePattern(pool, settings, rnd, seg.sixteenths === 16 ? lastPatternIdx : -1);
      if (seg.sixteenths === 16) lastPatternIdx = idx;

      const pattern = (isLastBar && segIdx === bar.segments.length - 1 && seg.sixteenths >= 8)
        ? { hits: [
            { t: 0, d: seg.sixteenths, hand: 'lh' as Hand, kind: 'chord' as const, vel: 64 },
            { t: 0, d: seg.sixteenths, hand: 'rh' as Hand, kind: 'chord' as const, vel: 68 },
          ] }
        : pool[idx];

      const arpIdx: Record<Hand, number> = { lh: 0, rh: 0 };
      const arpNotes: Record<Hand, number[]> = { lh: arpSequence(lh), rh: arpSequence(rh) };

      // when pushed, each hand's first attack is pulled ahead of the barline
      const minT: Record<Hand, number> = { lh: Infinity, rh: Infinity };
      for (const h of pattern.hits) minT[h.hand] = Math.min(minT[h.hand], h.t);

      const segEventsFrom = events.length;
      for (const hit of pattern.hits) {
        if (hit.t >= seg.sixteenths) continue;
        let d = Math.min(hit.d, seg.sixteenths - hit.t);
        let start = segAbs + hit.t;
        if (pushed && hit.t === minT[hit.hand] && hit.t <= 4) {
          start = segAbs - pushAmt;
          d += hit.t + pushAmt;
        }
        const notes = hit.hand === 'lh' ? lh : rh;
        if (hit.kind === 'chord') {
          for (const midi of notes) events.push({ start, d, midi, vel: humanVel(hit.vel), hand: hit.hand });
        } else if (hit.kind === 'bass') {
          events.push({ start, d, midi: notes[0], vel: humanVel(hit.vel), hand: hit.hand });
        } else {
          const seq = arpNotes[hit.hand];
          const midi = seq[arpIdx[hit.hand] % seq.length];
          arpIdx[hit.hand]++;
          events.push({ start, d, midi, vel: humanVel(hit.vel), hand: hit.hand });
        }
      }

      // --- embellish: EP inner-voice clichés (9→3, 4→3, maj7→6) on the first chord ---
      if (settings.embellish > 0 && rnd() < settings.embellish) {
        const segRh = events.slice(segEventsFrom).filter(e => e.hand === 'rh');
        if (segRh.length >= 3) {
          const t0 = Math.min(...segRh.map(e => e.start));
          const firstChord = segRh.filter(e => e.start === t0);
          const dMax = Math.max(...firstChord.map(e => e.d));
          if (firstChord.length >= 3 && dMax >= 6) {
            const a = anatomy(seg.chord);
            const byIv = (iv: number | null) => iv == null ? undefined :
              firstChord.find(e => (((e.midi - seg.chord.root) % 12) + 12) % 12 === ((iv % 12) + 12) % 12);
            // swing 8ths: keep cliché resolutions on the 8th grid (odd 16ths would read as straight 16ths)
            const evenGrid = settings.feel === 'swing8';
            const d1 = dMax >= 12 ? 6 : dMax >= 8 ? 4 : evenGrid ? 2 : 3;
            const taken = (m: number) => firstChord.some(e => e.midi === m);
            const moves: (() => void)[] = [];
            const clicheOk = seg.chord.quality !== 'hdim' && seg.chord.quality !== 'dim';
            const thirdEv = clicheOk && (a.third === 3 || a.third === 4) ? byIv(a.third) : undefined;
            if (thirdEv && thirdEv.d >= 6 && a.third != null) {
              const iv3 = a.third;
              const target = thirdEv.midi;
              const softVel = Math.max(30, thirdEv.vel - 8);
              // 2-3 cliché: start on the 9th, melt into the 3rd
              if (!taken(target - (iv3 - 2))) {
                moves.push(() => {
                  const origD = thirdEv.d;
                  thirdEv.midi = target - (iv3 - 2);
                  thirdEv.d = d1;
                  events.push({ start: t0 + d1, d: Math.max(2, origD - d1), midi: target, vel: softVel, hand: 'rh' });
                });
              }
              // sus4 resolve
              if ((seg.chord.quality === 'dom' || seg.chord.quality === 'maj') && !taken(target + (5 - iv3))) {
                moves.push(() => {
                  const origD = thirdEv.d;
                  thirdEv.midi = target + (5 - iv3);
                  thirdEv.d = d1;
                  events.push({ start: t0 + d1, d: Math.max(2, origD - d1), midi: target, vel: softVel, hand: 'rh' });
                });
              }
            }
            // maj7 drifts down to 6 late in the chord
            const seventhEv = a.seventh === 11 ? byIv(11) : undefined;
            if (seventhEv && seventhEv.d >= 8 && !taken(seventhEv.midi - 2)) {
              moves.push(() => {
                const origD = seventhEv.d;
                let late = Math.max(d1, origD - 4);
                if (evenGrid && late % 2 === 1) late = Math.max(2, late - 1);
                seventhEv.d = late;
                events.push({ start: t0 + late, d: Math.max(2, origD - late), midi: seventhEv.midi - 2, vel: Math.max(30, seventhEv.vel - 10), hand: 'rh' });
              });
            }
            if (moves.length > 0) moves[Math.floor(rnd() * moves.length)]();
          }
        }
      }
    });
  });

  // --- articulation: lift notes off before the next attack, add comp stabs ---
  {
    const rhAttacks = [...new Set(events.filter(e => e.hand === 'rh').map(e => e.start))].sort((a, b) => a - b);
    const groups = new Map<string, NoteEvent[]>();
    for (const e of events) {
      const k = `${e.hand}:${e.start}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(e);
    }
    for (const [k, g] of groups) {
      const [hand, startStr] = k.split(':');
      const start = Number(startStr);
      const d = Math.max(...g.map(e => e.d));
      const crossesBar = (start % 16) + d > 16; // pushed/tied chords keep ringing
      if (crossesBar) continue;
      if (hand === 'rh') {
        const next = rhAttacks.find(a => a > start);
        const gapToNext = next != null ? next - (start + d) : Infinity;
        let cut = 0;
        if (gapToNext === 0 && d >= 6 && rnd() < 0.5) cut = 2;        // breathe before the next hit
        else if (gapToNext === 0 && d >= 3 && rnd() < 0.35) cut = 1;
        else if (d >= 3 && d <= 6 && rnd() < 0.25) cut = d - 2;       // short comp stab
        if (cut > 0) for (const e of g) e.d = Math.max(1, e.d - cut);
      } else if (d >= 4 && d < 16 && rnd() < 0.3) {
        for (const e of g) e.d = Math.max(2, e.d - 1);                // LH lift
      }
    }
  }

  // --- fills (オブリ): melodic answers & pickups in the holes between chords ---
  // Modeled on real comping practice (Red Garland / Wynton Kelly call-&-response,
  // gospel runs in 3rds & 6ths, neo-soul pentatonic flurries):
  //   response — a self-contained answer to the chord just played: starts in the
  //     hole after the attack (usually on an offbeat), sings on pentatonic/blues
  //     material of that chord, has a contour peak, lands on a stable tone, and
  //     leaves a breath before the next chord arrives.
  //   pickup — a run converging on the next chord's top voice. Enclosures and
  //     chromatic cells are spice here, not the whole diet.
  if (settings.fills > 0) {
    const flat: { chord: Chord; abs: number; stab: boolean; fig: boolean }[] = [];
    bars.forEach((bar, bi) =>
      bar.segments.forEach(s => flat.push({ chord: s.chord, abs: bi * 16 + s.startSixteenth, stab: !!s.stab, fig: !!bar.figure })));
    const step = settings.feel === 'sixteenth' || settings.feel === 'shuffle16' ? 1 : 2;
    const eighthFeel = settings.feel === 'swing8' || settings.feel === 'straight8';
    const swingFeel = settings.feel === 'swing8';

    //   s = scale steps · c = chromatic semitones · d = 16ths (default: grid step)
    //   v = velocity offset (negative = ghost/grace)
    type LickTok = { s?: number; c?: number; d?: number; v?: number };

    // Swing 8ths lives on the triplet grid: 16ths only as a [1,1,2] cell starting
    // on a beat; every other note must sit on the 8th grid.
    const swingSafe = (toks: LickTok[], startAbs: number) => {
      const ds = toks.map(t => t.d ?? step);
      let pos = startAbs;
      for (let k = 0; k < ds.length; k++) {
        if (ds[k] === 1) {
          if (pos % 4 === 0 && ds[k + 1] === 1 && ds[k + 2] === 2) { pos += 4; k += 2; }
          else return false;
        } else {
          if (pos % 2 !== 0) return false;
          pos += ds[k];
        }
      }
      return true;
    };

    // ---- pickup licks: notes BEFORE the target, s/c relative to the NEXT chord's top voice
    const LICKS: Record<string, LickTok[][]> = {
      gospel: [
        [{ s: -3 }, { s: -2 }, { s: -1 }],                                        // pentatonic climb
        [{ s: -2 }, { s: -1 }, { c: -1 }],                                        // 1-2-b3-3 blue slide
        [{ s: 1 }, { s: -2 }, { s: -1 }],                                         // over-under turn
        [{ s: -4 }, { s: -3 }, { s: -2 }, { s: -1 }],                             // long stairway
        [{ s: 2 }, { s: 1 }, { s: -1 }, { c: -1 }],                               // over the top, slide in
        [{ s: -2, d: 1, v: -14 }, { s: -1, d: 1 }, { c: -1, d: 2 }],              // grace roll (triplet cell)
        [{ c: -1, d: 1, v: -16 }, { s: -1, d: 1 }, { s: -2, d: 2 }, { s: -1, d: 2 }], // crush + rock back
        [{ s: -3, d: 1 }, { s: -2, d: 1 }, { s: -1, d: 2 }],                      // triplet climb
        [{ s: 1, d: 1 }, { s: -1, d: 1 }, { s: -2, d: 2 }, { s: -1, d: 4 }],      // turn, then sit on the lead-in
      ],
      blues: [
        [{ s: 3 }, { s: 2 }, { s: 1 }],                                           // falling off the top
        [{ s: -1 }, { s: 1 }, { c: 1 }],                                          // curl from above
        [{ s: 2 }, { s: 1 }, { c: -1 }],                                          // drop, then slide in
        [{ s: 4 }, { s: 3 }, { s: 2 }, { s: 1 }],                                 // long tumble
        [{ c: -2, d: 1, v: -16 }, { c: -1, d: 1 }, { s: 1, d: 2 }, { c: -1, d: 2 }], // crush into the blue note
        [{ s: 3, d: 1 }, { s: 2, d: 1 }, { s: 1, d: 2 }],                         // triplet tumble
        [{ s: -1, d: 1 }, { c: -1, d: 1 }, { s: -1, d: 2 }],                      // hammer flick
        [{ s: 1, d: 2 }, { s: 1, d: 1, v: -12 }, { c: -1, d: 1 }],                // repeated-note stutter
      ],
      jazz: [
        [{ s: 2 }, { s: 1 }, { c: 1 }],                                           // bebop descent
        [{ s: -3 }, { s: -2 }, { s: -1 }],                                        // arpeggio pickup
        [{ s: 3 }, { s: 2 }, { s: 1 }, { c: 1 }],                                 // longer bebop descent
        [{ s: 4 }, { s: 3 }, { s: 2 }, { s: 1 }],                                 // cascade
        [{ s: -2 }, { s: -1 }, { c: 2 }, { c: -1 }],                              // scale up into enclosure (spice)
        [{ s: 1, d: 1 }, { c: -1, d: 1 }, { s: 1, d: 2 }],                        // gruppetto turn (triplet)
        [{ s: -2, d: 2 }, { s: -1, d: 1 }, { c: -1, d: 1 }],                      // ride up + chromatic snap
        [{ s: 2, d: 1 }, { s: 1, d: 1 }, { c: 1, d: 1 }, { c: -1, d: 1 }],        // fast bebop cell
      ],
      contemporary: [
        [{ s: -4 }, { s: -2 }, { s: -1 }],                                        // wide pentatonic rip
        [{ s: 2 }, { s: -1 }, { s: 1 }],                                          // over-under, 4ths flavor
        [{ s: -2 }, { s: 1 }, { s: -1 }],                                         // weave
        [{ s: -1, d: 1, v: -14 }, { s: -2, d: 1 }, { s: -1, d: 2 }],              // grace drag (triplet cell)
        [{ s: -5, d: 1 }, { s: -3, d: 1 }, { s: -2, d: 1 }, { s: -1, d: 1 }],     // fast 16th rip
        [{ s: -6, d: 1 }, { s: -4, d: 1 }, { s: -3, d: 1 }, { s: -2, d: 1 }, { s: -1, d: 2 }], // big rip
        [{ s: 1, d: 1, v: -12 }, { s: -1, d: 1 }, { s: -2, d: 2 }, { s: -1, d: 2 }], // flicked weave
      ],
    };

    // ---- response licks: s/c offsets FROM the current chord's top voice (0 = re-strike it).
    // Contours, not runs-to-a-target: fall / arc / turn / rip / sigh.
    // A long last note is the phrase landing on a stable tone.
    const RESPONSES: Record<string, LickTok[][]> = {
      gospel: [
        [{ s: 0 }, { s: -1 }, { s: -2 }, { s: -3, d: step * 2 }],                 // penta fall (3rds/6ths under)
        [{ s: 1 }, { s: 0 }, { s: -1 }, { s: -2, d: step * 2 }],                  // over the top, settle
        [{ s: -4, d: 1, v: -10 }, { s: -3, d: 1 }, { s: -2, d: 1 }, { s: -1, d: 1 }, { s: 0, d: 4, v: 4 }], // shout rip
        [{ c: -1, d: 1, v: -16 }, { c: 0, d: 1 }, { s: -1, d: 2 }, { s: -2, d: step * 2 }], // crush, then amen
        [{ s: -2 }, { s: -1, d: step * 2 }],                                      // short sigh
        [{ s: -1 }, { s: -2, d: 2 }],                                              // quick sigh (fits half-bar chords)
      ],
      blues: [
        [{ s: 0 }, { s: -1 }, { s: -2 }, { s: -4, d: step * 2, v: -4 }],          // fall to the floor
        [{ c: -1, d: 1, v: -14 }, { c: 0, d: 1 }, { s: -2, d: step * 2 }],        // hammer, then drop
        [{ s: 0, d: 1 }, { s: 0, d: 1, v: -10 }, { s: 0, d: 2, v: -4 }],          // triplet chop
        [{ s: 1 }, { s: 0 }, { s: -1 }, { s: 0, d: step * 2 }],                   // curl back home
        [{ s: -1 }, { s: -2, d: step * 2 }],                                      // sigh
        [{ s: 1 }, { s: 0, d: 2 }],                                                // quick curl (fits half-bar chords)
      ],
      jazz: [
        [{ s: 0 }, { s: 1 }, { s: 0 }, { s: -2, d: step * 2 }],                   // singable answer (5-6-5-3)
        [{ s: 0 }, { s: -1 }, { s: -2 }, { s: -3, d: step * 2, v: -4 }],          // fall-off
        [{ s: -2 }, { s: -1 }, { s: 0, d: step * 2, v: 3 }],                      // rising question
        [{ s: 1 }, { s: 0 }, { s: -1 }, { s: 0, d: step * 2 }],                   // turn
        [{ s: 0, d: 1 }, { s: 0, d: 1, v: -12 }, { s: -2, d: 2 }, { s: -1, d: step * 2 }], // bounce & settle
        [{ s: 1 }, { s: -1, d: 2 }],                                               // quick answer (fits half-bar chords)
        [{ s: -1 }, { s: -2, d: 2 }],                                              // quick fall (fits half-bar chords)
      ],
      contemporary: [
        [{ s: -4, d: 1, v: -12 }, { s: -2, d: 1, v: -8 }, { s: -1, d: 1 }, { s: 0, d: 1 }, { s: -2, d: step * 2 }], // flurry
        [{ s: 0 }, { s: -1 }, { s: -2, d: step * 2 }],                            // 4ths slide (dyads under)
        [{ s: 0, d: 3, v: -4 }, { s: -1, d: 3, v: -6 }, { s: -2, d: step * 2 }],  // 3-against-4 hemiola
        [{ s: 1, d: 1, v: -14 }, { s: 0, d: 1 }, { s: -2, d: 1, v: -10 }, { s: -1, d: step * 2 }], // ghost weave
        [{ s: -1 }, { s: -3, d: step * 2 }],                                      // wide drop
        [{ s: 1, v: -8 }, { s: -1, d: 2 }],                                        // quick flick (fits half-bar chords)
      ],
      basic: [
        [{ s: 1 }, { s: 0, d: step * 2 }],                                        // upper-neighbor sigh
        [{ s: -1 }, { s: -2, d: step * 2 }],
        [{ s: 0 }, { s: -1 }, { s: -2, d: step * 2 }],
      ],
    };

    let lastLick: unknown = null;   // never play the same phrase twice in a row
    let lastGapFilled = false;      // and breathe: back-to-back holes rarely both get fills
    for (let i = 0; i + 1 < flat.length; i++) {
      const S = flat[i];
      const N = flat[i + 1];
      if (S.stab || S.fig) { lastGapFilled = false; continue; } // kime figures ring — no fills on top of them
      const gate = settings.fills * (lastGapFilled ? 0.45 : 1);
      if (rnd() >= gate) { lastGapFilled = false; continue; }
      // the next chord's first RH attack (may be pushed ahead of the barline)
      const ahead = events.filter(e => e.hand === 'rh' && !e.fill && e.d > 0 && e.start >= N.abs - 4 && e.start <= N.abs + 6);
      if (ahead.length === 0) continue;
      const attackStart = Math.min(...ahead.map(e => e.start));
      const targetTop = Math.max(...events.filter(e => e.hand === 'rh' && e.start === attackStart).map(e => e.midi));
      const maxSpace = attackStart - (S.abs + 2);
      if (maxSpace < 2) continue;

      const VOCABS = ['basic', 'blues', 'gospel', 'jazz', 'contemporary'] as const;
      const vocab = settings.fillStyle === 'mix'
        ? VOCABS[Math.floor(rnd() * VOCABS.length)]
        : settings.fillStyle;
      const minorish = S.chord.quality === 'min' || S.chord.quality === 'hdim' || S.chord.quality === 'dim';

      const makeScale = (ivs: number[]) => {
        const pcs = ivs.map(iv => (S.chord.root + iv) % 12);
        const inScale = (n: number) => pcs.includes(((n % 12) + 12) % 12);
        const next = (from: number, d2: number) => {
          let n = from + d2;
          let guard = 0;
          while (!inScale(n) && guard++ < 11) n += d2;
          return n;
        };
        const stepFrom = (base: number, k: number) => {
          let n = base;
          const d2 = k > 0 ? 1 : -1;
          for (let j = 0; j < Math.abs(k); j++) n = next(n, d2);
          return n;
        };
        return { inScale, next, stepFrom };
      };
      const oddball = S.chord.quality === 'dim' || S.chord.quality === 'hdim' || S.chord.quality === 'aug';
      const pent = oddball ? S.chord.tones : minorish ? [0, 3, 5, 7, 10] : [0, 2, 4, 7, 9];
      // pickups ride chord/blues material toward the target
      const pickupScale = makeScale(
        vocab === 'gospel' || vocab === 'contemporary' ? pent
          : vocab === 'blues'
            ? (oddball ? S.chord.tones
              : minorish || S.chord.quality === 'dom' ? [0, 3, 5, 6, 7, 10] : [0, 2, 3, 4, 7, 9])
            : S.chord.tones);
      // answers SING — pentatonic/blues material even for jazz & basic
      const respScale = oddball ? makeScale(S.chord.tones)
        : vocab === 'jazz' || vocab === 'blues'
          ? makeScale(minorish ? [0, 3, 5, 7, 10] : [0, 2, 3, 4, 7, 9])
          : vocab === 'basic' ? makeScale(pent) : pickupScale;

      /** harmonize, shape dynamics around the contour peak, and push one phrase */
      const emit = (timed: { midi: number; d: number; v: number; t: number }[], scale: ReturnType<typeof makeScale>) => {
        if (timed.some(n => n.midi < 40 || n.midi > 96)) return false;
        // double-stops: gospel sings in 3rds & 6ths, contemporary in 4ths
        const dyads: (number | null)[] = timed.map(n => {
          if (n.v < 0) return null; // not on ghosts/graces
          if (vocab === 'gospel' && rnd() < 0.6) {
            const six = rnd() < 0.4;
            let c2 = n.midi - (six ? 8 : 3);
            let guard = 0;
            while (!scale.inScale(c2) && guard++ < 4) c2 -= 1;
            return guard <= 4 && n.midi - c2 <= (six ? 9 : 5) ? c2 : null;
          }
          if (vocab === 'contemporary' && rnd() < 0.35) {
            const c2 = n.midi - 5;
            return scale.inScale(c2) ? c2 : null;
          }
          return null;
        });
        // a same-pitch chord ATTACK during the phrase kills it…
        for (let j = 0; j < timed.length; j++) {
          for (const m of [timed[j].midi, dyads[j]]) {
            if (m == null) continue;
            if (events.some(e => e.hand === 'rh' && !e.fill && e.d > 0 && e.midi === m &&
              e.start >= timed[j].t && e.start < timed[j].t + timed[j].d)) return false;
          }
        }
        // …while a ringing chord note is simply lifted where the fill takes over
        for (let j = 0; j < timed.length; j++) {
          for (const m of [timed[j].midi, dyads[j]]) {
            if (m == null) continue;
            for (const e of events) {
              if (e.hand === 'rh' && !e.fill && e.midi === m && e.start < timed[j].t && e.start + e.d > timed[j].t) {
                e.d = Math.max(1, timed[j].t - e.start);
              }
            }
          }
        }
        // dynamics follow the contour: swell into the peak, place the landing
        const peak = timed.reduce((b, n, j, arr) => (n.midi > arr[b].midi ? j : b), 0);
        timed.forEach((n, j) => {
          const rise = Math.max(0, 12 - 4 * Math.abs(j - peak));
          const land = j === timed.length - 1 ? 5 : 0;
          const vel = Math.max(26, Math.min(92,
            Math.round(48 + rise + land + n.v + (rnd() - 0.5) * 12 * settings.humanize)));
          events.push({ start: n.t, d: n.d, midi: n.midi, vel, hand: 'rh', fill: true });
          const dy = dyads[j];
          if (dy != null) events.push({ start: n.t, d: n.d, midi: dy, vel: Math.max(24, vel - 10), hand: 'rh', fill: true });
        });
        return true;
      };

      const resolve = (toks: LickTok[], anchor: number, scale: ReturnType<typeof makeScale>, startT: number) => {
        let acc = startT;
        return toks.map(tok => {
          const t = acc;
          const d = tok.d ?? step;
          acc += d;
          return { midi: tok.c != null ? anchor + tok.c : scale.stepFrom(anchor, tok.s!), d, v: tok.v ?? 0, t };
        });
      };

      // ---------- response: answer the chord that's sounding ----------
      const tryResponse = () => {
        const sCand = events.filter(e => e.hand === 'rh' && !e.fill && e.d > 0 && e.start >= S.abs - 2 && e.start <= S.abs + 6);
        if (sCand.length === 0) return false;
        const sAttack = Math.min(...sCand.map(e => e.start));
        const anchor = Math.max(...events.filter(e => e.hand === 'rh' && !e.fill && e.start === sAttack).map(e => e.midi));
        const pool = RESPONSES[vocab] ?? RESPONSES.basic;
        const order = pool.map((_, j) => j).sort(() => rnd() - 0.5)
          .sort((x, y) => (pool[x] === lastLick ? 1 : 0) - (pool[y] === lastLick ? 1 : 0));
        for (const li of order) {
          const toks = pool[li];
          const total = toks.reduce((acc2, t) => acc2 + (t.d ?? step), 0);
          const tMin = sAttack + 2;                             // let the chord speak first
          const tMax = attackStart - Math.max(1, step) - total; // leave a breath before the next chord
          if (tMax < tMin) continue;
          const cands: number[] = [];
          for (let t = tMin; t <= tMax; t++) {
            if (eighthFeel && t % 2 !== 0) continue;
            if (swingFeel && !swingSafe(toks, t)) continue;
            // the pocket: no other chord attack inside the phrase
            if (events.some(e => e.hand === 'rh' && !e.fill && e.d > 0 && e.start >= t && e.start < t + total)) continue;
            cands.push(t);
          }
          if (cands.length === 0) continue;
          // favor offbeat entries ("the and") and the middle of the hole
          const ws = cands.map(t => (t % 4 === 2 ? 3 : t % 4 === 0 ? 1.5 : 2) * (1 + 0.15 * Math.min(t - tMin, tMax - t)));
          let r = rnd() * ws.reduce((acc2, w) => acc2 + w, 0);
          let t0 = cands[0];
          for (let j = 0; j < cands.length; j++) { r -= ws[j]; if (r <= 0) { t0 = cands[j]; break; } }
          if (emit(resolve(toks, anchor, respScale, t0), respScale)) { lastLick = toks; return true; }
        }
        return false;
      };

      // ---------- pickup: walk into the next chord's top voice ----------
      const tryPickup = () => {
        let notes: { midi: number; d: number; v: number }[] | null = null;
        const lickPool = LICKS[vocab];
        if (lickPool) {
          const fitting = lickPool
            .map(l => ({ toks: l, total: l.reduce((acc2, t) => acc2 + (t.d ?? step), 0) }))
            .filter(x => x.total <= maxSpace && (!swingFeel || swingSafe(x.toks, attackStart - x.total)));
          if (fitting.length > 0 && rnd() < 0.85) {
            let lick = fitting[Math.floor(rnd() * fitting.length)];
            if (lick.toks === lastLick && fitting.length > 1) lick = fitting[Math.floor(rnd() * fitting.length)];
            lastLick = lick.toks;
            notes = lick.toks.map(tok => ({
              midi: tok.c != null ? targetTop + tok.c : pickupScale.stepFrom(targetTop, tok.s!),
              d: tok.d ?? step,
              v: tok.v ?? 0,
            }));
          }
        }
        if (!notes) {
          // generative walk (basic vocabulary & fallback)
          const len = Math.min(Math.floor(maxSpace / step), 2 + Math.floor(rnd() * (step === 1 ? 3 : 2)));
          if (len < 2) return false;
          const fromBelow = rnd() < 0.55;
          const dir = fromBelow ? -1 : 1;
          const backward: number[] = [];
          // basic: neighbor-tone approach; everything else walks its scale (jazz = chord-tone arpeggio)
          let cur = vocab === 'basic'
            ? (fromBelow ? targetTop - 1 : targetTop + 2)
            : pickupScale.next(targetTop, dir);
          backward.push(cur);
          while (backward.length < len) {
            const steps = vocab === 'contemporary' && rnd() < 0.45 ? 2 : 1;
            for (let s2 = 0; s2 < steps; s2++) cur = pickupScale.next(cur, dir);
            backward.push(cur);
          }
          notes = backward.reverse().map(m => ({ midi: m, d: step, v: 0 }));
        }
        const total = notes.reduce((acc2, n) => acc2 + n.d, 0);
        const fillStart = attackStart - total;
        // keep the pocket: no other RH attacks inside the fill window
        if (events.some(e => e.hand === 'rh' && !e.fill && e.d > 0 && e.start >= fillStart && e.start < attackStart)) return false;
        let acc = fillStart;
        const timed = notes.map(n => { const t = acc; acc += n.d; return { ...n, t }; });
        return emit(timed, pickupScale);
      };

      // answers first (they're what makes comping sing); pickups at boundaries
      const respProb = vocab === 'basic' ? 0.5 : vocab === 'jazz' ? 0.55 : 0.6;
      lastGapFilled = (rnd() < respProb && tryResponse()) || tryPickup();
    }
  }

  return {
    bars,
    events: events.filter(e => e.d > 0),
    styleId,
    settings: { ...settings },
    seed,
    sections,
  };
}

/** up-down arpeggio sequence from a voicing */
function arpSequence(notes: number[]): number[] {
  if (notes.length === 0) return [60];
  if (notes.length === 1) return [notes[0], notes[0] + 12];
  const up = [...notes];
  const down = notes.slice(1, -1).reverse();
  return [...up, ...down];
}

/** Convert an absolute 16th-grid position to musical beats, honoring feel & swing. */
export function gridToBeats(abs: number, settings: GrooveSettings): number {
  const beat = Math.floor(abs / 4);
  const sub = ((abs % 4) + 4) % 4;
  const { feel } = settings;
  const s = Math.max(0.5, Math.min(0.78, settings.swing));
  let frac: number;
  if (feel === 'swing8') {
    frac = [0, s / 2, s, s + (1 - s) / 2][sub];
  } else if (feel === 'sixteenth' || feel === 'shuffle16') {
    frac = [0, 0.5 * s, 0.5, 0.5 + 0.5 * s][sub];
  } else {
    frac = sub / 4;
  }
  return beat + frac;
}
