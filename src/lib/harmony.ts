// ---- Harmonic analysis: key inference → function → chord-scale → tensions ----
// Encodes chord-scale theory (Berklee-style): each chord, in context, gets a
// scale, recommended tensions, and avoid notes. Explicit tensions written by
// the user always win over these recommendations.
import type { Chord } from './theory';

export interface ChordAnalysis {
  keyPc: number;                 // tonic of the inferred (major) key
  degree: number;                // root distance from key tonic (0-11)
  func: 'tonic' | 'subdominant' | 'dominant' | 'secondary-dom' | 'tritone-sub' | 'passing-dim' | 'backdoor' | 'other';
  scale: string;                 // chord-scale name (debug / future display)
  tensions: number[];            // recommended tensions (13=b9 14=9 15=#9 17=11 18=#11 20=b13 21=13)
  avoid: number[];               // intervals better left out
}

interface SegLite { chord: Chord; sixteenths: number }

const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];

const domish = (c: Chord) =>
  c.quality === 'dom' || (c.quality === 'sus' && c.tones.includes(10));
// a chord that can act as a major-key tonic (dom counts: blues I7)
const majorish = (c: Chord) =>
  c.quality !== 'min' && c.quality !== 'minmaj' && c.quality !== 'dim' && c.quality !== 'hdim';

/** Score all 12 major keys: diatonic fit weighted by duration + cadence bonuses. */
function keyScores(segs: SegLite[]): number[] {
  const scores: number[] = [];
  for (let k = 0; k < 12; k++) {
    const scale = new Set(MAJOR_SCALE.map(iv => (k + iv) % 12));
    // blues: a dom-quality tonic receiving V7→I motion (G7→C7) marks a blues
    // key, where the b7 on I7 and IV7 is idiomatic rather than out-of-key
    const blues = segs.length > 1 && segs.some((s, i) => {
      const next = segs[(i + 1) % segs.length];
      return domish(s.chord) && s.chord.root === (k + 7) % 12 &&
        next.chord.root === k && next.chord.quality === 'dom';
    });
    let score = 0;
    segs.forEach((s, i) => {
      // score with the chord's actual pitch classes (sus chords have no fabricated 3rd)
      const pcs = [...new Set(s.chord.tones.map(iv => (s.chord.root + iv) % 12))];
      const bluesDeg = blues && s.chord.quality === 'dom' &&
        (s.chord.root === k || s.chord.root === (k + 5) % 12);
      const inKey = pcs.filter(pc =>
        scale.has(pc) || (bluesDeg && pc === (s.chord.root + 10) % 12)).length / pcs.length;
      score += s.sixteenths * inKey;
      // cadence bonuses — progressions loop, so the last chord resolves to the first
      const next = segs.length > 1 ? segs[(i + 1) % segs.length] : null;
      if (next) {
        // V7 → I needs a major-ish tonic: V7 → i(min) is just as likely a
        // secondary dominant (A7 → Dm in C), which must not drag the key along.
        // A dom-quality target gets half credit: dom→dom down a fifth is as
        // often I7→IV7 in a blues (C7→F7) as a real cadence into that key.
        if (domish(s.chord) && s.chord.root === (k + 7) % 12 && next.chord.root === k &&
            majorish(next.chord)) score += next.chord.quality === 'dom' ? 12 : 24; // V7 → I
        if (s.chord.root === (k + 2) % 12 && s.chord.quality === 'min' &&
            next.chord.root === (k + 7) % 12 && domish(next.chord)) score += 12; // ii → V
      }
      // tonic bonuses only for chords that can be a major tonic — a minor chord
      // on k is vi/aeolian evidence for the relative major, not for k major
      if (i === segs.length - 1) {
        if (s.chord.root === k && majorish(s.chord)) score += 8; // ends on tonic
        if (domish(s.chord) && s.chord.root === (k + 7) % 12) score += 10; // half cadence / turnaround
      }
      if (i === 0 && s.chord.root === k && majorish(s.chord)) score += 6;
    });
    scores.push(score);
  }
  return scores;
}

/** Infer the best major key for a progression. */
export function inferKey(segs: SegLite[]): number {
  const scores = keyScores(segs);
  return scores.indexOf(Math.max(...scores));
}

/**
 * Analyze every segment in context.
 * sectionStarts (segment indices) split the song into key regions: each section
 * infers its own key, so a chorus that modulates doesn't drag the verse's
 * analysis with it (e.g. an Eb chorus turning the C-major iii chord's avoided
 * 9th back on). Key changes are sticky: a section keeps the previous section's
 * key unless its own key is decisively better — a short bridge full of
 * secondary dominants is ambiguous and should read in the surrounding key,
 * while a real modulation wins by a wide margin.
 */
