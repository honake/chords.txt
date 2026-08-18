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

/** Infer the best major key: diatonic fit weighted by duration + cadence bonuses. */
export function inferKey(segs: SegLite[]): number {
  let bestKey = 0;
  let bestScore = -Infinity;
  for (let k = 0; k < 12; k++) {
    const scale = new Set(MAJOR_SCALE.map(iv => (k + iv) % 12));
    let score = 0;
    segs.forEach((s, i) => {
      const core = [0, s.chord.tones.includes(4) ? 4 : 3, s.chord.tones.includes(10) ? 10 : 11]
        .map(iv => (s.chord.root + iv) % 12);
      const inKey = core.filter(pc => scale.has(pc)).length / core.length;
      score += s.sixteenths * inKey;
      // cadence bonuses
      const next = segs[i + 1];
      if (next) {
        const isDom = s.chord.quality === 'dom';
        if (isDom && s.chord.root === (k + 7) % 12 && next.chord.root === k) score += 24; // V7 → I
        if (s.chord.root === (k + 2) % 12 && s.chord.quality === 'min' &&
            next.chord.root === (k + 7) % 12 && next.chord.quality === 'dom') score += 12; // ii → V
      }
      if (i === segs.length - 1 && s.chord.root === k) score += 16; // ends on tonic
      if (i === 0 && s.chord.root === k) score += 6;
    });
    if (score > bestScore) { bestScore = score; bestKey = k; }
  }
  return bestKey;
}

/** Analyze every segment in context. */
export function analyzeProgression(segs: SegLite[]): ChordAnalysis[] {
  if (segs.length === 0) return [];
  const key = inferKey(segs);
  const diatonic = new Set(MAJOR_SCALE.map(iv => (key + iv) % 12));

  return segs.map((s, i) => {
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
