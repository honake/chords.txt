import { useEffect, useMemo, useRef, useState } from 'react';
import { KEYS, pcOfKey, keyForPc, transposeSymbol, type KeyName } from './lib/theory';
import { STYLES, FEELS, getStyle, type StyleId, type GrooveSettings, type Feel } from './lib/styles';
import { parseProgression, generateSong } from './lib/generate';
import { Player, TONES, type ToneId } from './lib/audio';
import { songToMidi, downloadBlob } from './lib/midi';
import { ScoreView } from './components/ScoreView';
import petalumaUrl from './assets/fonts/PetalumaScript.otf';

const DEFAULT_PROGRESSION = `| Gm9 Am7 | Bbmaj9 Am7 | Gm9 Am7 | >Bbmaj9 |
| Gm9 Am7 | Bbmaj9 Am7 | [3-3-2-3-3-2] Gm9 Gm9 Gm9 C13 | >Fmaj9 |`;

interface Preset {
  name: string;
  group: 'POP' | 'JAZZ' | 'SOUL' | 'NEO SOUL';
  text: string;
  key: KeyName;
  style: StyleId;
  tempo: number;
  /** groove overrides on top of the style defaults (feel / fill style coverage) */
  settings?: Partial<GrooveSettings>;
}

const PRESETS: Preset[] = [
  // ---- POP: straight 8ths / 16 beat / ballad ----
  {
    name: 'Axis Pop (C)', group: 'POP', key: 'C', style: 'pop', tempo: 96,
    settings: { feel: 'straight8', fillStyle: 'basic' },
    text: `| C G/B | Am7 F | C G | F Gsus4 |
| C G/B | Am7 F | Dm7 >G | [6-6-4] C |`,
  },
  {
    name: '16-Beat Pop (C)', group: 'POP', key: 'C', style: 'pop', tempo: 104,
    settings: { feel: 'sixteenth', fillStyle: 'mix', density: 0.7 },
    text: `| Fmaj7 G/F | Em7 Am7 | Fmaj7 G | >Cmaj7 |
| Fmaj7 G/F | Em7 Am7 | [3-3-10] Dm7 Dm7 G7 | Cmaj7 |`,
  },
  {
    name: 'Pop Ballad (G)', group: 'POP', key: 'G', style: 'ballad', tempo: 68,
    settings: { feel: 'straight8', fillStyle: 'basic' },
    text: `| G D/F# | Em7 D | Cmaj7 G/B | Am7 D7 |
| G D/F# | Em7 G7 | Cmaj7 Cm6 | G |`,
  },
  // ---- JAZZ: swing 8ths, jazz & blues fills ----
  {
    name: 'I-VI-II-V (C)', group: 'JAZZ', key: 'C', style: 'jazz', tempo: 132,
    settings: { feel: 'swing8', fillStyle: 'jazz' },
    text: `| Cmaj7 A7 | Dm7 G7 | Em7 A7 | Dm7 G7 |
| Cmaj7 C7 | Fmaj7 Fm6 | Em7 A7 | >Dm7 G7! |`,
  },
  {
    name: 'III-VI-II-V (C)', group: 'JAZZ', key: 'C', style: 'jazz', tempo: 126,
    settings: { feel: 'swing8', fillStyle: 'jazz' },
    text: `| Em7 A7 | Dm7 G7 | Em7 A7 | Dm7 G7 |
| [charleston] Em7 A7 | Dm7 G7 | [6-6-4] Cmaj7 | Dm7 >G7! |`,
  },
  {
    name: 'Rhythm Changes A (Bb)', group: 'JAZZ', key: 'Bb', style: 'jazz', tempo: 152,
    settings: { feel: 'swing8', fillStyle: 'jazz' },
    text: `| Bbmaj7 G7 | Cm7 F7 | Dm7 G7 | Cm7 F7 |
| Fm7 Bb7 | Ebmaj7 Ab7 | Dm7 G7 | >Cm7 F7! |`,
  },
  {
    // fast swing flattens out: shallow swing ratio, sparser fills
    name: 'Fast Swing (C)', group: 'JAZZ', key: 'C', style: 'jazz', tempo: 224,
    settings: { feel: 'swing8', swing: 0.58, fillStyle: 'jazz', fills: 0.35, density: 0.55, pushProb: 0.15 },
    text: `| C6 A7 | Dm7 G7 | Em7 A7 | Dm7 G7 |
| C7 | Fmaj7 | Em7 A7 | [charleston] Dm7 G7 |
| C6 A7 | Dm7 G7 | Em7 A7 | Dm7 G7 |
| Fmaj7 Bb7 | Em7 A7 | Dm7 G7 | >C6! |`,
  },
  {
    name: 'Minor Swing (Dm)', group: 'JAZZ', key: 'F', style: 'jazz', tempo: 200,
    settings: { feel: 'swing8', swing: 0.58, fillStyle: 'jazz', fills: 0.4, density: 0.6 },
    text: `| Dm6 | Gm6 | Dm6 | A7 |
| Dm6 | Gm6 | Bb7 A7 | >Dm6 A7! |`,
  },
  {
    name: 'Jazz Blues (F)', group: 'JAZZ', key: 'F', style: 'jazz', tempo: 144,
    settings: { feel: 'swing8', fillStyle: 'blues', fills: 0.5 },
    text: `| F7 | Bb7 | F7 | Cm7 F7 |
| Bb7 | Bdim7 | F7 | Am7b5 D7 |
| Gm7 | C7 | [6-6-4] F7 F7 D7 | Gm7 >C7 |`,
  },
  // ---- SOUL: shuffle 16ths, gospel fills ----
  {
    name: 'Lovely Shuffle (E)', group: 'SOUL', key: 'E', style: 'neosoul', tempo: 116,
    settings: { feel: 'shuffle16', swing: 0.62, fillStyle: 'gospel' },
    text: `| C#m9 | F#13 | B7sus4 B13 | Emaj9 |
| C#m9 | F#13 | [6-6-4] B7sus4 B7sus4 B13 | >Emaj9 |`,
  },
  {
    name: 'Gospel Shout (C)', group: 'SOUL', key: 'C', style: 'neosoul', tempo: 152,
    settings: { feel: 'shuffle16', swing: 0.6, fillStyle: 'gospel', fills: 0.5, density: 0.75, pushProb: 0.2 },
    text: `| C C/E | F Fdim7 | C/G A7 | Dm7 G7 |
| C C/E | F F#dim7 | [6-6-4] C/G A7 | Dm7 >G7 | >>C! |`,
  },
  {
    name: 'Gospel Turnaround (C)', group: 'SOUL', key: 'C', style: 'neosoul', tempo: 100,
    settings: { feel: 'shuffle16', swing: 0.6, fillStyle: 'gospel', fills: 0.75, embellish: 0.6, register: -5 },
    text: `| C E7 | Am7 C7 | F F#dim7 | C/G A7 |
| Dm7 G7 | C E7 | Am7 D7 | >C G7! |`,
  },
  // ---- NEO SOUL: 16 beat, contemporary fills ----
  {
    name: 'St. Denis Vamp (F)', group: 'NEO SOUL', key: 'F', style: 'neosoul', tempo: 94,
    settings: { feel: 'sixteenth', fillStyle: 'contemporary' },
    text: DEFAULT_PROGRESSION,
  },
  {
    name: '16-Beat Hits (A)', group: 'NEO SOUL', key: 'A', style: 'neosoul', tempo: 92,
    settings: { feel: 'sixteenth', fillStyle: 'contemporary' },
    text: `| [3-3-10] Amaj9 | F#m11 | [3-3-10] Dmaj9 Dmaj9 C#m7 | >E7sus4 E7! |
| [3-3-10] Amaj9 | F#m11 | [3-3-2-3-3-2] Dmaj9 Dmaj9 Dmaj9 E7sus4 | A6/9 |`,
  },
];