export function analyzeProgression(segs: SegLite[], sectionStarts: number[] = []): ChordAnalysis[] {
  if (segs.length === 0) return [];
  const starts = [...new Set([0, ...sectionStarts])]
    .filter(i => i >= 0 && i < segs.length)
    .sort((a, b) => a - b);
  const sectionKeys: number[] = [];
  starts.forEach((from, si) => {
    const slice = segs.slice(from, starts[si + 1] ?? segs.length);
    if (si === 0) {
      sectionKeys.push(inferKey(slice));
      return;
    }
    const prev = sectionKeys[si - 1];
    const dur = slice.reduce((a, x) => a + x.sixteenths, 0);
    const scores = keyScores(slice);
    const best = scores.indexOf(Math.max(...scores));
    // switch only when the new key beats the inherited one by >15% of the
    // section's duration-weighted fit (2 bars minimum to modulate at all)
    sectionKeys.push(dur >= 32 && scores[best] - scores[prev] > 0.15 * dur ? best : prev);
  });
  const keyOfSeg = (i: number) => {
    let si = 0;
    while (si + 1 < starts.length && starts[si + 1] <= i) si++;
    return sectionKeys[si];
  };

  return segs.map((s, i) => {
    const key = keyOfSeg(i);
    const diatonic = new Set(MAJOR_SCALE.map(iv => (key + iv) % 12));
    const c = s.chord;
    const deg = ((c.root - key) % 12 + 12) % 12;
    const next = segs[(i + 1) % segs.length]?.chord;
    const nextIsMinorish = next && (next.quality === 'min' || next.quality === 'hdim' || next.quality === 'dim');
    const resolvesP5 = next != null && next.root === (c.root + 5) % 12;
    const resolvesHalf = next != null && next.root === (c.root + 11) % 12;

    let func: ChordAnalysis['func'] = 'other';
    let scale = '';
    let tensions: number[] = [];
    let avoid: number[] = [];

    switch (c.quality) {
      case 'dom':
      case 'aug': {
        if (resolvesP5 && nextIsMinorish) {
          // V7 of a minor chord — altered colors
          func = deg === 7 ? 'dominant' : 'secondary-dom';
          scale = 'altered / HmP5↓';
          tensions = [13, 15, 20];
        } else if (resolvesP5) {
          func = deg === 7 ? 'dominant' : 'secondary-dom';
          scale = 'mixolydian';
          tensions = [14, 21];
          avoid = [17];
        } else if (resolvesHalf) {
          func = 'tritone-sub';
          scale = 'lydian b7';
          tensions = [14, 18, 21];
        } else if (deg === 10 || deg === 3) {
          func = 'backdoor';               // bVII7 / bIII7
          scale = 'lydian b7';
          tensions = [14, 18, 21];
        } else {
          func = deg === 7 ? 'dominant' : 'other';
          scale = 'mixolydian';
          tensions = [14, 21];
          avoid = [17];
        }
        break;
      }
      case 'maj': {
        if (deg === 0) {
          func = 'tonic';
          scale = 'ionian';
          tensions = [14, 21];
          avoid = [17];
        } else if (deg === 5) {
          func = 'subdominant';
          scale = 'lydian';
          tensions = [14, 18, 21];
        } else {
          func = 'other';                  // modal interchange (bVI, bII…) — lydian is safe
          scale = 'lydian';
          tensions = [14, 18, 21];
        }
        break;
      }
      case 'min':
      case 'minmaj': {
        if (deg === 2) {
          func = 'subdominant';
          scale = 'dorian';
          tensions = [14, 17];
        } else if (deg === 4) {
          func = 'tonic';
          scale = 'phrygian';
          tensions = [17];                 // iii: the 9th clashes (b9 in the scale)
          avoid = [13, 14];
        } else if (deg === 9) {
          func = 'tonic';
          scale = 'aeolian';
          tensions = [14, 17];
          avoid = [20];
        } else if (deg === 0) {
          func = 'tonic';
          scale = 'minor (dorian)';
          tensions = [14, 17];
        } else {
          func = 'other';
          scale = 'dorian';
          tensions = [14, 17];
        }
        break;
      }
      case 'hdim': {
        func = 'subdominant';
        scale = 'locrian';
        tensions = [17];              // the 11th is the one safe color on ø
        avoid = [13, 14, 21];         // any 9th (and 13) clashes with locrian
        break;
      }
      case 'dim': {
        const isPassing = diatonic.has(((c.root + 11) % 12)) || diatonic.has(((c.root + 1) % 12));
        func = isPassing ? 'passing-dim' : 'other';
        scale = 'whole-half dim';
        tensions = [14];
        break;
      }
      case 'sus': {
        func = deg === 7 ? 'dominant' : 'other';
        scale = 'mixolydian';
        tensions = [14, 21];
        break;
      }
    }

    return { keyPc: key, degree: deg, func, scale, tensions, avoid };
  });
}
