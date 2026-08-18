import { useEffect, useMemo, useRef, useState } from 'react';
import { KEYS, pcOfKey, keyForPc, transposeSymbol, type KeyName } from './lib/theory';
import { STYLES, FEELS, getStyle, type StyleId, type GrooveSettings, type Feel } from './lib/styles';
import { parseProgression, generateSong } from './lib/generate';
import { Player, TONES, type ToneId } from './lib/audio';
import { songToMidi, downloadBlob } from './lib/midi';
import { ScoreView } from './components/ScoreView';
import petalumaUrl from './assets/fonts/PetalumaScript.otf';

const DEFAULT_PROGRESSION = `| Cmaj7 A7 | Dm7 G7 | Em7 A7 | Dm7 G7 |
| Cmaj7 C7 | Fmaj7 Fm6 | Em7 A7 | >Dm7 G7! |`;

const PRESETS: { name: string; text: string; key: KeyName; style: StyleId; tempo: number }[] = [
  {
    name: 'Junkan · I-VI-II-V (C)', key: 'C', style: 'jazz', tempo: 132,
    text: DEFAULT_PROGRESSION,
  },
  {
    name: 'Gyaku-Junkan (C)', key: 'C', style: 'jazz', tempo: 126,
    text: `| Em7 A7 | Dm7 G7 | Em7 A7 | Dm7 G7 |
| [charleston] Em7 A7 | Dm7 G7 | [3-3-10] Cmaj7 | Dm7 >G7! |`,
  },
  {
    name: 'Rhythm Changes A (Bb)', key: 'Bb', style: 'jazz', tempo: 152,
    text: `| Bbmaj7 G7 | Cm7 F7 | Dm7 G7 | Cm7 F7 |
| Fm7 Bb7 | Ebmaj7 Ab7 | Dm7 G7 | >Cm7 F7! |`,
  },
  {
    name: 'Jazz Blues (F)', key: 'F', style: 'jazz', tempo: 144,
    text: `| F7 | Bb7 | F7 | Cm7 F7 |
| Bb7 | Bdim7 | F7 | Am7b5 D7 |
| Gm7 | C7 | [3-3-10] F7 F7 D7 | Gm7 >C7 |`,
  },
  {
    name: 'St. Denis Vamp (F)', key: 'F', style: 'neosoul', tempo: 94,
    text: `| Gm9 Am7 | Bbmaj9 Am7 | Gm9 Am7 | >Bbmaj9 |
| Gm9 Am7 | Bbmaj9 Am7 | [3-3-2-3-3-2] Gm9 Gm9 Gm9 C13 | >Fmaj9 |`,
  },
  {
    name: 'Lovely Shuffle (E)', key: 'E', style: 'neosoul', tempo: 116,
    text: `| C#m9 | F#13 | B7sus4 B13 | Emaj9 |
| C#m9 | F#13 | [6-6-4] B7sus4 B7sus4 B13 | >Emaj9 |`,
  },
  {
    name: '16-Beat Hits (A)', key: 'A', style: 'neosoul', tempo: 92,
    text: `| [3-3-10] Amaj9 | F#m11 | [3-3-10] Dmaj9 Dmaj9 C#m7 | >E7sus4 E7! |
| [3-3-10] Amaj9 | F#m11 | [3-3-2-3-3-2] Dmaj9 Dmaj9 Dmaj9 E7sus4 | A6/9 |`,
  },
  {
    name: 'Pop (C)', key: 'C', style: 'pop', tempo: 96,
    text: `| C G/B | Am7 F | C G | F Gsus4 |
| C G/B | Am7 F | Dm7 >G | [6-6-4] C |`,
  },
  {
    name: 'Ballad (G)', key: 'G', style: 'ballad', tempo: 68,
    text: `| G D/F# | Em7 D | Cmaj7 G/B | Am7 D7 |
| G D/F# | Em7 G7 | Cmaj7 Cm6 | G |`,
  },
];

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

interface DdOption { value: string; label: string }