// what a first-time visitor hears
const DEFAULT_PRESET = PRESETS.find(p => p.name.startsWith('Gospel Turnaround'))!;

const STYLE_TEMPOS: Record<StyleId, number> = { jazz: 132, neosoul: 74, pop: 96, ballad: 68 };
const TENSION_LABELS = ['Basic', '+9th', 'Rich'];
const FILL_STYLES: { id: GrooveSettings['fillStyle']; name: string }[] = [
  { id: 'basic', name: 'Basic' },
  { id: 'blues', name: 'Blues' },
  { id: 'gospel', name: 'Gospel' },
  { id: 'jazz', name: 'Jazz' },
  { id: 'contemporary', name: 'Contemporary' },
  { id: 'mix', name: 'Mix' },
];

// ---- the chords.txt page sprite: a little text file that sings along ----
// D = ink (--text) · W = paper · T = the dog-eared corner & headphones (--accent)
const PAGE_BASE = [
  '..DDDDDD....',
  '..DWWWWDD...',
  '..DWWWWTDD..',
  '..DWWWWTTTD.',
  '..DWWWWWWWD.',
  '..DWDWWWDWD.',
  '..DWWWWWWWD.',
  '..DWWDDWWWD.',
  '..DWWWWWWWD.',
  '..DDDDDDDDD.',
];
const PAGE_HAPPY = PAGE_BASE.map((r, i) => (i === 7 ? '..DWWDDDWWD.' : r));
// headphones on (T pixels) — worn while the band is playing
const PAGE_PHONES = [
  '.TTTTTTTTTTT',
  '.TDWWWWDD..T',
  '.TDWWWWTDD.T',
  '.TDWWWWTTTDT',
  'TTDWWWWWWWTT',
  'TTDWDWWWDWTT',
  'TTDWWWWWWWTT',
  '..DWWDDWWWD.',
  '..DWWWWWWWD.',
  '..DDDDDDDDD.',
];
const PAGE_PHONES_HAPPY = PAGE_PHONES.map((r, i) => (i === 7 ? '..DWWDDDWWD.' : r));

function PageSprite({ rows }: { rows: string[] }) {
  const fill: Record<string, string> = { D: 'var(--text)', W: '#ffffff', T: 'var(--accent)' };
  const px: React.ReactNode[] = [];
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (ch !== '.') px.push(<rect key={`${x}-${y}`} x={x} y={y} width={1.02} height={1.02} fill={fill[ch]} />);
    });
  });
  return <svg viewBox="0 0 12 10" width="26" height="22" shapeRendering="crispEdges">{px}</svg>;
}

function Mascot({ playing, bpm }: { playing: boolean; bpm: number }) {
  return (
    <span
      className={`mascot${playing ? ' dancing' : ''}`}
      style={playing ? { animationDuration: `${60 / Math.max(40, bpm)}s` } : undefined}
      title="hi!"
    >
      <span className="mascot-base"><PageSprite rows={playing ? PAGE_PHONES : PAGE_BASE} /></span>
      <span className="mascot-happy"><PageSprite rows={playing ? PAGE_PHONES_HAPPY : PAGE_HAPPY} /></span>
    </span>
  );
}

