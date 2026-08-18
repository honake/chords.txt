// ---- Music theory: chord parsing & pitch spelling ----

export interface Chord {
  symbol: string;        // display text as typed (prettified elsewhere)
  root: number;          // pitch class 0-11
  rootName: string;
  bass: number | null;   // slash bass pitch class
  bassName: string | null;
  tones: number[];       // semitone intervals from root (0 included)
  quality: 'maj' | 'min' | 'dom' | 'dim' | 'hdim' | 'aug' | 'sus' | 'minmaj';
}

const LETTER_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function parseNoteName(s: string): { pc: number; name: string } | null {
  const m = s.match(/^([A-G])(##|bb|#|b)?$/);
  if (!m) return null;
  let pc = LETTER_PC[m[1]];
  const acc = m[2] ?? '';
  if (acc === '#') pc += 1;
  else if (acc === 'b') pc -= 1;
  else if (acc === '##') pc += 2;
  else if (acc === 'bb') pc -= 2;
  return { pc: ((pc % 12) + 12) % 12, name: m[1] + acc };
}

type QualEntry = [RegExp, number[], Chord['quality']];

// Ordered: longest / most specific first.
const QUALITIES: QualEntry[] = [
  [/^(maj13|M13|Δ13)/, [0, 4, 7, 11, 14, 21], 'maj'],
  [/^(maj9|M9|Δ9)/, [0, 4, 7, 11, 14], 'maj'],
  [/^(maj7|Maj7|M7|Δ7|Δ|△7|△)/, [0, 4, 7, 11], 'maj'],
  [/^(m13|min13|-13)/, [0, 3, 7, 10, 14, 21], 'min'],
  [/^(m11|min11|-11)/, [0, 3, 7, 10, 14, 17], 'min'],
  [/^(m9|min9|-9)/, [0, 3, 7, 10, 14], 'min'],
  [/^(m7b5|m7\(b5\)|m7-5|ø7|ø)/, [0, 3, 6, 10], 'hdim'],
  [/^(mM7|mmaj7|mMaj7|minmaj7|m\(maj7\)|-maj7)/, [0, 3, 7, 11], 'minmaj'],
  [/^(m7|min7|-7)/, [0, 3, 7, 10], 'min'],
  [/^(m6\/9|m69)/, [0, 3, 7, 9, 14], 'min'],
  [/^(m6|min6|-6)/, [0, 3, 7, 9], 'min'],
  [/^(madd9|m\(add9\))/, [0, 3, 7, 14], 'min'],
  [/^(m|min|-)/, [0, 3, 7], 'min'],
  [/^(dim7|o7|°7)/, [0, 3, 6, 9], 'dim'],
  [/^(dim|o|°)/, [0, 3, 6], 'dim'],
  [/^(aug7|7\+5|7#5)/, [0, 4, 8, 10], 'dom'],
  [/^(augM7|maj7#5)/, [0, 4, 8, 11], 'maj'],
  [/^(aug|\+)/, [0, 4, 8], 'aug'],
  [/^(13sus4|13sus)/, [0, 5, 7, 10, 14, 21], 'sus'],
  [/^(9sus4|9sus)/, [0, 5, 7, 10, 14], 'sus'],
  [/^(7sus4|7sus)/, [0, 5, 7, 10], 'sus'],
  [/^(sus2)/, [0, 2, 7], 'sus'],
  [/^(sus4|sus)/, [0, 5, 7], 'sus'],
  [/^(6\/9|69)/, [0, 4, 7, 9, 14], 'maj'],
  [/^(add9|add2|\(add9\))/, [0, 4, 7, 14], 'maj'],
  [/^6/, [0, 4, 7, 9], 'maj'],
  [/^13/, [0, 4, 7, 10, 14, 21], 'dom'],
  [/^11/, [0, 4, 7, 10, 14, 17], 'dom'],
  [/^9/, [0, 4, 7, 10, 14], 'dom'],
  [/^(7alt)/, [0, 4, 8, 10, 13, 15], 'dom'],
  [/^7/, [0, 4, 7, 10], 'dom'],
];

const ALTERATIONS: [RegExp, (t: Set<number>) => void][] = [
  [/^b5|^-5/, t => { t.delete(7); t.add(6); }],
  [/^#5|^\+5/, t => { t.delete(7); t.add(8); }],
  [/^b9|^-9/, t => { t.delete(14); t.add(13); }],
  [/^#9|^\+9/, t => { t.add(15); }],
  [/^#11|^\+11/, t => { t.add(18); }],
  [/^b13|^-13/, t => { t.delete(21); t.add(20); }],
  [/^add9/, t => { t.add(14); }],
  [/^add11/, t => { t.add(17); }],
  [/^add13|^add6/, t => { t.add(21); }],
  [/^13/, t => { t.add(21); }],
  [/^11/, t => { t.add(17); }],
  [/^9/, t => { t.add(14); }],
  [/^sus4/, t => { t.delete(3); t.delete(4); t.add(5); }],
  [/^sus2/, t => { t.delete(3); t.delete(4); t.add(2); }],
];

export function parseChord(input: string): Chord | null {
  let s = input.trim();
  if (!s) return null;

  // slash bass
  let bass: number | null = null;
  let bassName: string | null = null;
  const slash = s.match(/^(.+)\/([A-G](?:#|b)?)$/);
  // Avoid capturing 6/9 as slash chord
  if (slash && !/^(6|m6)$/.test(slash[1].replace(/^[A-G](#|b)?/, ''))) {
    const bn = parseNoteName(slash[2]);
    if (bn) { bass = bn.pc; bassName = bn.name; s = slash[1]; }
  }

  const rm = s.match(/^([A-G](?:##|bb|#|b)?)(.*)$/);
  if (!rm) return null;
  const rootParsed = parseNoteName(rm[1]);
  if (!rootParsed) return null;
  let rest = rm[2];

  let tones: Set<number> | null = null;
  let quality: Chord['quality'] = 'maj';

  if (rest === '') {
    tones = new Set([0, 4, 7]);
  } else {
    for (const [re, base, q] of QUALITIES) {
      const m = rest.match(re);
      if (m) {
        tones = new Set(base);
        quality = q;
        rest = rest.slice(m[0].length);
        break;
      }
    }
  }
  if (!tones) return null;

  // remaining alterations, possibly in parens / comma separated
  rest = rest.replace(/[(),\s]/g, '');
  let guard = 0;
  while (rest.length > 0 && guard++ < 12) {
    let matched = false;
    for (const [re, fn] of ALTERATIONS) {
      const m = rest.match(re);
      if (m) {
        fn(tones);
        rest = rest.slice(m[0].length);
        matched = true;
        break;
      }
    }
    if (!matched) return null; // unknown junk → parse error
  }
  if (rest.length > 0) return null;

  return {
    symbol: input.trim(),
    root: rootParsed.pc,
    rootName: rootParsed.name,
    bass, bassName,
    tones: [...tones].sort((a, b) => a - b),
    quality,
  };
}

// ---- Chord anatomy helpers ----
export interface Anatomy {
  third: number | null;    // 3 or 4 (or 2/5 for sus)
  fifth: number | null;    // 6, 7 or 8
  seventh: number | null;  // 9, 10 or 11
  sixth: number | null;    // 9 when used as 6th chord
  tensions: number[];      // 13,14,15,17,18,20,21
}

export function anatomy(c: Chord): Anatomy {
  const t = new Set(c.tones);
  const third = t.has(4) ? 4 : t.has(3) ? 3 : t.has(5) ? 5 : t.has(2) ? 2 : null;
  const fifth = t.has(7) ? 7 : t.has(6) ? 6 : t.has(8) ? 8 : null;
  let seventh: number | null = t.has(10) ? 10 : t.has(11) ? 11 : null;
  let sixth: number | null = null;
  if (!seventh && t.has(9) && c.quality !== 'dim') sixth = 9;
  if (c.quality === 'dim' && t.has(9)) seventh = 9;
  const tensions = c.tones.filter(x => x >= 13);
  return { third, fifth, seventh, sixth, tensions };
}

// ---- Pitch spelling for notation ----
const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const MIXED_C = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

export const KEYS = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'F', 'Bb', 'Eb', 'Ab', 'Db'] as const;
export type KeyName = typeof KEYS[number];

const SHARP_KEYS = new Set(['G', 'D', 'A', 'E', 'B', 'F#']);
const FLAT_KEYS = new Set(['F', 'Bb', 'Eb', 'Ab', 'Db']);

/** Diatonic spellings for each major key (7 letters). */
function keyScaleNames(key: KeyName): string[] {
  const rootPc = parseNoteName(key)!.pc;
  const steps = [0, 2, 4, 5, 7, 9, 11];
  const letters = 'CDEFGAB';
  const rootLetterIdx = letters.indexOf(key[0]);
  const names: string[] = [];
  for (let i = 0; i < 7; i++) {
    const letter = letters[(rootLetterIdx + i) % 7];
    const targetPc = (rootPc + steps[i]) % 12;
    const naturalPc = LETTER_PC[letter];
    let diff = targetPc - naturalPc;
    if (diff > 6) diff -= 12;
    if (diff < -6) diff += 12;
    const acc = diff === 0 ? '' : diff === 1 ? '#' : diff === -1 ? 'b' : diff === 2 ? '##' : 'bb';
    names.push(letter + acc);
  }
  return names;
}

const spellCache = new Map<string, string[]>();

/** pc (0-11) → preferred note name in this key */
export function spellPc(pc: number, key: KeyName): string {
  let table = spellCache.get(key);
  if (!table) {
    const base = SHARP_KEYS.has(key) ? [...SHARP_NAMES] : FLAT_KEYS.has(key) ? [...FLAT_NAMES] : [...MIXED_C];
    for (const n of keyScaleNames(key)) {
      const p = parseNoteName(n);
      if (p && n.length <= 2) base[p.pc] = n; // avoid double accidentals in table
    }
    table = base;
    spellCache.set(key, table);
  }
  return table[pc];
}

/** midi → VexFlow key string like "c#/4" */
export function midiToVexKey(midi: number, key: KeyName): string {
  const pc = midi % 12;
  const name = spellPc(pc, key);
  let octave = Math.floor(midi / 12) - 1;
  // E#/B# style corrections (E# has same octave; Cb would be octave+1 — not in our key set)
  return `${name.toLowerCase()}/${octave}`;
}

export function pcOfKey(key: KeyName): number {
  return parseNoteName(key)!.pc;
}

export function keyForPc(pc: number): KeyName {
  const p = ((pc % 12) + 12) % 12;
  return KEYS.find(k => parseNoteName(k)!.pc === p) ?? 'C';
}

/** Transpose one chord symbol, spelling roots for the target key. */
export function transposeSymbol(sym: string, semis: number, targetKey: KeyName): string {
  const move = (name: string) => {
    const p = parseNoteName(name);
    if (!p) return name;
    return spellPc(((p.pc + semis) % 12 + 12) % 12, targetKey);
  };
  const withBass = sym.match(/^([A-G](?:##|bb|#|b)?)([^/]*)\/([A-G](?:##|bb|#|b)?)$/);
  if (withBass) return move(withBass[1]) + withBass[2] + '/' + move(withBass[3]);
  const rootOnly = sym.match(/^([A-G](?:##|bb|#|b)?)([\s\S]*)$/);
  if (rootOnly) return move(rootOnly[1]) + rootOnly[2];
  return sym;
}

/** Prettify a chord symbol for display: b→♭, #→♯ (only in note-name / tension positions) */
export function prettySymbol(sym: string): string {
  return sym
    .replace(/([A-G])b/g, '$1♭')
    .replace(/([A-G])#/g, '$1♯')
    .replace(/b(5|9|13)/g, '♭$1')
    .replace(/#(5|9|11)/g, '♯$1')
    .replace(/maj7/g, 'maj7')
    .replace(/m7b5/g, 'm7♭5');
}