/** Styled dropdown (native selects can't be themed). */
function Dropdown({ value, options, onChange, placeholder, menuAlign = 'right' }: {
  value: string | null;
  options: DdOption[];
  onChange: (v: string) => void;
  placeholder?: string;
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
          {options.map(o => (
            <button
              type="button"
              key={o.value}
              className={`dd-item${o.value === value ? ' active' : ''}`}
              onClick={() => { onChange(o.value); setOpen(false); }}
            >{o.label}</button>
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
  const [title, setTitle] = useState(initial?.t ?? 'Untitled Session');
  const [chordText, setChordText] = useState(initial?.c ?? DEFAULT_PROGRESSION);
  const [keyName, setKeyName] = useState<KeyName>(initial?.k ?? 'C');
  const [styleId, setStyleId] = useState<StyleId>(initial?.s ?? 'jazz');
  const [settingsRaw, setSettings] = useState<GrooveSettings>(
    { ...getStyle(initial?.s ?? 'jazz').defaults, ...(initial?.g ?? {}) });
  // merge over style defaults so newly added fields always have a value
  const settings = useMemo<GrooveSettings>(
    () => ({ ...getStyle(styleId).defaults, ...settingsRaw }),
    [styleId, settingsRaw],
  );
  const [tempo, setTempo] = useState(initial?.b ?? 132);
  const [seed, setSeed] = useState(initial?.d ?? 1);
  const [tab, setTab] = useState<'lead' | 'piano'>('piano');
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(true);
  const [click, setClick] = useState(false);
  const [showFills, setShowFills] = useState(true);
  const [tone, setTone] = useState<ToneId>(initial?.o ?? 'suitcase');
  const [copied, setCopied] = useState(false);
  const [currentBar, setCurrentBar] = useState<number | null>(null);
  const [helpTopic, setHelpTopic] = useState<'notation' | 'groove' | null>(null);

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
    const svg = scoreRef.current?.querySelector('svg');
    if (!svg) return;
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

  const applyPreset = (p: typeof PRESETS[number]) => {
    setChordText(p.text);
    setKeyName(p.key);
    selectStyle(p.style);
    setTempo(p.tempo);
    setSeed(s => s + 1);
  };

  const barCount = song?.bars.length ?? 0;

  return (
    <div className="app">
      <header className="topbar">
        <div className="wordmark"><span className="tick">▮</span> QUICK LEAD SHEET</div>
        <div className="title-wrap">
          <input
            className="song-title"
            type="text"
            value={title}
            onChange={e => setTitle(e.target.value)}
            spellCheck={false}
          />
        </div>
        <button className="btn sm" onClick={share} title="Copy a link that opens this exact song & settings">
          {copied ? 'Copied!' : 'Share'}
        </button>
      </header>

      <div className="body">
        <aside className="controls">
          <div className="section">
            <div className="section-label">
              <span>Chords</span>
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
                options={PRESETS.map(p => ({ value: p.name, label: p.name }))}
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
            <div className="row">
              <span className="row-label" title="Transpose every chord (and the key) by a semitone">Transpose</span>
              <span style={{ display: 'inline-flex', gap: 6 }}>
                <button className="btn sm" onClick={() => transpose(-1)}>♭</button>
                <button className="btn sm" onClick={() => transpose(1)}>♯</button>
              </span>
            </div>
          </div>

          <div className="section">
            <div className="section-label">
              <span>Groove</span>
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

            <button className={`toggle${loop ? ' on' : ''}`} onClick={toggleLoop}>
              <span className="led" /> Loop
            </button>

            <button className={`toggle${click ? ' on' : ''}`} onClick={toggleClick} title="Metronome">
              <span className="led" /> Click
            </button>

            <div className="divider" />

            <div className="readout">
              <span className="label">Tempo</span>
              <input
                className="tempo-input"
                type="number"
                min={40}
                max={240}
                value={tempo}
                onChange={e => setTempo(Math.max(30, Math.min(300, Number(e.target.value) || 120)))}
              />
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
              <span className="label">Position</span>
              <span className="value">
                {currentBar != null ? `${currentBar + 1}` : '–'} / {barCount || '–'}
              </span>
            </div>

            <div className="spacer" />

            <button
              className={`toggle${showFills ? ' on' : ''}`}
              onClick={() => setShowFills(v => !v)}
              title="Notate fills on the score (playback & MIDI always include them)"
            >
              <span className="led" /> Fills
            </button>

            <div className="divider" />

            <Dropdown
              value={null}
              placeholder="Export"
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

            <div className="divider" />

            <div className="tabs">
              <button className={`tab${tab === 'lead' ? ' active' : ''}`} onClick={() => setTab('lead')}>Lead Sheet</button>
              <button className={`tab${tab === 'piano' ? ' active' : ''}`} onClick={() => setTab('piano')}>Piano</button>
            </div>
          </div>

          <div className="score-scroll">
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
              containerRef={scoreRef}
            />
          </div>
        </main>
      </div>

      {helpTopic && (
        <div className="modal-overlay" onClick={() => setHelpTopic(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <span>{helpTopic === 'notation' ? 'Notation Guide' : 'Groove Guide'}</span>
              <button className="modal-close" onClick={() => setHelpTopic(null)} title="Close">×</button>
            </div>
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
