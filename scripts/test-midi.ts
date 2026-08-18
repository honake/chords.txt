// Sanity test: parse → generate → MIDI bytes
import { parseProgression, generateSong, gridToBeats } from '../src/lib/generate';
import { songToMidi } from '../src/lib/midi';
import { STYLES } from '../src/lib/styles';
import * as fs from 'node:fs';

const { bars, errors } = parseProgression('| [335] Cmaj7 A7 | Dm7 G7 | Em7 >A7b9 | [clave] Dm7 G7! | ^C6 |');
console.log('bars:', bars.length, 'errors:', errors);
if (errors.length) throw new Error('unexpected parse errors');
if (bars[0].figure !== '3-3-10') throw new Error('figure alias not normalized: ' + bars[0].figure);
if (bars[3].figure !== 'clave') throw new Error('figure not parsed');
if (bars[2].segments[1].push !== 2) throw new Error('8th push not parsed');
if (bars[4].segments[0].push !== 1) throw new Error('16th push (^) not parsed');
if (!bars[3].segments[1].stab) throw new Error('stab marker not parsed');
const p4 = parseProgression('| C | >>F |').bars[1].segments[0].push;
if (p4 !== 4) throw new Error('quarter push (>>) not parsed');
// literal digit figures
const dig = parseProgression('| [4-4-4-4] C | [2-2] G7 |');
if (dig.errors.length) throw new Error('digit figure errored');
const digGen = generateSong(dig.bars, 'pop', 7, STYLES[2].defaults);
if (!digGen.events.some(e => e.start >= 16)) throw new Error('digit figure bar 2 empty');
const badFig = parseProgression('| [9-9-9] C |');
if (!badFig.errors.some(e => e.includes('unknown figure'))) throw new Error('overlong digit figure should error');
const bad = parseProgression('| [nope] C |');
if (!bad.errors.some(e => e.includes('unknown figure'))) throw new Error('unknown figure should error');

// per-hit chord mapping in figure bars: [335] C C Bm7 → C@0 (6), Bm7@6 (10)
const ph = parseProgression('| [335] Cmaj7 Cmaj7 Bm7 |');
if (ph.errors.length) throw new Error('per-hit parse errored: ' + ph.errors.join());
const segs = ph.bars[0].segments;
if (segs.length !== 2) throw new Error('expected 2 merged segments, got ' + segs.length);
if (segs[0].chord.symbol !== 'Cmaj7' || segs[0].startSixteenth !== 0 || segs[0].sixteenths !== 6) throw new Error('bad seg0');
if (segs[1].chord.symbol !== 'Bm7' || segs[1].startSixteenth !== 6 || segs[1].sixteenths !== 10) throw new Error('bad seg1');
// last chord fills remaining hits: [3322] C Bm7 → C@0, Bm7@3..
const fill = parseProgression('| [3322] Cmaj7 Bm7 |').bars[0].segments;
if (fill.length !== 2 || fill[1].startSixteenth !== 3 || fill[1].sixteenths !== 13) throw new Error('bad fill mapping');
// too many chords for the figure
const many = parseProgression('| [charleston] C D E |');
if (!many.errors.some(e => e.includes('takes at most'))) throw new Error('over-count should error');

