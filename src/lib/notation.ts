// ---- Score rendering with VexFlow ----
import {
  Flow, Renderer, Stave, StaveNote, Voice, Formatter, Beam, StaveTie,
  Accidental, Annotation, AnnotationVerticalJustify, StaveConnector, Dot, Barline,
} from 'vexflow';
import type { KeyName } from './theory';
import { midiToVexKey, prettySymbol } from './theory';
import type { BarSpec, Song, NoteEvent, SectionMark } from './generate';
import { getFigure } from './generate';

export const SCORE_WIDTH = 1080;
const MARGIN = 36;
const INK = '#1b1712';

export interface BarGeom { bar: number; x: number; y: number; w: number; h: number }
export interface ScoreGeom { width: number; height: number; bars: BarGeom[] }

export interface ScoreOpts {
  key: KeyName;
  title: string;
  tempo: number;
  styleName: string;
  feelName: string;
  /** notate obbligato fills on the piano score (default true) */
  showFills?: boolean;
}

/**
 * Prepare events for engraving. With fills shown, a chord that is still
 * ringing when a fill starts is cut at the fill (the player lifts into the run);
 * with fills hidden, fill notes are dropped and chords keep their full length.
 */
function prepareForScore(events: NoteEvent[], showFills: boolean): NoteEvent[] {
  const fills = events.filter(e => e.fill);
  if (!showFills) return events.filter(e => !e.fill);
  if (fills.length === 0) return events;
  const out = events.map(e => ({ ...e }));
  for (const f of fills) {
    for (const e of out) {
      if (e.fill || e.hand !== 'rh') continue;
      if (e.start < f.start && e.start + e.d > f.start) e.d = f.start - e.start;
    }
  }
  return out.filter(e => e.d > 0);
}

// ---------- rhythm spelling ----------

const DUR_NAMES: Record<number, string> = { 16: 'w', 12: 'hd', 8: 'h', 6: 'qd', 4: 'q', 3: '8d', 2: '8', 1: '16' };
const NOTE_VALS = [16, 12, 8, 6, 4, 3, 2, 1];
const REST_VALS = [8, 4, 2, 1];

interface Piece { t: number; d: number }

function nextBarrier(t: number): number {
  if (t % 4 !== 0) return Math.floor(t / 4) * 4 + 4; // off-beat: stop at next beat
  return 16;
}

/** Split an arbitrary (start, dur) on the 16th grid into notatable tied pieces. */
function spellNote(start: number, dur: number): Piece[] {
  const pieces: Piece[] = [];
  let t = start;
  let rem = dur;
  let guard = 0;
  while (rem > 0 && guard++ < 32) {
    let chunk = Math.min(rem, nextBarrier(t) - t);
    while (chunk > 0) {
      let v = NOTE_VALS.find(x => x <= chunk && (x !== 16 || t === 0) && (x !== 12 || t === 0 || t === 4))!;
      if ((v === 6 || v === 3) && chunk - v === 1) v = v === 6 ? 4 : 2;
      pieces.push({ t, d: v });
      t += v; chunk -= v; rem -= v;
    }
  }
  return pieces;
}

function spellRest(start: number, dur: number): Piece[] {
  if (start === 0 && dur === 16) return [{ t: 0, d: 16 }];
  const pieces: Piece[] = [];
  let t = start;
  let rem = dur;
  let guard = 0;
  while (rem > 0 && guard++ < 32) {
    let chunk = Math.min(rem, nextBarrier(t) - t);
    while (chunk > 0) {
      const v = REST_VALS.find(x => x <= chunk && (x !== 8 || t % 8 === 0) && (x !== 4 || t % 4 === 0) && (x !== 2 || t % 2 === 0))!;
      pieces.push({ t, d: v });
      t += v; chunk -= v; rem -= v;
    }
  }
  return pieces;
}

// ---------- slicing absolute events into bars ----------

interface BarGroup { t: number; d: number; midis: number[]; tieFrom: boolean; tieTo: boolean }