// transport & topbar icons — same line style as the section icons
const LoopIcon = () => (
  <svg className="tg-ic" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2.6 6v-0.6a2.9 2.9 0 0 1 2.9-2.9h6" />
    <path d="M9.7 0.8 11.5 2.5 9.7 4.2" />
    <path d="M11.4 8v0.6a2.9 2.9 0 0 1-2.9 2.9h-6" />
    <path d="M4.3 9.8 2.5 11.5 4.3 13.2" />
  </svg>
);
const ClickIcon = () => (
  <svg className="tg-ic" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5.4 1.6h3.2l2.2 10.8H3.2z" />
    <path d="M6.8 9.2 10.4 3.4" />
    <circle cx="10.5" cy="3.2" r="1" fill="currentColor" stroke="none" />
  </svg>
);
const FillsIcon = () => (
  <svg className="tg-ic" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
    <ellipse cx="2.7" cy="11.6" rx="1.6" ry="1.25" fill="currentColor" stroke="none" />
    <ellipse cx="6.9" cy="10" rx="1.6" ry="1.25" fill="currentColor" stroke="none" />
    <ellipse cx="11.1" cy="8.4" rx="1.6" ry="1.25" fill="currentColor" stroke="none" />
    <path d="M4.2 11.3V4.9M8.4 9.7V3.3M12.6 8.1V1.7" />
    <path d="M4.2 4.9 12.6 1.7" strokeWidth="2.1" />
  </svg>
);
const ShareIcon = () => (
  <svg className="bar-ic" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5.9 8.1 8.1 5.9" />
    <path d="M6.6 3.9 8.1 2.4a2.55 2.55 0 0 1 3.6 3.6L10.2 7.5" />
    <path d="M7.4 10.1 5.9 11.6a2.55 2.55 0 0 1-3.6-3.6L3.8 6.5" />
  </svg>
);
const CheckIcon = () => (
  <svg className="bar-ic" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2.5 7.5 5.5 10.5 11.5 3.5" />
  </svg>
);
const ExportIcon = () => (
  <svg className="bar-ic" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
    <path d="M7 1.6v7.6" />
    <path d="M4.2 6.6 7 9.4 9.8 6.6" />
    <path d="M2.2 11.8h9.6" />
  </svg>
);
const NoteIcon = () => (
  <svg className="sec-ic" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
    <ellipse cx="4.4" cy="10.6" rx="2.3" ry="1.8" fill="currentColor" stroke="none" />
    <path d="M6.6 10.4V2.6l4.6 1.4v2.4" strokeLinecap="round" />
  </svg>
);
const GrooveIcon = () => (
  <svg className="sec-ic" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
    <path d="M1.5 3.5h11M1.5 7h11M1.5 10.5h11" />
    <circle cx="5" cy="3.5" r="1.6" fill="var(--paper)" />
    <circle cx="9.5" cy="7" r="1.6" fill="var(--paper)" />
    <circle cx="4" cy="10.5" r="1.6" fill="var(--paper)" />
  </svg>
);

interface DdOption { value: string; label: string; group?: string }

