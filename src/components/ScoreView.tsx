import { useEffect, useRef, useState } from 'react';
import type { Song } from '../lib/generate';
import type { KeyName } from '../lib/theory';
import type { ScoreGeom } from '../lib/notation';
import { renderLeadSheet, renderPianoScore } from '../lib/notation';

interface Props {
  mode: 'lead' | 'piano';
  song: Song | null;
  keyName: KeyName;
  title: string;
  tempo: number;
  styleName: string;
  feelName: string;
  showFills: boolean;
  currentBar: number | null;
  containerRef: React.RefObject<HTMLDivElement | null>;
}

export function ScoreView({ mode, song, keyName, title, tempo, styleName, feelName, showFills, currentBar, containerRef }: Props) {
  const innerRef = useRef<HTMLDivElement>(null);
  const [geom, setGeom] = useState<ScoreGeom | null>(null);

  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    if (!song || song.bars.length === 0) {
      el.innerHTML = '';
      setGeom(null);
      return;
    }
    const opts = { key: keyName, title, tempo, styleName, feelName, showFills };
    try {
      const g = mode === 'lead'
        ? renderLeadSheet(el, song.bars, opts, song.sections)
        : renderPianoScore(el, song, opts);
      const svg = el.querySelector('svg');
      if (svg) {
        svg.setAttribute('viewBox', `0 0 ${g.width} ${g.height}`);
        svg.removeAttribute('width');
        svg.removeAttribute('height');
        (svg as SVGElement).style.width = '100%';
        (svg as SVGElement).style.height = 'auto';
      }
      setGeom(g);
    } catch (err) {
      console.error('score render failed', err);
      el.innerHTML = '';
      setGeom(null);
    }
  }, [song, mode, keyName, title, tempo, styleName, feelName, showFills]);

  const hl = currentBar != null && geom
    ? geom.bars.find(b => b.bar === currentBar)
    : null;

  if (!song || song.bars.length === 0) {
    return (
      <div className="score-paper" ref={containerRef}>
        <div className="empty-note">
          Type a chord progression to see the score<br />
          e.g. | Cmaj7 Am7 | Dm7 G7 |
        </div>
      </div>
    );
  }

  return (
    <div className="score-paper" ref={containerRef}>
      <div style={{ position: 'relative' }}>
        <div ref={innerRef} />
        {hl && geom && (
          <div
            className="bar-highlight"
            style={{
              left: `${(hl.x / geom.width) * 100}%`,
              top: `${(hl.y / geom.height) * 100}%`,
              width: `${(hl.w / geom.width) * 100}%`,
              height: `${(hl.h / geom.height) * 100}%`,
            }}
          />
        )}
      </div>
    </div>
  );
}