/** events (absolute 16ths) → per-bar groups per hand, split at barlines with tie flags */
function sliceEvents(events: NoteEvent[], barCount: number): Record<'rh' | 'lh', BarGroup[]>[] {
  const out: Record<'rh' | 'lh', BarGroup[]>[] = Array.from({ length: barCount }, () => ({ rh: [], lh: [] }));
  // group simultaneous chord events
  const groups = new Map<string, { start: number; d: number; midis: number[]; hand: 'rh' | 'lh' }>();
  for (const e of events) {
    const k = `${e.hand}:${e.start}`;
    const g = groups.get(k);
    if (g) { g.midis.push(e.midi); g.d = Math.max(g.d, e.d); }
    else groups.set(k, { start: e.start, d: e.d, midis: [e.midi], hand: e.hand });
  }
  for (const g of [...groups.values()].sort((a, b) => a.start - b.start)) {
    let pos = g.start;
    let rem = g.d;
    let first = true;
    while (rem > 0) {
      const bar = Math.floor(pos / 16);
      if (bar >= barCount) break;
      const t = pos % 16;
      const d = Math.min(rem, 16 - t);
      out[bar][g.hand].push({
        t, d,
        midis: g.midis,
        tieFrom: !first,
        tieTo: rem > d,
      });
      pos += d; rem -= d; first = false;
    }
  }
  return out;
}

// ---------- note building ----------

interface BuiltBar {
  notes: StaveNote[];
  ties: { from: StaveNote; to: StaveNote; count: number }[];
  atTick: Map<number, StaveNote>;
  tieIn: { note: StaveNote; count: number }[];   // expects tie from previous bar
  tieOut: { note: StaveNote; count: number }[];  // holds over into next bar
}

function buildHandBar(groups: BarGroup[], clef: 'treble' | 'bass', key: KeyName): BuiltBar {
  const restKey = clef === 'treble' ? 'b/4' : 'd/3';
  const notes: StaveNote[] = [];
  const ties: BuiltBar['ties'] = [];
  const atTick = new Map<number, StaveNote>();
  const tieIn: BuiltBar['tieIn'] = [];
  const tieOut: BuiltBar['tieOut'] = [];

  const sorted = [...groups].sort((a, b) => a.t - b.t);

  const pushRests = (from: number, to: number) => {
    if (to <= from) return;
    for (const p of spellRest(from, to - from)) {
      const dn = p.d === 16 ? 'w' : DUR_NAMES[p.d];
      const n = new StaveNote({ keys: [restKey], duration: dn + 'r', clef });
      if (!atTick.has(p.t)) atTick.set(p.t, n);
      notes.push(n);
    }
  };

  let cursor = 0;
  for (const g of sorted) {
    if (g.t < cursor) continue;
    pushRests(cursor, g.t);
    const clipped = Math.min(g.d, 16 - g.t);
    if (clipped <= 0) continue;
    const keys = [...g.midis].sort((a, b) => a - b).map(m => midiToVexKey(m, key));
    const pieces = spellNote(g.t, clipped);
    let prev: StaveNote | null = null;
    let firstNote: StaveNote | null = null;
    for (const p of pieces) {
      const dn = DUR_NAMES[p.d];
      const n = new StaveNote({ keys, duration: dn, clef });
      if (dn.endsWith('d')) Dot.buildAndAttach([n], { all: true });
      if (!atTick.has(p.t)) atTick.set(p.t, n);
      notes.push(n);
      if (!firstNote) firstNote = n;
      if (prev) ties.push({ from: prev, to: n, count: keys.length });
      prev = n;
    }
    if (g.tieFrom && firstNote) tieIn.push({ note: firstNote, count: keys.length });
    if (g.tieTo && prev) tieOut.push({ note: prev, count: keys.length });
    cursor = g.t + clipped;
  }
  pushRests(cursor, 16);

  if (notes.length === 0) {
    const n = new StaveNote({ keys: [restKey], duration: 'wr', clef });
    atTick.set(0, n);
    notes.push(n);
  }
  return { notes, ties, atTick, tieIn, tieOut };
}

function chordAnnotation(text: string, size: number, family: string): Annotation {
  const a = new Annotation(prettySymbol(text));
  a.setFont(family, size, 'normal');
  a.setVerticalJustification(AnnotationVerticalJustify.TOP);
  return a;
}

function makeVoice(notes: StaveNote[]): Voice {
  const v = new Voice({ num_beats: 4, beat_value: 4 });
  v.setMode(Voice.Mode.SOFT);
  v.addTickables(notes);
  return v;
}

function setupRenderer(el: HTMLDivElement, width: number, height: number) {
  el.innerHTML = '';
  const renderer = new Renderer(el, Renderer.Backends.SVG);
  renderer.resize(width, height);
  const ctx = renderer.getContext();
  ctx.setFillStyle(INK);
  ctx.setStrokeStyle(INK);
  return { renderer, ctx };
}