/** Styled dropdown (native selects can't be themed). */
function Dropdown({ value, options, onChange, placeholder, menuAlign = 'right' }: {
  value: string | null;
  options: DdOption[];
  onChange: (v: string) => void;
  placeholder?: React.ReactNode;
  menuAlign?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  const current = options.find(o => o.value === value);
  return (
    <div className="dd" ref={ref}>
      <button type="button" className={`dd-trigger${open ? ' open' : ''}`} onClick={() => setOpen(v => !v)}>
        <span>{current?.label ?? placeholder ?? '—'}</span>
        <span className="dd-chev" />
      </button>
      {open && (
        <div className={`dd-menu ${menuAlign}`}>
          {options.map((o, i) => (
            <span key={o.value}>
              {o.group != null && (i === 0 || options[i - 1].group !== o.group) && (
                <div className="dd-group">{o.group}</div>
              )}
              <button
                type="button"
                className={`dd-item${o.value === value ? ' active' : ''}`}
                onClick={() => { onChange(o.value); setOpen(false); }}
              >{o.label}</button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

let fontCssCache: string | null = null;
async function petalumaFontCss(): Promise<string> {
  if (fontCssCache) return fontCssCache;
  const buf = await (await fetch(petalumaUrl)).arrayBuffer();
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  fontCssCache = `@font-face{font-family:'PetalumaScript';src:url(data:font/otf;base64,${btoa(bin)}) format('opentype');}`;
  return fontCssCache;
}

// ---------- persistence & share links ----------

interface SavedState {
  t: string; c: string; k: KeyName; s: StyleId;
  g: Partial<GrooveSettings>; b: number; o: ToneId; d: number;
}

const STORAGE_KEY = 'qls:song';

function encodeShare(st: SavedState): string {
  const json = JSON.stringify(st);
  return btoa(unescape(encodeURIComponent(json)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeShare(s: string): SavedState | null {
  try {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(decodeURIComponent(escape(atob(b64))));
  } catch { return null; }
}

function loadInitial(): SavedState | null {
  const m = window.location.hash.match(/^#s=(.+)$/);
  if (m) {
    const st = decodeShare(m[1]);
    if (st) return st;
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* start fresh */ }
  return null;
}

const initial = loadInitial();

export default function App() {
  const [title, setTitle] = useState(initial?.t ?? DEFAULT_PRESET.name);
  const [chordText, setChordText] = useState(initial?.c ?? DEFAULT_PRESET.text);
  const [keyName, setKeyName] = useState<KeyName>(initial?.k ?? DEFAULT_PRESET.key);
  const [styleId, setStyleId] = useState<StyleId>(initial?.s ?? DEFAULT_PRESET.style);
  const [settingsRaw, setSettings] = useState<GrooveSettings>(
    { ...getStyle(initial?.s ?? DEFAULT_PRESET.style).defaults,
      ...(initial ? {} : DEFAULT_PRESET.settings),
      ...(initial?.g ?? {}) });
  // merge over style defaults so newly added fields always have a value
  const settings = useMemo<GrooveSettings>(
    () => ({ ...getStyle(styleId).defaults, ...settingsRaw }),
    [styleId, settingsRaw],
  );
  const [tempo, setTempo] = useState(initial?.b ?? DEFAULT_PRESET.tempo);
  const [seed, setSeed] = useState(initial?.d ?? 1);
  const [tab, setTab] = useState<'lead' | 'piano'>('piano');
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(true);
  const [click, setClick] = useState(false);
  const [showFills, setShowFills] = useState(true);
  const [tone, setTone] = useState<ToneId>(initial?.o ?? 'suitcase');
  const [copied, setCopied] = useState(false);
  const [currentBar, setCurrentBar] = useState<number | null>(null);
  const [helpTopic, setHelpTopic] = useState<'notation' | 'groove' | 'about' | null>(null);

  // splash: the app's core loop in miniature — text gets typed, then becomes the thing
  const SPLASH_NAME = 'chords.txt';
  const reducedMotion = typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const [splashPhase, setSplashPhase] = useState<'type' | 'pop' | 'out' | 'done'>(reducedMotion ? 'out' : 'type');
  const [typedN, setTypedN] = useState(reducedMotion ? SPLASH_NAME.length : 0);
  useEffect(() => {
    if (splashPhase === 'type') {
      if (typedN < SPLASH_NAME.length) {
        const t = setTimeout(() => setTypedN(n => n + 1), typedN === 0 ? 380 : 72);
        return () => clearTimeout(t);
      }
      const t = setTimeout(() => setSplashPhase('pop'), 320);
      return () => clearTimeout(t);
    }
    if (splashPhase === 'pop') {
      const t = setTimeout(() => setSplashPhase('out'), 620);
      return () => clearTimeout(t);
    }
    if (splashPhase === 'out') {
      const t = setTimeout(() => setSplashPhase('done'), 380);
      return () => clearTimeout(t);
    }
  }, [splashPhase, typedN]);

  const playerRef = useRef<Player | null>(null);
  const scoreRef = useRef<HTMLDivElement | null>(null);

  if (!playerRef.current) playerRef.current = new Player();
  const player = playerRef.current;

  // autosave (debounced)
  useEffect(() => {
    const id = window.setTimeout(() => {
      const st: SavedState = {
        t: title, c: chordText, k: keyName, s: styleId,
        g: settingsRaw, b: tempo, o: tone, d: seed,
      };
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(st)); } catch { /* full */ }
    }, 400);
    return () => window.clearTimeout(id);
  }, [title, chordText, keyName, styleId, settingsRaw, tempo, tone, seed]);

  const share = async () => {
    const st: SavedState = {
      t: title, c: chordText, k: keyName, s: styleId,
      g: settingsRaw, b: tempo, o: tone, d: seed,
    };
    const url = `${location.origin}${location.pathname}#s=${encodeShare(st)}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      window.prompt('Copy this link:', url);
    }
  };

  // transpose every chord token (and the key) by ±1 semitone
  const transpose = (semis: number) => {
    const newKey = keyForPc(pcOfKey(keyName) + semis);
    const newText = chordText.split(/\r?\n/).map(line => {
      if (line.trim().startsWith('#')) return line;
      return line.split(/(\s+|\|)/).map(tok => {
        if (!tok || /^[|\s%]+$/.test(tok) || tok.startsWith('[')) return tok;
        const m = tok.match(/^(\^|>>|>)?(.+?)(!?)$/);
        if (!m) return tok;
        if (!/^[A-G]/.test(m[2])) return tok;
        return (m[1] ?? '') + transposeSymbol(m[2], semis, newKey) + m[3];
      }).join('');
    }).join('\n');
    setKeyName(newKey);
    setChordText(newText);
  };

  const parsed = useMemo(() => parseProgression(chordText), [chordText]);
  const song = useMemo(
    () => (parsed.bars.length > 0 ? generateSong(parsed.bars, styleId, seed, settings, parsed.sections) : null),
    [parsed, styleId, seed, settings],
  );
  const style = getStyle(styleId);
  const feel = FEELS.find(f => f.id === settings.feel)!;

  useEffect(() => {
    player.stop();
  }, [song, tempo, player]);

  // keep the player's tone in sync (incl. the restored one on first load)
  useEffect(() => {
    player.setTone(tone);
  }, [player, tone]);

  useEffect(() => {
    player.onPosition = bar => setCurrentBar(bar);
    player.onStop = () => {
      setPlaying(false);
      setCurrentBar(null);
    };
  }, [player]);

  const set = <K extends keyof GrooveSettings>(k: K, v: GrooveSettings[K]) =>
    setSettings(s => ({ ...s, [k]: v }));

  const selectStyle = (id: StyleId) => {
    setStyleId(id);
    setSettings(getStyle(id).defaults);
    setTempo(STYLE_TEMPOS[id]);
  };

  const togglePlay = () => {
    if (player.playing) {
      player.stop();
    } else if (song) {
      player.start(song, tempo, loop);
      setPlaying(true);
    }
  };

  const playFromBar = (bar: number) => {
    if (!song) return;
    if (player.playing) {
      player.seek(bar);
    } else {
      player.start(song, tempo, loop, bar);
      setPlaying(true);
    }
  };

  const toggleLoop = () => {
    setLoop(v => {
      player.setLooping(!v);
      return !v;
    });
  };

  const toggleClick = () => {
    setClick(v => {
      player.setClick(!v);
      return !v;
    });
  };

  const selectTone = (id: ToneId) => {
    setTone(id);
    player.setTone(id);
  };

  const safeName = (s: string) => (s.trim() || 'untitled').replace(/[\\/:*?"<>|]/g, '_');

  const exportMidi = () => {
    if (!song) return;
    downloadBlob(songToMidi(song, tempo, title), `${safeName(title)}.mid`, 'audio/midi');
  };

  const exportPng = async () => {
    const svgs = [...(scoreRef.current?.querySelectorAll('svg') ?? [])];
    const svg = svgs[0];
    if (!svg) return;
    const fontCss = await petalumaFontCss().catch(() => '');
    const renderOne = (source: SVGElement) => new Promise<HTMLImageElement>((resolve, reject) => {
      const vb2 = source.getAttribute('viewBox')!.split(' ').map(Number);
      const clone2 = source.cloneNode(true) as SVGElement;
      clone2.setAttribute('width', String(vb2[2]));
      clone2.setAttribute('height', String(vb2[3]));
      if (fontCss) {
        const st = document.createElementNS('http://www.w3.org/2000/svg', 'style');
        st.textContent = fontCss;
        clone2.insertBefore(st, clone2.firstChild);
      }
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = reject;
      im.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(clone2))}`;
    });
    const vb0 = svg.getAttribute('viewBox')!.split(' ').map(Number);
    const [, , w0, h0] = vb0;
    const GAP = 24;
    const scale = 2;
    const imgs = await Promise.all(svgs.map(s => renderOne(s as SVGElement)));
    const canvas = document.createElement('canvas');
    canvas.width = w0 * scale;
    canvas.height = (h0 * imgs.length + GAP * (imgs.length - 1)) * scale;
    const cx2 = canvas.getContext('2d')!;
    cx2.fillStyle = '#ffffff';
    cx2.fillRect(0, 0, canvas.width, canvas.height);
    cx2.scale(scale, scale);
    imgs.forEach((im, i) => cx2.drawImage(im, 0, i * (h0 + GAP), w0, h0));
    canvas.toBlob(blob => {
      if (blob) downloadBlob(blob, `${safeName(title)}-${tab === 'lead' ? 'leadsheet' : 'piano'}.png`, 'image/png');
    });
    return;
    // (legacy single-page path below is unreachable)
    const vb = svg.getAttribute('viewBox')!.split(' ').map(Number);
    const [, , w, h] = vb;
    const clone = svg.cloneNode(true) as SVGElement;
    clone.setAttribute('width', String(w));
    clone.setAttribute('height', String(h));
    try {
      const styleEl = document.createElementNS('http://www.w3.org/2000/svg', 'style');
      styleEl.textContent = await petalumaFontCss();
      clone.insertBefore(styleEl, clone.firstChild);
    } catch { /* export without embedded font */ }
    const data = new XMLSerializer().serializeToString(clone);
    const img = new Image();
    img.onload = () => {
      const scale = 2;
      const canvas = document.createElement('canvas');
      canvas.width = w * scale;
      canvas.height = h * scale;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      canvas.toBlob(blob => {
        if (blob) downloadBlob(blob, `${safeName(title)}-${tab === 'lead' ? 'leadsheet' : 'piano'}.png`, 'image/png');
      });
    };
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(data)}`;
  };

  const applyPreset = (p: Preset) => {
    setTitle(p.name);
    setChordText(p.text);
    setKeyName(p.key);
    setStyleId(p.style);
    setSettings({ ...getStyle(p.style).defaults, ...(p.settings ?? {}) });
    setTempo(p.tempo);
    setSeed(s => s + 1);
  };

  const barCount = song?.bars.length ?? 0;

  return (
    <div className="app">
      <header className="topbar">
        <div className="wordmark"><Mascot playing={playing} bpm={tempo} /><span className="wm-text">chords<span className="ext">.txt</span></span></div>
        <div className="title-wrap">
          <input
            className="song-title"
            type="text"
            value={title}
            onChange={e => setTitle(e.target.value)}
            spellCheck={false}
          />
        </div>
        <button className="btn sm icon-btn" onClick={share}
          title={copied ? 'Link copied!' : 'Share — copy a link that opens this exact song & settings'}>
          {copied ? <CheckIcon /> : <ShareIcon />}
        </button>
        <Dropdown
          value={null}
          placeholder={<ExportIcon />}
          options={[
            { value: 'midi', label: 'MIDI (RH / LH tracks)' },
            { value: 'png', label: 'PNG image' },
            { value: 'pdf', label: 'PDF (print dialog)' },
          ]}
          onChange={v => {
            if (v === 'midi') exportMidi();
            else if (v === 'png') exportPng();
            else window.print();
          }}
        />
      </header>

      <div className="body">
        <aside className="controls">
          <div className="section">
            <div className="section-label">
              <span className="with-ic"><NoteIcon /> Chords</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <span className="aside">{barCount > 0 ? `${barCount} bars` : ''}</span>
                <button
                  className={`help-btn${helpTopic === 'notation' ? ' on' : ''}`}
                  onClick={() => setHelpTopic('notation')}
                  title="Notation guide"
                >?</button>
              </span>
            </div>
            <textarea
              className="chords"
              spellCheck={false}
              value={chordText}
              onChange={e => setChordText(e.target.value)}
            />
            {parsed.errors.length > 0 && (
              <div className="errors">
                {parsed.errors.slice(0, 4).map((e, i) => <div key={i}>⚠ {e}</div>)}
              </div>
            )}
            <div className="row" style={{ marginTop: 8 }}>
              <span className="row-label" title="Load an example progression (sets chords, key, groove & tempo)">Example</span>
              <Dropdown
                value={null}
                placeholder="Load…"
                options={PRESETS.map(p => ({ value: p.name, label: p.name, group: p.group }))}
                onChange={name => {
                  const p = PRESETS.find(x => x.name === name);
                  if (p) applyPreset(p);
                }}
              />
            </div>
            <div className="row">
              <span className="row-label">Key</span>
              <Dropdown
                value={keyName}
                options={KEYS.map(k => ({ value: k, label: k }))}
                onChange={v => setKeyName(v as KeyName)}
              />
            </div>
          </div>

          <div className="section">
            <div className="section-label">
              <span className="with-ic"><GrooveIcon /> Groove</span>
              <button
                className={`help-btn${helpTopic === 'groove' ? ' on' : ''}`}
                onClick={() => setHelpTopic('groove')}
                title="What do these knobs do?"
              >?</button>
            </div>
            <div className="row">
              <span className="row-label">Preset</span>
              <Dropdown
                value={styleId}
                options={STYLES.map(s => ({ value: s.id, label: s.name }))}
                onChange={v => selectStyle(v as StyleId)}
              />
            </div>
            <div className="row">
              <span className="row-label">Feel</span>
              <Dropdown
                value={settings.feel}
                options={FEELS.map(f => ({ value: f.id, label: f.name }))}
                onChange={v => set('feel', v as Feel)}
              />
            </div>
            <div className={`slider-row${feel.swingable ? '' : ' off'}`}>
              <span className="row-label" title="Offbeat delay — 50% straight, 66% triplet swing">Swing</span>
              <input
                type="range" min={50} max={75} step={1}
                value={Math.round(settings.swing * 100)}
                onChange={e => set('swing', Number(e.target.value) / 100)}
              />
              <span className="row-num">{Math.round(settings.swing * 100)}%</span>
            </div>
            <div className="slider-row">
              <span className="row-label" title="How busy the comping rhythm is">Density</span>
              <input
                type="range" min={0} max={100} step={5}
                value={Math.round(settings.density * 100)}
                onChange={e => set('density', Number(e.target.value) / 100)}
              />
              <span className="row-num">{Math.round(settings.density * 100)}</span>
            </div>
            <div className="slider-row">
              <span className="row-label" title="Voicing richness — plain chords to 9/11/13 colors">Tension</span>
              <input
                type="range" min={0} max={2} step={1}
                value={settings.tension}
                onChange={e => set('tension', Number(e.target.value) as 0 | 1 | 2)}
              />
              <span className="row-num">{TENSION_LABELS[settings.tension]}</span>
            </div>
            <div className="slider-row">
              <span className="row-label" title="Right-hand register shift in semitones">Register</span>
              <input
                type="range" min={-12} max={12} step={1}
                value={settings.register}
                onChange={e => set('register', Number(e.target.value))}
              />
              <span className="row-num">{settings.register > 0 ? `+${settings.register}` : settings.register}</span>
            </div>
            <div className="slider-row">
              <span className="row-label" title="Chance of anticipating a chord change by an 8th (pushed attack, tied over the barline)">Push</span>
              <input
                type="range" min={0} max={100} step={5}
                value={Math.round(settings.pushProb * 100)}
                onChange={e => set('pushProb', Number(e.target.value) / 100)}
              />
              <span className="row-num">{Math.round(settings.pushProb * 100)}%</span>
            </div>
            <div className="slider-row">
              <span className="row-label" title="Random velocity & micro-timing variation — 0 is mechanical, 100 is loose">Humanize</span>
              <input
                type="range" min={0} max={100} step={5}
                value={Math.round(settings.humanize * 100)}
                onChange={e => set('humanize', Number(e.target.value) / 100)}
              />
              <span className="row-num">{Math.round(settings.humanize * 100)}</span>
            </div>
            <div className="slider-row">
              <span className="row-label" title="Chance of inner-voice moves while a chord rings: 9→3, sus4→3, maj7→6">Embellish</span>
              <input
                type="range" min={0} max={100} step={5}
                value={Math.round(settings.embellish * 100)}
                onChange={e => set('embellish', Number(e.target.value) / 100)}
              />
              <span className="row-num">{Math.round(settings.embellish * 100)}%</span>
            </div>
            <div className="slider-row">
              <span className="row-label" title="Chance of pickup runs (obbligato) into chord changes">Fills</span>
              <input
                type="range" min={0} max={100} step={5}
                value={Math.round(settings.fills * 100)}
                onChange={e => set('fills', Number(e.target.value) / 100)}
              />
              <span className="row-num">{Math.round(settings.fills * 100)}%</span>
            </div>
            <div className="row">
              <span className="row-label">Fill Style</span>
              <Dropdown
                value={settings.fillStyle}
                options={FILL_STYLES.map(f => ({ value: f.id, label: f.name }))}
                onChange={v => set('fillStyle', v as GrooveSettings['fillStyle'])}
              />
            </div>
            <div style={{ marginTop: 12 }}>
              <button className="btn block" onClick={() => setSeed(s => s + 1)} disabled={!song}
                title="Re-roll the comping patterns & fills">
                ↻ Regenerate
              </button>
            </div>
          </div>
        </aside>

        <main className="main">
          <div className="transport">
            <button
              className={`play-btn${playing ? ' playing' : ''}`}
              onClick={togglePlay}
              disabled={!song}
              title={playing ? 'Stop' : 'Play'}
            >
              {playing ? (
                <svg width="12" height="12" viewBox="0 0 12 12"><rect width="12" height="12" rx="1" fill="currentColor" /></svg>
              ) : (
                <svg width="13" height="14" viewBox="0 0 13 14"><path d="M1 1.2v11.6l11-5.8z" fill="currentColor" /></svg>
              )}
            </button>

            <button className={`icon-toggle${loop ? ' on' : ''}`} onClick={toggleLoop}
              title="Loop playback">
              <LoopIcon />
            </button>

            <button className={`icon-toggle${click ? ' on' : ''}`} onClick={toggleClick}
              title="Metronome click">
              <ClickIcon />
            </button>

            <button
              className={`icon-toggle${showFills ? ' on' : ''}`}
              onClick={() => setShowFills(v => !v)}
              title="Notate fills on the score (playback & MIDI always include them)"
            >
              <FillsIcon />
            </button>

            <div className="divider" />

            <div className="readout">
              <span className="label">Tempo</span>
              <span className="value tempo-value">♩=<input
                className="tempo-input"
                type="number"
                min={40}
                max={240}
                value={tempo}
                onChange={e => setTempo(Math.max(30, Math.min(300, Number(e.target.value) || 120)))}
              /></span>
            </div>

            <div className="readout">
              <span className="label">Sound</span>
              <Dropdown
                value={tone}
                menuAlign="left"
                options={TONES.map(t => ({ value: t.id, label: t.name }))}
                onChange={v => selectTone(v as ToneId)}
              />
            </div>

            <div className="readout">
              <span className="label" title="Transpose every chord (and the key) by a semitone">Transpose</span>
              <span className="transpose-btns">
                <button className="btn sm" onClick={() => transpose(-1)} title="Down a semitone">♭</button>
                <button className="btn sm" onClick={() => transpose(1)} title="Up a semitone">♯</button>
              </span>
            </div>

            <div className="spacer" />
          </div>

          <div className="score-scroll">
            <div className="sheet-tabs">
              <button className={`sheet-tab${tab === 'lead' ? ' active' : ''}`} onClick={() => setTab('lead')}>Lead Sheet</button>
              <button className={`sheet-tab${tab === 'piano' ? ' active' : ''}`} onClick={() => setTab('piano')}>Piano</button>
            </div>
            <ScoreView
              mode={tab}
              song={song}
              keyName={keyName}
              title={title}
              tempo={tempo}
              styleName={style.name}
              feelName={feel.name}
              showFills={showFills}
              currentBar={currentBar}
              onBarClick={playFromBar}
              containerRef={scoreRef}
            />
          </div>
        </main>
      </div>

      <footer className="footer">
        <button className="footer-link" onClick={() => setHelpTopic('about')}>about</button>
        <a className="footer-link" href="https://honake.github.io" target="_blank" rel="noopener noreferrer">
          developer @honake
        </a>
      </footer>

      {splashPhase !== 'done' && (
        <div
          className={`splash${splashPhase !== 'type' ? ' ' + splashPhase : ''}`}
          onClick={() => setSplashPhase('done')}
        >
          <div className="splash-logo">
            <span className="splash-slime"><Mascot playing={false} bpm={104} /></span>
            <span className="splash-text">
              {SPLASH_NAME.slice(0, Math.min(typedN, 6))}
              <span className="ext">{typedN > 6 ? SPLASH_NAME.slice(6, typedN) : ''}</span>
              {splashPhase === 'type' && <span className="caret" />}
            </span>
          </div>
        </div>
      )}

      {helpTopic && (
        <div className="modal-overlay" onClick={() => setHelpTopic(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <span>{helpTopic === 'notation' ? 'Notation Guide' : helpTopic === 'groove' ? 'Groove Guide' : 'About'}</span>
              <button className="modal-close" onClick={() => setHelpTopic(null)} title="Close">×</button>
            </div>
            {helpTopic === 'about' && (
              <div className="modal-body">
                <p>
                  <b>chords.txt</b> is a tiny web tool that turns a plain-text chord
                  progression into a lead sheet and a fully-notated piano backing —
                  instantly, as you type.
                </p>
                <h4>What it does</h4>
                <table>
                  <tbody>
                    <tr><td><b>Write</b></td><td>Type chords like <code>| Gm9 C13 | Fmaj9 |</code> and get an engraved lead sheet plus a two-hand piano score.</td></tr>
                    <tr><td><b>Groove</b></td><td>Styled comping (Jazz / Neo-Soul / Pop / Ballad) with voice leading, tensions, feels from swing to shuffled 16ths, and musical fills.</td></tr>
                    <tr><td><b>Kime</b></td><td>Anticipations (<code>&gt;C7</code>), stabs (<code>C7!</code>) and rhythm figures (<code>[3-3-10]</code>) for band-style hits.</td></tr>
                    <tr><td><b>Play</b></td><td>In-browser playback with several keyboard tones, metronome, looping, and click-to-seek on the score.</td></tr>
                    <tr><td><b>Share</b></td><td>Export MIDI, PNG or print-ready PDF; share any song as a URL.</td></tr>
                  </tbody>
                </table>
                <p>Free, no sign-up — everything runs in your browser.</p>
                <h4>Credits</h4>
                <p>
                  Notation engraved with VexFlow (Bravura &amp; Petaluma fonts).
                  Grand piano samples from the Salamander Grand Piano by Alexander
                  Holm (CC-BY 3.0). Built by{' '}
                  <a href="https://honake.github.io" target="_blank" rel="noopener noreferrer">honake</a>.
                </p>
              </div>
            )}
            {helpTopic === 'groove' && (
              <div className="modal-body">
                <h4>What each control does</h4>
                <table>
                  <tbody>
                    <tr><td><b>Preset</b></td><td>Voicing style &amp; pattern pool (Jazz / Neo-Soul / Pop / Ballad). Picking one resets the knobs below to its defaults.</td></tr>
                    <tr><td><b>Feel</b></td><td>The subdivision the comping lives on: Swing 8ths, Straight 8ths, 16 Beat, or Shuffle 16ths (swung 16ths).</td></tr>
                    <tr><td><b>Swing</b></td><td>Where offbeats land. 50% = perfectly straight, 66% = triplet swing, higher = harder shuffle.</td></tr>
                    <tr><td><b>Density</b></td><td>How busy the comping is — sparse pads at 0, lots of hits at 100.</td></tr>
                    <tr><td><b>Tension</b></td><td>Voicing thickness: Basic (plain chords) → +9th → Rich (9th / 11th / 13th colors).</td></tr>
                    <tr><td><b>Register</b></td><td>Shifts the right-hand voicings up or down, in semitones.</td></tr>
                    <tr><td><b>Push</b></td><td>Chance that a chord change gets <b>anticipated an 8th early</b> — the chord lands on the “and” of beat 4 and ties over the barline. (You can also write it per chord: <code>&gt;C7</code>.)</td></tr>
                    <tr><td><b>Humanize</b></td><td>Random velocity and micro-timing. 0 sounds mechanical, 100 sounds loose and played.</td></tr>
                    <tr><td><b>Embellish</b></td><td>Chance of <b>inner-voice moves</b> while a chord rings — the classic EP tricks: 9th melting into the 3rd, sus4 resolving to 3, maj7 drifting down to 6.</td></tr>
                    <tr><td><b>Fills</b></td><td>Chance of a <b>pickup run (obbligato)</b> leading into the next chord. Notated on the score too — the Fills toggle in the transport shows/hides them.</td></tr>
                    <tr><td><b>Fill Style</b></td><td>The fill vocabulary — see below.</td></tr>
                  </tbody>
                </table>
                <h4>Fill styles</h4>
                <table>
                  <tbody>
                    <tr><td><b>Basic</b></td><td>Chord-tone walk with a chromatic approach note. Neutral, always safe.</td></tr>
                    <tr><td><b>Blues</b></td><td>Blues-scale runs — b3 / b5 blue notes sliding into the target.</td></tr>
                    <tr><td><b>Gospel</b></td><td>Pentatonic runs with double-stops in 3rds underneath.</td></tr>
                    <tr><td><b>Jazz</b></td><td>Bebop enclosures — the target gets surrounded from above and below.</td></tr>
                    <tr><td><b>Contemporary</b></td><td>Neo-soul lines: pentatonic with 4th-interval skips and 4th double-stops.</td></tr>
                    <tr><td><b>Mix</b></td><td>Picks a different vocabulary for every fill.</td></tr>
                  </tbody>
                </table>
              </div>
            )}
            {helpTopic === 'notation' && (
            <div className="modal-body">
              <h4>Bars &amp; chords</h4>
              <table>
                <tbody>
                  <tr><td><code>| Cmaj7 |</code></td><td>one chord — whole bar</td></tr>
                  <tr><td><code>| Dm7 G7 |</code></td><td>two chords — half bar each (up to 4 per bar)</td></tr>
                  <tr><td><code>%</code></td><td>repeat the previous bar</td></tr>
                  <tr><td><code># Verse</code></td><td>lines starting with # are ignored (section labels)</td></tr>
                </tbody>
              </table>

              <h4>Anticipation (push) &amp; stabs</h4>
              <table>
                <tbody>
                  <tr><td><code>^C7</code></td><td>push by a <b>16th</b> — the chord lands slightly early</td></tr>
                  <tr><td><code>&gt;C7</code></td><td>push by an <b>8th</b> — lands on the “and” of beat 4, tied over the barline</td></tr>
                  <tr><td><code>&gt;&gt;C7</code></td><td>push by a <b>quarter</b></td></tr>
                  <tr><td><code>C7!</code></td><td>stab — one short ensemble hit, then silence</td></tr>
                </tbody>
              </table>

              <h4>Rhythm figures</h4>
              <p>
                <code>[3-3-10] C7</code> makes the whole band play a figure: the numbers are
                <b> note lengths in 16ths</b> (sum ≤ 16, the remainder becomes a rest).
                Each ● below is an attack, ─ is how long it rings:
              </p>
              <pre className="grid-demo">
{`beat            1···2···3···4···
[3-3-10]        ●──●──●─────────   "ta··ta··taaa"
[3-3-2-3-3-2]   ●──●──●─●──●──●─   double tresillo
[charleston]    ●─────●─────────
[clave]         ●──●──●───●─●───   son clave 3-2
[6-6-4]         ●─────●─────●───   1 · 2& · 4
[2-2]           ●─●─                two hits, then rest`}
              </pre>
              <p>
                Chords map to hits in order — <code>[3-3-10] C C Bm7</code> plays the last
                “taaa” on Bm7. With fewer chords than hits, the last chord repeats.
                Old names <code>335</code> / <code>3322</code> still work.
              </p>

              <h4>Supported chord symbols</h4>
              <p className="chord-list">
                Cmaj7 · Dm9 · F#m7b5 · Bb7#9 · E7b13 · C/E · G7sus4 · C6/9 · A7alt ·
                Bdim7 · Caug · Am11 · Fmaj9 · G13 · Dsus2 · CmMaj7
              </p>
            </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
