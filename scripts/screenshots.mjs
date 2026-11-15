// Regenerates the README images from the demo (no dependencies; needs Google
// Chrome, and Python with Pillow for the animated ones).
//
//   node scripts/screenshots.mjs            all images into docs/images/
//   node scripts/screenshots.mjs wall-*     only matching names
//
// Starts two demo servers: a calm one (everything green) and one with an
// incident in progress, so problem screens have something to show.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs/images');
const CHROME = process.env.CHROME || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
const only = process.argv[2] ? new RegExp(`^${process.argv[2].replace(/\*/g, '.*')}$`) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

const CALM = 'http://127.0.0.1:3971', INCIDENT = 'http://127.0.0.1:3972';
const clickNode = (id) => `document.querySelector('.mnode[data-node="${id}"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`;

// name, url, [width, height], { wait, js, frames }
const SHOTS = [
  ['overview-dark', `${CALM}/`, [1440, 1560], { wait: 6000 }],
  ['overview-light', `${CALM}/?theme=light`, [1440, 1560], { wait: 6000 }],
  ['problem', `${INCIDENT}/`, [1440, 900], { wait: 6000 }],
  ['drawer', `${CALM}/#pve`, [1440, 1000], { wait: 6000 }],
  ['phone', `${CALM}/`, [390, 844], { wait: 6000, scale: 3 }],
  ['map-network', `${CALM}/maps#network`, [1440, 1000], { wait: 5000 }],
  ['map-services-impact', `${CALM}/maps#services`, [1440, 1240], { wait: 4000, js: `document.querySelector('#map-impact').click(); ${clickNode('truenas')}`, after: 2500 }],
  ['map-data', `${CALM}/maps#data`, [1440, 1000], { wait: 5000 }],
  ['wall-overview', `${CALM}/wall?night=off&scenes=overview`, [1920, 1080], { wait: 6000 }],
  ['wall-machines', `${CALM}/wall?night=off&scenes=machines`, [1920, 1080], { wait: 6000 }],
  ['wall-proxmox', `${CALM}/wall?night=off&scenes=proxmox`, [1920, 1080], { wait: 6000 }],
  ['wall-alert', `${INCIDENT}/wall?night=off&scenes=attention`, [1920, 1080], { wait: 7000 }],
  // animated: the network map's moving packets
  ['map-live', `${CALM}/maps?embed=1#network`, [1280, 760], { wait: 5000, frames: 48, every: 83, scale: 1 }],
];

function startDemo(port, env) {
  const p = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--demo'], { env: { ...process.env, PORT: String(port), ...env }, stdio: ['ignore', 'ignore', 'inherit'] });
  return p;
}

async function chrome() {
  const port = 9600 + Math.floor(Math.random() * 300);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'hls-shots-'));
  const proc = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, 'about:blank'], { stdio: 'ignore' });
  let ws;
  for (let i = 0; i < 60 && !ws; i++) {
    try { const t = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const pg = t.find((x) => x.type === 'page'); if (pg) ws = new WebSocket(pg.webSocketDebuggerUrl); } catch { /* starting */ }
    await sleep(200);
  }
  if (ws.readyState !== WebSocket.OPEN) await new Promise((r) => ws.addEventListener('open', r));
  let id = 0; const pending = new Map();
  ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result); pending.delete(d.id); } });
  const send = (method, params = {}) => new Promise((r, j) => {
    const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => { if (pending.delete(i)) j(new Error(`${method} timed out`)); }, 60_000);
  });
  return { send, close: async () => { ws.close(); proc.kill(); await sleep(800); try { fs.rmSync(prof, { recursive: true, force: true, maxRetries: 5 }); } catch { /* chrome still exiting */ } } };
}

const calm = startDemo(3971, { DEMO_INCIDENTS: '0' });
const incident = startDemo(3972, { DEMO_FIRST_INCIDENT_MIN: '0' });
for (const base of [CALM, INCIDENT]) {
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* starting */ }
    if (i > 50) throw new Error(`demo server at ${base} did not start (port in use?)`);
    await sleep(200);
  }
}
await sleep(1500); // first reporter round
const c = await chrome();
try {
  for (const [name, url, [w, h], o] of SHOTS) {
    if (only && !only.test(name)) continue;
    process.stdout.write(`${name} … `);
    const scale = o.scale ?? 2;
    await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: scale, mobile: w < 700 });
    await c.send('Page.navigate', { url: 'about:blank' });
    await c.send('Page.navigate', { url });
    await sleep(o.wait);
    if (o.js) { await c.send('Runtime.evaluate', { expression: o.js }); await sleep(o.after || 1000); }
    if (o.frames) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hls-frames-'));
      for (let i = 0; i < o.frames; i++) {
        const t0 = Date.now();
        const s = await c.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(dir, `${String(i).padStart(3, '0')}.png`), Buffer.from(s.data, 'base64'));
        await sleep(Math.max(0, o.every - (Date.now() - t0)));
      }
      execFileSync('python3', ['-c', `
import glob, sys
from PIL import Image
fs = sorted(glob.glob(sys.argv[1] + '/*.png'))
im = [Image.open(f).convert('RGB') for f in fs]
im[0].save(sys.argv[2], save_all=True, append_images=im[1:], duration=${o.every}, loop=0, quality=80, method=6)
`, dir, path.join(OUT, `${name}.webp`)]);
      fs.rmSync(dir, { recursive: true, force: true });
    } else {
      const s = await c.send('Page.captureScreenshot', { format: 'webp', quality: 88 });
      fs.writeFileSync(path.join(OUT, `${name}.webp`), Buffer.from(s.data, 'base64'));
    }
    console.log(`docs/images/${name}.webp`);
  }
} finally {
  await c.close(); calm.kill(); incident.kill();
}