interface HeaderFonts { title: string; sub: string; titleSize: number; subSize: number }

function drawHeader(
  ctx: ReturnType<Renderer['getContext']>, opts: ScoreOpts, width: number, subtitle: string, fonts: HeaderFonts,
) {
  ctx.save();
  ctx.setFont(fonts.title, fonts.titleSize, '700');
  const tw = ctx.measureText(opts.title).width;
  ctx.fillText(opts.title, (width - tw) / 2, 48);
  ctx.setFont(fonts.sub, fonts.subSize, '500');
  const st = `${opts.styleName} · ${opts.feelName} · ♩= ${opts.tempo} · ${subtitle}`;
  ctx.fillText(st, MARGIN, 78);
  ctx.restore();
}

const drawTie = (ctx: ReturnType<Renderer['getContext']>, from: StaveNote | undefined, to: StaveNote | undefined, count: number) => {
  const indices = Array.from({ length: count }, (_, k) => k);
  new StaveTie({
    first_note: from, last_note: to,
    first_indices: indices, last_indices: indices,
  }).setContext(ctx).draw();
};

// ---------- lead sheet ----------

const JAZZ_TEXT = 'PetalumaScript, Archivo, sans-serif';

/**
 * Lead sheet with real chart rhythm:
 * - plain bars: four stemless slashes with chord symbols (comping "time")
 * - pushed changes: the chord attacks early (e.g. the "and" of 4), tied over the barline
 * - stabs: one short slash hit, then rests
 * - figure bars: the figure's rhythm, spelled out
 * Site-specific markers (^ > >> !) never appear — only standard notation.
 */
