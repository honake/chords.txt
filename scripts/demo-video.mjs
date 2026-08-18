// Records the X demo: type chords → score grows → play (with captured audio) → tab switch.
// Usage: node scripts/demo-video.mjs   (dev server must be running on :5173)
import { chromium } from 'playwright';
import fs from 'node:fs';

const ST = `| Gm9 Am7 | Bbmaj9 Am7 | Gm9 Am7 | >Bbmaj9 |
| Gm9 Am7 | Bbmaj9 Am7 | [3-3-2-3-3-2] Gm9 Gm9 Gm9 C13 | >Fmaj9 |`;

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  recordVideo: { dir: 'demo-out', size: { width: 1280, height: 720 } },
});
const wall0 = Date.now();
const page = await ctx.newPage();
await page.goto('http://localhost:5173');
await page.waitForSelector('.score-page svg', { timeout: 20000 });

// tap the app's AudioContext output into a MediaRecorder
await page.evaluate(() => {
  const Orig = window.AudioContext;
  window.__chunks = [];
  window.AudioContext = class extends Orig {
    constructor(...a) {
      super(...a);
      if (!window.__recDest) {
        const dest = this.createMediaStreamDestination();
        window.__recDest = dest;
        const rec = new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 192000 });
        rec.ondataavailable = e => window.__chunks.push(e.data);
        window.__rec = rec;
        rec.start(250);
        window.__recWall = Date.now();
      }
    }
  };
  const oc = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (t, ...r) {
    const out = oc.call(this, t, ...r);
    try {
      if (t instanceof AudioDestinationNode && window.__recDest && this.context === window.__recDest.context) {
        oc.call(this, window.__recDest);
      }
    } catch { /* cross-context */ }
    return out;
  };
});

const setVal = (sel, v, proto) => page.evaluate(([s, val, p]) => {
  const el = document.querySelector(s);
  const set = Object.getOwnPropertyDescriptor(window[p].prototype, 'value').set;
  set.call(el, val);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, [sel, v, proto]);

await setVal('.song-title', 'St. Denis Vamp', 'HTMLInputElement');
await setVal('textarea.chords', '', 'HTMLTextAreaElement');
await page.evaluate(() => document.querySelector('textarea.chords').focus());
await page.waitForTimeout(1400);

// type the progression character by character
for (let i = 1; i <= ST.length; i++) {
  await setVal('textarea.chords', ST.slice(0, i), 'HTMLTextAreaElement');
  await page.waitForTimeout(26);
}
await page.waitForTimeout(1400);

const clickWall = Date.now();
await page.click('.play-btn');
await page.waitForTimeout(10000);
await page.locator('.tab', { hasText: 'Lead Sheet' }).click();
await page.waitForTimeout(6000);
await page.locator('.tab', { hasText: 'Piano' }).click();
await page.waitForTimeout(6500);

const audioB64 = await page.evaluate(async () => {
  if (!window.__rec) return null;
  await new Promise(res => { window.__rec.onstop = res; window.__rec.stop(); });
  const blob = new Blob(window.__chunks, { type: 'audio/webm' });
  const buf = await blob.arrayBuffer();
  let bin = '';
  const b = new Uint8Array(buf);
  for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(bin);
});
const recWall = await page.evaluate(() => window.__recWall ?? null);

fs.mkdirSync('demo-out', { recursive: true });
if (audioB64) fs.writeFileSync('demo-out/audio.webm', Buffer.from(audioB64, 'base64'));
const video = page.video();
await ctx.close();
const vpath = await video.path();
fs.writeFileSync('demo-out/meta.json', JSON.stringify({ wall0, clickWall, recWall, vpath }, null, 2));
await browser.close();
console.log(JSON.stringify({ vpath, audio: audioB64 ? audioB64.length : 0, offsetSec: recWall ? (recWall - wall0) / 1000 : null }));