for (const style of STYLES) {
  const song = generateSong(bars, style.id, 42, { ...style.defaults, pushProb: 0.5, fills: 0.9, embellish: 0.9 });
  const midi = songToMidi(song, 120, 'Test Song');
  console.log(style.id, 'events:', song.events.length, 'midi bytes:', midi.length);
  if (String.fromCharCode(...midi.slice(0, 4)) !== 'MThd') throw new Error('bad header');
  let trackCount = 0;
  for (let i = 0; i < midi.length - 3; i++) {
    if (midi[i] === 0x4d && midi[i + 1] === 0x54 && midi[i + 2] === 0x72 && midi[i + 3] === 0x6b) trackCount++;
  }
  if (trackCount !== 3) throw new Error('expected 3 tracks, got ' + trackCount);
  const totalSixteenths = bars.length * 16;
  for (const e of song.events) {
    if (e.midi < 0 || e.midi > 127) throw new Error('midi out of range: ' + e.midi);
    if (e.vel < 1 || e.vel > 127) throw new Error('vel out of range: ' + e.vel);
    if (e.d <= 0) throw new Error('non-positive duration');
    if (e.start < 0 || e.start + e.d > totalSixteenths + 2) throw new Error(`event out of song: start=${e.start} d=${e.d}`);
    const b0 = gridToBeats(e.start, song.settings);
    const b1 = gridToBeats(e.start + e.d, song.settings);
    if (b1 <= b0) throw new Error('non-monotonic timing map');
  }
  // no overlapping events within one hand at the same pitch
  for (const hand of ['lh', 'rh'] as const) {
    const evs = song.events.filter(e => e.hand === hand).sort((a, b) => a.start - b.start);
    for (let i = 1; i < evs.length; i++) {
      const prev = evs.filter(e => e.midi === evs[i].midi && e.start < evs[i].start);
      for (const p of prev) {
        if (p.start + p.d > evs[i].start) throw new Error(`${style.id}/${hand}: overlap at ${evs[i].start} (midi ${evs[i].midi})`);
      }
    }
  }
}
// harmony analyzer
import { analyzeProgression, inferKey } from '../src/lib/harmony';
{
  const p = parseProgression('| Cmaj7 A7 | Dm7 G7 | Cmaj7 |');
  const segs = p.bars.flatMap(b => b.segments.map(s => ({ chord: s.chord, sixteenths: s.sixteenths })));
  if (inferKey(segs) !== 0) throw new Error('key inference failed (expected C)');
  const an = analyzeProgression(segs);
  if (an[1].func !== 'secondary-dom') throw new Error('A7 should be a secondary dominant, got ' + an[1].func);
  if (!an[1].tensions.includes(13)) throw new Error('A7→Dm7 should recommend b9');
  if (an[3].func !== 'dominant' || !an[3].tensions.includes(14)) throw new Error('G7→C should be mixolydian');
  if (an[0].func !== 'tonic' || !an[0].avoid.includes(17)) throw new Error('Cmaj7 should avoid the 11th');
}
// sections
{
  const p = parseProgression('# Verse\n| C | G |\n# Chorus\n| F | C |');
  if (p.sections.length !== 2) throw new Error('expected 2 sections');
  if (p.sections[0].bar !== 0 || p.sections[0].label !== 'Verse') throw new Error('bad section 0');
  if (p.sections[1].bar !== 2 || p.sections[1].label !== 'Chorus') throw new Error('bad section 1');
}
// transpose
import { transposeSymbol } from '../src/lib/theory';
{
  if (transposeSymbol('Cmaj7', 2, 'D') !== 'Dmaj7') throw new Error('transpose root failed');
  if (transposeSymbol('C/E', 2, 'D') !== 'D/F#') throw new Error('transpose bass failed');
  if (transposeSymbol('C6/9', 2, 'D') !== 'D6/9') throw new Error('transpose 6/9 failed');
  if (transposeSymbol('Bb7#9', 1, 'B') !== 'B7#9') throw new Error('transpose alt failed');
}
// half-diminished must not get a natural 9th
{
  const p = parseProgression('| C#m7b5 | F#7 | Bm7 |');
  for (const st of STYLES) {
    const song = generateSong(p.bars, st.id, 5, { ...st.defaults, fills: 0, embellish: 0 });
    const bad = song.events.filter(e => e.start < 16 && ((e.midi - 1) % 12 + 12) % 12 === 2);
    if (bad.length) throw new Error(st.id + ': natural 9 on C#m7b5');
  }
}
// hands must not collide: RH floor above LH root, no cross-hand unisons, no fills in figure bars
{
  const p = parseProgression('| [3-3-10] Dmaj9 Dmaj9 C#m7 | E7sus4 | Amaj9 |');
  const st = STYLES.find(x => x.id === 'neosoul');
  const song = generateSong(p.bars, 'neosoul', 9, { ...st.defaults, tension: 2, fills: 1, register: 0 });
  if (song.events.some(e => e.fill && e.start < 16)) throw new Error('fill inside a figure bar');
  const lh = song.events.filter(e => e.hand === 'lh');
  for (const r of song.events.filter(e => e.hand === 'rh' && !e.fill)) {
    for (const l of lh) {
      const overlap = l.start < r.start + r.d && l.start + l.d > r.start;
      if (overlap && r.midi <= l.midi) throw new Error('RH not above LH at ' + r.start + ' (rh ' + r.midi + ' vs lh ' + l.midi + ')');
    }
  }
}
// key inference on a looping vamp ending on V: must pick A, and iii (C#m7) must not get an out-of-key 9th (D#)
{
  const p = parseProgression('| Amaj9 | C#m7 F#m9 | [3-3-10] Dmaj9 Dmaj9 C#m7 | Bm9 E7sus4 |');
  const flat = p.bars.flatMap(b => b.segments.map(s => ({ chord: s.chord, sixteenths: s.sixteenths })));
  if (inferKey(flat) !== 9) throw new Error('vamp key should be A, got pc ' + inferKey(flat));
  const st = STYLES.find(x => x.id === 'neosoul')!;
  for (const seed of [1, 5, 9]) {
    const song = generateSong(p.bars, 'neosoul', seed, { ...st.defaults, tension: 2, fills: 0, register: 0 });
    const bad = song.events.filter(e => e.start >= 38 && e.start < 48 && e.midi % 12 === 3);
    if (bad.length) throw new Error('D# on C#m7 in key A (seed ' + seed + ')');
  }
}
// swing 8ths: fills stay on the triplet grid (no lone 16th pickups at the 4th subdivision)
{
  const p = parseProgression('| Cmaj7 A7 | Dm7 G7 | Em7 A7 | Dm7 G7 |');
  const st = STYLES.find(x => x.id === 'jazz');
  for (const seed of [1, 2, 3, 4, 5]) {
    const song = generateSong(p.bars, 'jazz', seed, { ...st.defaults, feel: 'swing8', fills: 1 });
    for (const e of song.events.filter(x => x.fill)) {
      if (e.d === 1 && e.start % 4 === 3) throw new Error('16th pickup at sub3 under swing8 (start ' + e.start + ')');
    }
  }
}
// timing map is strictly increasing for every feel
for (const feel of ['swing8', 'straight8', 'sixteenth', 'shuffle16'] as const) {
  for (const swing of [0.5, 0.62, 0.75]) {
    const s = { ...STYLES[0].defaults, feel, swing };
    let last = -1;
    for (let abs = 0; abs <= 64; abs++) {
      const b = gridToBeats(abs, s);
      if (b <= last) throw new Error(`non-monotonic: feel=${feel} swing=${swing} abs=${abs}`);
      last = b;
    }
  }
}
console.log('OK');