export function renderLeadSheet(el: HTMLDivElement, bars: BarSpec[], opts: ScoreOpts, sections: SectionMark[] = []): ScoreGeom {
  Flow.setMusicFont('Petaluma');
  const barsPerLine = 4;
  const sectionAt = new Map(sections.map(s => [s.bar, s.label]));
  const lineBars: number[][] = [];
  {
    let cur: number[] = [];
    bars.forEach((_, i) => {
      if (cur.length >= barsPerLine || (cur.length > 0 && sectionAt.has(i))) {
        lineBars.push(cur);
        cur = [];
      }
      cur.push(i);
    });
    if (cur.length > 0) lineBars.push(cur);
  }
  const lines = Math.max(1, lineBars.length);
  const topY = 124;
  const lineH = 132;
  const height = topY + lines * lineH + 20;
  const { ctx } = setupRenderer(el, SCORE_WIDTH, height);
  drawHeader(ctx, opts, SCORE_WIDTH, 'Lead Sheet', {
    title: JAZZ_TEXT, sub: JAZZ_TEXT, titleSize: 26, subSize: 14,
  });

  const geoms: BarGeom[] = [];
  const usable = SCORE_WIDTH - MARGIN * 2;
  const songEnd = bars.length * 16;

  // ---- global attack timeline (explicit pushes shift attacks ahead of the barline) ----
  interface LeadAttack { abs: number; d: number; label: string | null; stab: boolean }
  const attacks: LeadAttack[] = [];
  bars.forEach((bar, bi) => {
    const base = bi * 16;
    if (bar.figure) {
      const fig = getFigure(bar.figure)!;
      for (const h of fig.hits) {
        const seg = [...bar.segments].reverse().find(x => x.startSixteenth <= h.t);
        const isChordStart = bar.segments.some(x => x.startSixteenth === h.t);
        attacks.push({ abs: base + h.t, d: h.d, label: isChordStart && seg ? seg.chord.symbol : null, stab: false });
      }
    } else {
      for (const seg of bar.segments) {
        attacks.push({
          abs: Math.max(0, base + seg.startSixteenth - (seg.push ?? 0)),
          d: 0, // resolved below: rings until the next attack
          label: seg.chord.symbol,
          stab: !!seg.stab,
        });
      }
    }
  });
  attacks.sort((a, b) => a.abs - b.abs);
  // merge simultaneous attacks (e.g. a pushed change landing on a figure hit) — the chord change wins
  const merged: LeadAttack[] = [];
  for (const a of attacks) {
    const last = merged[merged.length - 1];
    if (last && last.abs === a.abs) {
      last.label = a.label ?? last.label;
      last.d = last.d === 0 || a.d === 0 ? 0 : Math.max(last.d, a.d);
      last.stab = last.stab || a.stab;
    } else {
      merged.push({ ...a });
    }
  }
  merged.forEach((a, i) => {
    const next = merged[i + 1]?.abs ?? songEnd;
    const room = Math.max(1, next - a.abs);
    a.d = a.stab ? Math.min(2, room) : a.d > 0 ? Math.min(a.d, room) : room;
  });

  // slice into per-bar pieces with cross-bar tie flags
  interface LeadPiece { t: number; d: number; label: string | null; tieFrom: boolean; tieTo: boolean }
  const barPieces: LeadPiece[][] = bars.map(() => []);
  for (const a of merged) {
    let pos = a.abs;
    let rem = a.d;
    let first = true;
    while (rem > 0) {
      const b = Math.floor(pos / 16);
      if (b >= bars.length) break;
      const t = pos % 16;
      const d = Math.min(rem, 16 - t);
      barPieces[b].push({ t, d, label: first ? a.label : null, tieFrom: !first, tieTo: rem > d });
      pos += d; rem -= d; first = false;
    }
  }

  // a bar keeps plain slash-time unless a push / stab / figure touches it
  const isPlain = bars.map((bar, bi) => {
    if (bar.figure) return false;
    if (bar.segments.some(s => s.push || s.stab)) return false;
    const next = bars[bi + 1];
    if (next && !next.figure && next.segments[0]?.push) return false;
    return true;
  });

  for (let line = 0; line < lines; line++) {
    const idxs = lineBars[line] ?? [];
    const inLine = idxs.length;
    const y = topY + line * lineH;
    let prevOut: { note: StaveNote } | null = null;

    for (let col = 0; col < inLine; col++) {
      const i = idxs[col];
      const bar = bars[i];
      if (sectionAt.has(i)) {
        ctx.save();
        ctx.setFont(JAZZ_TEXT, 14, '600');
        ctx.fillText(sectionAt.get(i)!, MARGIN + col * (usable / barsPerLine) + 2, y - 26);
        ctx.restore();
      }
      const w = usable / barsPerLine;
      const x = MARGIN + col * w;
      const stave = new Stave(x, y, w);
      if (col === 0) {
        stave.addClef('treble');
        stave.addKeySignature(opts.key);
        if (line === 0) stave.addTimeSignature('4/4');
      }
      if (i === bars.length - 1) stave.setEndBarType(Barline.type.END);
      stave.setContext(ctx).draw();

      const notes: StaveNote[] = [];
      const ties: { from: StaveNote; to: StaveNote }[] = [];
      let tieInNote: StaveNote | null = null;
      let tieOutNote: StaveNote | null = null;
      let hasTieFrom = false;

      if (isPlain[i]) {
        for (let beat = 0; beat < 4; beat++) {
          const n = new StaveNote({ keys: ['b/4'], duration: 'qs' });
          n.setStemStyle({ fillStyle: 'none', strokeStyle: 'none' });
          const seg = bar.segments.find(s => s.startSixteenth === beat * 4);
          if (seg) n.addModifier(chordAnnotation(seg.chord.symbol, 17, JAZZ_TEXT));
          notes.push(n);
        }
      } else {
        const pieces = [...barPieces[i]].sort((a, b) => a.t - b.t);
        const pushRest = (from: number, to: number) => {
          for (const p of spellRest(from, to - from)) {
            const dn = p.d === 16 ? 'w' : DUR_NAMES[p.d];
            notes.push(new StaveNote({ keys: ['b/4'], duration: dn + 'r' }));
          }
        };
        let cursor = 0;
        for (const piece of pieces) {
          if (piece.t < cursor) continue;
          if (piece.t > cursor) pushRest(cursor, piece.t);
          let prev: StaveNote | null = null;
          let firstNote: StaveNote | null = null;
          for (const p of spellNote(piece.t, piece.d)) {
            const dn = DUR_NAMES[p.d];
            const n = new StaveNote({ keys: ['b/4'], duration: dn + 's' });
            if (dn.endsWith('d')) Dot.buildAndAttach([n], { all: true });
            notes.push(n);
            if (!firstNote) firstNote = n;
            if (prev) ties.push({ from: prev, to: n });
            prev = n;
          }
          if (piece.label && firstNote) firstNote.addModifier(chordAnnotation(piece.label, 17, JAZZ_TEXT));
          if (piece.tieFrom && firstNote) { tieInNote = firstNote; hasTieFrom = true; }
          if (piece.tieTo && prev) tieOutNote = prev;
          cursor = piece.t + piece.d;
        }
        if (cursor < 16) pushRest(cursor, 16);
        if (notes.length === 0) notes.push(new StaveNote({ keys: ['b/4'], duration: 'wr' }));
      }

      const voice = makeVoice(notes);
      const beams = isPlain[i] ? [] : Beam.generateBeams(notes);
      new Formatter().joinVoices([voice]).formatToStave([voice], stave);
      voice.draw(ctx, stave);
      for (const b of beams) b.setContext(ctx).draw();
      for (const t of ties) drawTie(ctx, t.from, t.to, 1);

      // cross-bar ties (pushed changes ringing over the barline)
      if (hasTieFrom && tieInNote) {
        if (prevOut) drawTie(ctx, prevOut.note, tieInNote, 1);
        else drawTie(ctx, undefined, tieInNote, 1); // continued from the previous system
      }
      if (col === inLine - 1 && tieOutNote) {
        drawTie(ctx, tieOutNote, undefined, 1); // hangs into the next system
      }
      prevOut = tieOutNote ? { note: tieOutNote } : null;

      geoms.push({ bar: i, x, y: y - 14, w, h: 96 });
    }
  }

  return { width: SCORE_WIDTH, height, bars: geoms };
}

// ---------- piano score ----------

/** Measure how much horizontal space a bar's content really needs. */
function measureBarWidth(
  rhGroups: BarGroup[], lhGroups: BarGroup[], key: KeyName,
): number {
  const rhB = buildHandBar(rhGroups, 'treble', key);
  const lhB = buildHandBar(lhGroups, 'bass', key);
  const tv = makeVoice(rhB.notes);
  const bv = makeVoice(lhB.notes);
  Accidental.applyAccidentals([tv], key);
  Accidental.applyAccidentals([bv], key);
  const f = new Formatter().joinVoices([tv]).joinVoices([bv]);
  return f.preCalculateMinTotalWidth([tv, bv]);
}

/** Width consumed by clef/key(/time) before the first note of a line. */
function lineOverhead(key: KeyName, withTime: boolean): number {
  const s = new Stave(0, 0, 600);
  s.addClef('treble').addKeySignature(key);
  if (withTime) s.addTimeSignature('4/4');
  return s.getNoteStartX() - s.getX();
}

export function renderPianoScore(el: HTMLDivElement, song: Song, opts: ScoreOpts): ScoreGeom {
  Flow.setMusicFont('Bravura');
  const bars = song.bars;
  const sectionAt = new Map((song.sections ?? []).map(s => [s.bar, s.label]));
  const topY = 116;
  const staffGap = 84;
  const systemH = 84 + staffGap + 92;
  const usable = SCORE_WIDTH - MARGIN * 2;
  const sliced = sliceEvents(prepareForScore(song.events, opts.showFills !== false), bars.length);

  // pass 1: measure each bar, then pack bars into lines (max 4, fit by content)
  const PAD = 36; // barline + breathing room per bar
  const MIN_BAR = 100;
  const minWidths = bars.map((_, i) =>
    Math.max(MIN_BAR, measureBarWidth(sliced[i].rh, sliced[i].lh, opts.key) + PAD));

  const lineBars: number[][] = [];
  {
    let cur: number[] = [];
    let sum = 0;
    bars.forEach((_, i) => {
      const overhead = lineOverhead(opts.key, lineBars.length === 0) + 8;
      if (cur.length > 0 && (cur.length >= 4 || sectionAt.has(i) || sum + minWidths[i] > usable - overhead)) {
        lineBars.push(cur);
        cur = [];
        sum = 0;
      }
      cur.push(i);
      sum += minWidths[i];
    });
    if (cur.length > 0) lineBars.push(cur);
  }

  const lines = lineBars.length;
  const height = topY + lines * systemH + 20;
  const { ctx } = setupRenderer(el, SCORE_WIDTH, height);
  drawHeader(ctx, opts, SCORE_WIDTH, 'Piano', {
    title: 'Archivo, sans-serif', sub: 'Archivo, sans-serif', titleSize: 22, subSize: 11,
  });

  const geoms: BarGeom[] = [];

  for (let line = 0; line < lines; line++) {
    const idxs = lineBars[line];
    const y = topY + line * systemH;
    const overhead = lineOverhead(opts.key, line === 0) + 8;
    const sumMin = idxs.reduce((a, i) => a + minWidths[i], 0);
    const noteSpace = usable - overhead;
    // stretch to justify, but don't over-stretch a sparse final system
    let scale = noteSpace / sumMin;
    if (line === lines - 1) scale = Math.min(scale, 1.6);

    let x = MARGIN;
    let prevBuilt: { rh: BuiltBar; lh: BuiltBar } | null = null;

    for (let col = 0; col < idxs.length; col++) {
      const i = idxs[col];
      const isFirst = col === 0;
      const w = minWidths[i] * scale + (isFirst ? overhead : 0);
      const treble = new Stave(x, y, w);
      const bass = new Stave(x, y + staffGap, w);
      if (isFirst) {
        treble.addClef('treble').addKeySignature(opts.key);
        bass.addClef('bass').addKeySignature(opts.key);
        if (line === 0) {
          treble.addTimeSignature('4/4');
          bass.addTimeSignature('4/4');
        }
      }
      if (i === bars.length - 1) {
        treble.setEndBarType(Barline.type.END);
        bass.setEndBarType(Barline.type.END);
      }
      treble.setContext(ctx).draw();
      bass.setContext(ctx).draw();
      if (isFirst) {
        new StaveConnector(treble, bass).setType(StaveConnector.type.BRACE).setContext(ctx).draw();
        new StaveConnector(treble, bass).setType(StaveConnector.type.SINGLE_LEFT).setContext(ctx).draw();
      }
      new StaveConnector(treble, bass).setType(StaveConnector.type.SINGLE_RIGHT).setContext(ctx).draw();

      if (sectionAt.has(i)) {
        ctx.save();
        ctx.setFont('Archivo, sans-serif', 12, '700');
        ctx.fillText(sectionAt.get(i)!, x + 2, y - 30);
        ctx.restore();
      }
      const rhBuilt = buildHandBar(sliced[i].rh, 'treble', opts.key);
      const lhBuilt = buildHandBar(sliced[i].lh, 'bass', opts.key);

      // chord symbols above treble at segment starts (pushed chords marked with >)
      for (const seg of bars[i].segments) {
        let target: StaveNote | undefined;
        for (let t = seg.startSixteenth; t < seg.startSixteenth + seg.sixteenths; t++) {
          if (rhBuilt.atTick.has(t)) { target = rhBuilt.atTick.get(t); break; }
        }
        (target ?? rhBuilt.notes[0])?.addModifier(chordAnnotation(seg.chord.symbol, 13, 'Archivo, sans-serif'));
      }

      const tv = makeVoice(rhBuilt.notes);
      const bv = makeVoice(lhBuilt.notes);
      Accidental.applyAccidentals([tv], opts.key);
      Accidental.applyAccidentals([bv], opts.key);

      const rhBeams = Beam.generateBeams(rhBuilt.notes);
      const lhBeams = Beam.generateBeams(lhBuilt.notes);

      new Formatter().joinVoices([tv]).joinVoices([bv]).formatToStave([tv, bv], treble);
      tv.draw(ctx, treble);
      bv.draw(ctx, bass);
      for (const b of [...rhBeams, ...lhBeams]) b.setContext(ctx).draw();

      for (const built of [rhBuilt, lhBuilt]) {
        for (const t of built.ties) drawTie(ctx, t.from, t.to, t.count);
      }

      // cross-bar ties
      const hands: ('rh' | 'lh')[] = ['rh', 'lh'];
      for (const hand of hands) {
        const cur = hand === 'rh' ? rhBuilt : lhBuilt;
        const prev = prevBuilt ? prevBuilt[hand] : null;
        cur.tieIn.forEach((tin, k) => {
          const tout = prev?.tieOut[k];
          if (tout) drawTie(ctx, tout.note, tin.note, Math.min(tout.count, tin.count));
          else drawTie(ctx, undefined, tin.note, tin.count); // continued from previous system
        });
        if (col === idxs.length - 1) {
          // held into a bar on the next system — draw hanging tie
          for (const tout of cur.tieOut) drawTie(ctx, tout.note, undefined, tout.count);
        }
      }

      geoms.push({ bar: i, x, y: y - 16, w, h: staffGap + 96 });
      prevBuilt = { rh: rhBuilt, lh: lhBuilt };
      x += w;
    }
  }

  return { width: SCORE_WIDTH, height, bars: geoms };
}
