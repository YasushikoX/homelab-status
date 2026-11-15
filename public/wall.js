/* /wall: always-on display that rotates through the whole home lab.
   Read-only, no clicks needed. Problems take over the screen; the page keeps
   the display awake, hides the cursor, nudges itself against burn-in, dims at
   night and reloads itself after a deploy.

   URL options (all optional):
     ?scenes=overview,machines,proxmox,services,quota,network,servicemap,datamap,activity,updates
     &dur=15        seconds per scene (map scenes run as long as their camera tour)
     &night=23-7    dim between these hours (local time of the display); night=off to disable
     &theme=dark    or light
*/
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const P = new URLSearchParams(location.search);
  const theme = P.get('theme') === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  const DUR = Math.max(6, Number(P.get('dur')) || 15) * 1000;
  const NIGHT = (P.get('night') || '23-7') === 'off' ? null : (P.get('night') || '23-7').split('-').map(Number);
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const servedBy = (i) => {
  const f = i.failover;
  if (i.demo) return 'Demo mode · a fictional home lab with simulated data';
  if (!f) return `Served by ${i.host}`;
  return i.role === 'primary' ? `Served by ${f.primary} · backup on ${f.backup} is on standby` : `Served by the backup on ${f.backup}`;
};
const ICON = {
    ok: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7.2" fill="currentColor"/><path d="M4.7 8.3l2.2 2.2 4.4-4.7" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    warn: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M7.1 1.9a1 1 0 0 1 1.8 0l6.3 11.3a1 1 0 0 1-.9 1.5H1.7a1 1 0 0 1-.9-1.5z" fill="currentColor"/><path d="M8 6v3.4" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/><circle cx="8" cy="11.8" r=".95" fill="#fff"/></svg>',
    down: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7.2" fill="currentColor"/><path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/></svg>',
    off: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5 8h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    unknown: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="3 2.2"/></svg>',
  };
  const LBL = { ok: 'OK', warn: 'Attention', down: 'Down', off: 'Off', unknown: 'Checking' };
  const st = (s, label) => `<span class="w-st ${esc(s)}">${ICON[s] || ICON.unknown}<span>${esc(label ?? LBL[s] ?? s)}</span></span>`;
  const dot = (s) => `<span class="w-st ${esc(s)} icon-only" title="${esc(LBL[s] || s)}">${ICON[s] || ICON.unknown}</span>`;

  const fmtBytes = (b) => { if (b == null) return '–'; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let v = b; while (v >= 1000 && i < u.length - 1) { v /= 1000; i++; } return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`; };
  const ago = (t) => { if (!t) return '–'; const s = Math.max(0, (Date.now() - t) / 1000); if (s < 60) return `${Math.round(s)} s ago`; if (s < 3600) return `${Math.round(s / 60)} min ago`; if (s < 86400) return `${Math.round(s / 3600)} h ago`; return `${Math.round(s / 86400)} d ago`; };
  const inT = (t) => { const s = (t - Date.now()) / 1000; if (s <= 0) return 'now'; if (s < 3600) return `${Math.round(s / 60)} min`; if (s < 86400) return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`; return `${Math.round(s / 86400)} d`; };
  const upt = (s) => (s == null ? '–' : s < 3600 ? `${Math.round(s / 60)} min` : s < 86400 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} d`);
  const pct = (u, t) => (t ? (100 * u) / t : null);
  const level = (p) => (p == null ? '' : p >= 95 ? 'crit' : p >= 85 ? 'high' : '');

  function meter(label, p, sub = '') {
    const v = p == null ? 0 : Math.max(0, Math.min(100, p));
    return `<div class="w-meter ${level(p)}"><div class="w-meter-top"><span>${esc(label)}</span><b>${p == null ? '–' : `${Math.round(p)}%`}</b></div>
      <div class="w-track"><i style="width:${v.toFixed(1)}%"></i></div>${sub ? `<div class="w-meter-sub">${esc(sub)}</div>` : ''}</div>`;
  }
  function spark(hist) {
    if (!hist || hist.length < 3) return '<div class="w-spark empty">collecting history…</div>';
    const W = 400, H = 70;
    const t0 = hist[0].t, t1 = hist[hist.length - 1].t || t0 + 1;
    const x = (t) => ((t - t0) / Math.max(1, t1 - t0)) * W;
    const y = (v) => H - 3 - (Math.max(0, Math.min(100, v ?? 0)) / 100) * (H - 6);
    const line = (k) => hist.filter((p) => p[k] != null).map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p[k]).toFixed(1)}`).join(' ');
    return `<svg class="w-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <path class="grid" d="M0,${y(50)} H${W}"/><path class="cpu" d="${line('cpu')}"/><path class="mem" d="${line('mem')}"/></svg>
      <div class="w-spark-legend"><span class="k cpu">CPU</span><span class="k mem">Memory</span><span>last ${Math.max(1, Math.round((t1 - t0) / 60000))} min</span></div>`;
  }
  function ring(left, label, sub) {
    const r = 46, c = 2 * Math.PI * r, v = Math.max(0, Math.min(100, left ?? 0));
    const sev = left == null ? '' : left <= 0 ? 'crit' : left <= 10 ? 'high' : '';
    return `<div class="w-ring ${sev}"><svg viewBox="0 0 110 110" aria-hidden="true"><circle class="bg" cx="55" cy="55" r="${r}"/><circle class="fg" cx="55" cy="55" r="${r}" stroke-dasharray="${((c * v) / 100).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 55 55)"/></svg>
      <div class="w-ring-mid"><b>${left == null ? '–' : `${Math.round(left)}%`}</b><span>left</span></div><div class="w-ring-label">${esc(label)}</div>${sub ? `<div class="w-ring-sub">${esc(sub)}</div>` : ''}</div>`;
  }

  // ---------------------------------------------------------------- scenes
  const machineCard = (m) => {
    const s = m.stats || {};
    const mem = s.mem ? pct(s.mem.used_bytes, s.mem.total_bytes) : null;
    const disk = (s.disks || []).slice().sort((a, b) => b.total_bytes - a.total_bytes)[0];
    return `<section class="w-card w-mcard ${esc(m.status)}">
      <header><div><h3>${esc(m.name)}</h3><p>${esc([m.os, s.os?.version, m.site].filter(Boolean).join(' · '))}</p></div>${st(m.status, { ok: 'Online', warn: 'Attention', down: 'Down', off: 'Off' }[m.status])}</header>
      ${m.stats ? `<div class="w-meters">${meter('CPU', s.cpu_percent, s.load ? `load ${s.load.map((v) => v.toFixed(1)).join(' · ')}` : '')}${meter('Memory', mem, s.mem ? `${fmtBytes(s.mem.used_bytes)} of ${fmtBytes(s.mem.total_bytes)}` : '')}${disk ? meter(`Disk ${disk.mount}`, pct(disk.used_bytes, disk.total_bytes), `${fmtBytes(disk.total_bytes - disk.used_bytes)} free`) : ''}${s.iowait_percent != null ? meter('I/O wait', s.iowait_percent, 'CPU time waiting on disk') : ''}</div>
      ${spark(m.history)}
      <footer><span>up ${upt(s.uptime_s)}</span>${s.cpu_name ? `<span>${esc(s.cpu_name.replace(/\(R\)|\(TM\)|CPU|@.*$/g, '').trim())}${s.cores ? ` · ${s.cores} cores` : ''}</span>` : ''}${m.ping?.ms != null ? `<span>${Math.round(m.ping.ms)} ms</span>` : ''}</footer>`
      : `<div class="w-off-msg">${esc(m.reason || 'no stats')}</div>`}
    </section>`;
  };

  const SCENES = [
    { id: 'overview', title: 'Overview', render: (s) => {
      const sum = s.summary, probs = sum.problems;
      const down = probs.filter((p) => p.status === 'down').length, warn = probs.length - down;
      const head = down ? `<h1 class="down">${down} thing${down === 1 ? '' : 's'} down</h1>` : warn ? `<h1 class="warn">${warn} thing${warn === 1 ? '' : 's'} need${warn === 1 ? 's' : ''} attention</h1>` : '<h1 class="ok">All systems normal</h1>';
      const lowest = s.quota.accounts.filter((a) => a.status !== 'off' && a.lowest).sort((a, b) => a.lowest.left - b.lowest.left)[0];
      return `<div class="w-overview">
        <div class="w-hero">${down ? ICON.down : warn ? ICON.warn : ICON.ok}${head}<p>${esc(servedBy(s.instance))}</p></div>
        <div class="w-kpis">
          <div class="w-kpi"><span>Machines online</span><b>${sum.machinesUp}<small>/${sum.machinesTotal}</small></b></div>
          <div class="w-kpi"><span>Checks passing</span><b>${sum.checksOk}<small>/${sum.checksTotal}</small></b></div>
          <div class="w-kpi"><span>Pending updates</span><b>${sum.updates}</b><em>${sum.security} security</em></div>
          <div class="w-kpi"><span>Lowest AI quota</span><b>${lowest ? `${Math.round(lowest.lowest.left)}<small>%</small>` : '–'}</b><em>${lowest ? esc(`${lowest.providerName} · ${lowest.lowest.label}`) : ''}</em></div>
        </div>
        <div class="w-mstrip">${s.machines.map((m) => `<div class="w-mpill ${esc(m.status)}">${dot(m.status)}<b>${esc(m.name)}</b><span>${m.stats?.cpu_percent != null ? `CPU ${Math.round(m.stats.cpu_percent)}%` : esc({ ok: 'online', off: 'off', down: 'down', warn: 'attention' }[m.status] || '')}</span></div>`).join('')}</div>
      </div>`;
    } },
    { id: 'attention', title: 'Needs attention', when: (s) => s.summary.problems.length > 0, render: (s) => {
      const name = (id) => s.machines.find((m) => m.id === id)?.name || '';
      const ps = s.summary.problems.slice().sort((a, b) => (a.status === 'down' ? 0 : 1) - (b.status === 'down' ? 0 : 1));
      return `<div class="w-alerts">${ps.slice(0, 8).map((p) => `<div class="w-alert ${esc(p.status)}">${ICON[p.status] || ICON.warn}<div><h2>${esc(p.name)}</h2><p>${esc([name(p.machine) !== p.name ? name(p.machine) : '', p.detail].filter(Boolean).join(' · '))}</p></div><span class="w-alert-tag">${esc(LBL[p.status])}</span></div>`).join('')}
        ${ps.length > 8 ? `<p class="w-more">and ${ps.length - 8} more</p>` : ''}</div>`;
    } },
    { id: 'machines', title: 'Machines', render: (s) => {
      const big = s.machines.filter((m) => m.collector);
      const small = s.machines.filter((m) => !m.collector);
      return `<div class="w-machines">${big.map(machineCard).join('')}</div>
        ${small.length ? `<div class="w-mstrip compact">${small.map((m) => `<div class="w-mpill ${esc(m.status)}">${dot(m.status)}<b>${esc(m.name)}</b><span>${esc(m.ping?.ms != null ? `${Math.round(m.ping.ms)} ms` : m.reason || '')}</span></div>`).join('')}</div>` : ''}`;
    } },
    { id: 'proxmox', title: 'Proxmox', when: (s) => s.machines.some((m) => m.guests), render: (s) => {
      const m = s.machines.find((x) => x.guests);
      const gs = m.guests.slice().sort((a, b) => (a.status === 'running' ? 0 : 1) - (b.status === 'running' ? 0 : 1) || a.vmid - b.vmid);
      const res = m.checks.filter((c) => c.group === 'Resources');
      return `<div class="w-pve">
        <div class="w-guests">${gs.map((g) => {
          const run = g.status === 'running';
          return `<div class="w-guest ${run ? 'ok' : 'off'}"><div class="w-guest-top">${dot(run ? 'ok' : 'off')}<b>${esc(g.name)}</b><span>${g.type === 'qemu' ? 'VM' : 'CT'} ${g.vmid}</span></div>
            ${run ? `${meter('CPU', g.cpu_percent)}${g.type === 'qemu' ? meter('Memory', pct(g.mem_bytes, g.maxmem_bytes), `${fmtBytes(g.maxmem_bytes)} · includes the VM's cache`).replace('w-meter crit', 'w-meter neutral').replace('w-meter high', 'w-meter neutral') : meter('Memory', pct(g.mem_bytes, g.maxmem_bytes), `${fmtBytes(g.mem_bytes)} of ${fmtBytes(g.maxmem_bytes)}`)}<div class="w-guest-foot">up ${upt(g.uptime_s)}${g.ip ? ` · ${esc(g.ip)}` : ''}</div>` : `<div class="w-off-msg">${g.onboot === false ? 'stopped on purpose' : 'stopped'}</div>`}</div>`;
        }).join('')}</div>
        <aside class="w-card w-storage"><h3>Storage</h3>${(m.storage || []).map((x) => meter(x.name, pct(x.used_bytes, x.total_bytes), `${fmtBytes(x.total_bytes - x.used_bytes)} free of ${fmtBytes(x.total_bytes)}`)).join('')}
          <h3>Disks</h3><ul class="w-list">${res.filter((c) => c.name.startsWith('Disk ')).map((c) => `<li>${dot(c.status)}<span>${esc(c.name.replace(/^Disk /, ''))}</span><em>${esc(c.detail)}</em></li>`).join('')}</ul>
          ${m.stats ? `<h3>Host</h3>${meter('CPU', m.stats.cpu_percent)}${meter('I/O wait', m.stats.iowait_percent)}` : ''}</aside>
      </div>`;
    } },
    { id: 'services', title: 'Services', render: (s) => {
      const groups = new Map();
      for (const x of s.services) { if (!groups.has(x.group)) groups.set(x.group, []); groups.get(x.group).push(x); }
      const ok = s.services.filter((x) => x.status === 'ok').length, off = s.services.filter((x) => x.status === 'off').length;
      const bad = s.services.length - ok - off;
      return `<div class="w-svc-head">${st(bad ? 'warn' : 'ok', `${ok} answering${off ? ` · ${off} off on purpose` : ''}${bad ? ` · ${bad} not answering` : ''}`)}</div>
        <div class="w-svcs">${[...groups].map(([g, xs]) => `<section class="w-svc-group"><h3>${esc(g)}</h3>${xs.map((x) => `<div class="w-svc ${esc(x.status)}">${dot(x.status)}<span class="nm">${esc(x.name)}</span><span class="ms">${x.ms != null && x.status === 'ok' ? `${x.ms} ms` : esc(x.status === 'ok' ? '' : (x.detail || '').slice(0, 40))}</span></div>`).join('')}</section>`).join('')}</div>`;
    } },
    { id: 'quota', title: 'AI quota left', when: (s) => s.quota.accounts.length > 0, render: (s) => `<div class="w-quota">${s.quota.accounts.map((a) => `<section class="w-card w-qcard ${esc(a.status)}">
        <header><div><h3>${esc(a.providerName)}</h3><p>${esc(a.account)}</p></div>${st(a.status, a.statusLabel)}</header>
        <div class="w-rings">${(a.windows || []).slice(0, 3).map((w) => ring(w.left, w.label, w.resetsAt ? `resets in ${inT(w.resetsAt)}` : '')).join('') || '<div class="w-off-msg">no usage windows reported</div>'}</div>
      </section>`).join('')}</div>` },
    // map scenes last as long as their camera tour (full view + one stop per region)
    { id: 'network', title: 'Network map', map: 'network', secs: 25 },
    { id: 'servicemap', title: 'Service map', map: 'services', secs: 29 },
    { id: 'datamap', title: 'Data & backups', map: 'data', secs: 14 },
    { id: 'activity', title: 'Recent activity', render: (s) => `<ol class="w-events">${(s.events || []).slice(0, 11).map((e) => `<li class="${esc(e.status)}"><span class="w-ev-time">${esc(ago(e.at))}</span>${dot(e.status === 'info' ? 'unknown' : e.status === 'running' ? 'unknown' : e.status)}<div><b>${esc(e.title)}</b>${e.detail || e.machine ? `<p>${esc([e.machine, e.detail].filter(Boolean).join(' · '))}</p>` : ''}</div></li>`).join('')}</ol>` },
    { id: 'updates', title: 'Updates', render: (s) => {
      const rows = s.machines.filter((m) => m.updates?.total || m.updates?.rebootRequired);
      const apps = s.machines.flatMap((m) => (m.updates?.items || []).filter((i) => i.kind === 'App').map((i) => ({ ...i, where: m.name })));
      const max = Math.max(1, ...rows.map((m) => m.updates.total));
      return `<div class="w-updates"><section class="w-card"><h3>Pending by machine</h3>${rows.length ? rows.map((m) => `<div class="w-urow"><b>${esc(m.name)}</b><div class="w-ubar"><i style="width:${((100 * m.updates.total) / max).toFixed(1)}%"></i><i class="sec" style="width:${((100 * m.updates.security) / max).toFixed(1)}%"></i></div><span>${m.updates.total}${m.updates.security ? ` · ${m.updates.security} security` : ''}${m.updates.rebootRequired ? ' · reboot needed' : ''}</span></div>`).join('') : '<p class="w-off-msg">Everything is up to date.</p>'}
          <div class="w-ulegend"><span class="k all">all updates</span><span class="k sec">security</span></div></section>
        <section class="w-card"><h3>New app versions</h3>${apps.length ? `<ul class="w-list">${apps.map((a) => `<li>${dot('warn')}<span>${esc(a.name)}</span><em>${esc(a.current || '?')} → ${esc(a.available)} · ${esc(a.where)}</em></li>`).join('')}</ul>` : '<p class="w-off-msg">All tracked apps are current.</p>'}</section></div>`;
    } },
  ];
  const wanted = (P.get('scenes') || '').split(',').map((x) => x.trim()).filter(Boolean);
  const scenes = wanted.length ? SCENES.filter((x) => wanted.includes(x.id)) : SCENES;

  // ---------------------------------------------------------------- data
  let S = null, fails = 0, idx = -1, timer = null, paused = false, holdUntil = 0, current = null, startedAt = 0;
  const seenDown = new Set();
  let firstData = true;

  async function load() {
    try {
      const r = await fetch('/api/state?wall=1', { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      S = await r.json(); fails = 0;
      document.body.classList.remove('offline');
      onData();
    } catch {
      if (++fails >= 2) document.body.classList.add('offline');
    }
  }

  function onData() {
    // header pill + problem strip
    const probs = S.summary.problems, down = probs.filter((p) => p.status === 'down');
    const overall = down.length ? 'down' : probs.length ? 'warn' : 'ok';
    $('#w-overall').innerHTML = st(overall, overall === 'ok' ? 'All normal' : overall === 'down' ? `${down.length} down` : `${probs.length} need attention`);
    const strip = $('#w-strip');
    strip.hidden = !probs.length;
    strip.className = `w-strip ${overall}`;
    strip.innerHTML = probs.length ? `${ICON[overall]}<span>${probs.slice(0, 4).map((p) => esc(p.name)).join(' · ')}${probs.length > 4 ? ` · +${probs.length - 4}` : ''}</span>` : '';
    // something newly down: interrupt the rotation and show it
    const keys = new Set(down.map((p) => p.key));
    const fresh = [...keys].filter((k) => !seenDown.has(k));
    for (const k of [...seenDown]) if (!keys.has(k)) seenDown.delete(k);
    fresh.forEach((k) => seenDown.add(k));
    if (fresh.length && !firstData) { holdUntil = Date.now() + 45_000; show(scenes.findIndex((x) => x.id === 'attention'), true); }
    if (firstData) scenes.filter((x) => x.map).forEach((x) => frameFor(x.map)); // load the maps in the background
    firstData = false;
    if (idx < 0) next();
    else if (current && !SCENES.find((x) => x.id === current)?.map) paint(false); // live refresh of the scene on screen
    $('#w-updated').textContent = `Live · updated ${ago(S.generatedAt)}`;
  }

  // ---------------------------------------------------------------- rotation
  const available = () => scenes.map((x, i) => [x, i]).filter(([x]) => !x.when || (S && x.when(S)));
  function durOf(sc) { return sc.secs ? sc.secs * 1000 : sc.id === 'attention' && holdUntil > Date.now() ? Math.max(DUR, holdUntil - Date.now()) : DUR; }
  function next(step = 1) {
    if (!S) return;
    const av = available(); if (!av.length) return;
    const pos = av.findIndex(([, i]) => i === idx);
    const [, i] = av[(pos + step + av.length) % av.length];
    show(i);
  }
  function show(i, urgent = false) {
    if (i < 0) return;
    idx = i;
    const sc = scenes[i];
    current = sc.id;
    paint(true);
    clearTimeout(timer);
    const d = durOf(sc);
    startedAt = Date.now();
    restartBar(d);
    if (!paused) timer = setTimeout(() => next(), d);
    if (urgent) $('#w-stage').classList.add('urgent'), setTimeout(() => $('#w-stage').classList.remove('urgent'), 1200);
  }
  function restartBar(d) {
    const bar = $('#w-bar');
    bar.style.transition = 'none'; bar.style.width = '0%';
    void bar.offsetWidth;
    if (!paused) { bar.style.transition = `width ${d}ms linear`; bar.style.width = '100%'; }
  }

  // maps live in persistent iframes (re-creating them would reload the page every time)
  const frames = {};
  function frameFor(mapId) {
    if (frames[mapId]) return frames[mapId];
    const f = document.createElement('iframe');
    f.className = 'w-frame';
    f.title = `${mapId} map`;
    f.src = `/maps?embed=1&tour=1&theme=${theme}#${mapId}`;
    f.setAttribute('tabindex', '-1');
    $('#w-frames').append(f);
    return (frames[mapId] = f);
  }

  function paint(animate) {
    const sc = SCENES.find((x) => x.id === current); if (!sc || !S) return;
    const stage = $('#w-stage');
    $('#w-scene-title').textContent = sc.title;
    const av = available();
    $('#w-dots').innerHTML = av.map(([x]) => `<i class="${x.id === sc.id ? 'on' : ''}"></i>`).join('');
    Object.entries(frames).forEach(([k, f]) => f.classList.toggle('on', k === sc.map));
    if (sc.map) { const f = frameFor(sc.map); f.classList.add('on'); if (animate) f.contentWindow?.postMessage({ type: 'wall-show' }, location.origin); } // restart its camera tour
    let el = stage.querySelector('.w-scene.shown');
    const html = sc.map ? '' : sc.render(S);
    if (!animate && el) { el.innerHTML = html; return; }
    const neu = document.createElement('div');
    neu.className = `w-scene s-${sc.id}${sc.map ? ' is-map' : ''}`;
    neu.innerHTML = html;
    stage.append(neu);
    requestAnimationFrame(() => {
      neu.classList.add('shown');
      if (el) { el.classList.remove('shown'); el.classList.add('leaving'); setTimeout(() => el.remove(), 900); }
    });
  }

  // ---------------------------------------------------------------- always-on care
  function tick() {
    const d = new Date();
    $('#w-time').textContent = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    $('#w-date').textContent = d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
    if (S) $('#w-updated').textContent = `Live · updated ${ago(S.generatedAt)}`;
    if (NIGHT) {
      const h = d.getHours(), [a, b] = NIGHT;
      document.body.classList.toggle('night', a > b ? h >= a || h < b : h >= a && h < b);
    }
  }
  // burn-in: drift the whole layout a few pixels every few minutes
  function drift() {
    if (reduceMotion) return;
    const r = () => Math.round((Math.random() * 2 - 1) * 6);
    $('#wall').style.transform = `translate(${r()}px, ${r()}px)`;
  }
  // keep the screen awake while visible
  let lock = null;
  async function wake() {
    try { if ('wakeLock' in navigator && document.visibilityState === 'visible' && !lock) { lock = await navigator.wakeLock.request('screen'); lock.addEventListener('release', () => { lock = null; }); } } catch { /* not allowed here; use the OS setting */ }
  }
  // reload after a deploy so the wall never runs stale code
  let build = null;
  async function checkBuild() {
    try {
      const h = await (await fetch('/api/health', { cache: 'no-store' })).json();
      if (build && h.build && h.build !== build) location.reload();
      build ||= h.build;
    } catch { /* offline: try again later */ }
  }
  // cursor hides after 3 s; any key or click shows a hint
  let idleT = null;
  function wakeCursor() {
    document.body.classList.remove('idle');
    clearTimeout(idleT); idleT = setTimeout(() => document.body.classList.add('idle'), 3000);
  }
  function hint(text, ms = 6000) {
    const h = $('#w-hint'); h.textContent = text; h.classList.add('on');
    clearTimeout(hint.t); hint.t = setTimeout(() => h.classList.remove('on'), ms);
  }
  function togglePause() {
    paused = !paused;
    clearTimeout(timer);
    if (paused) { hint('Paused · Space to resume', 1e9); const bar = $('#w-bar'); bar.style.transition = 'none'; bar.style.width = getComputedStyle(bar).width; }
    else { hint('Resumed'); show(idx); }
  }
  addEventListener('keydown', (ev) => {
    wakeCursor();
    if (ev.key === 'ArrowRight') next(1);
    else if (ev.key === 'ArrowLeft') next(-1);
    else if (ev.key === ' ') { ev.preventDefault(); togglePause(); }
    else if (ev.key === 'f' || ev.key === 'F') toggleFull();
  });
  function toggleFull() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  }
  addEventListener('mousemove', wakeCursor);
  addEventListener('click', () => { wakeCursor(); toggleFull(); wake(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { wake(); load(); } });

  tick(); setInterval(tick, 1000);
  load(); setInterval(load, 15_000);
  checkBuild(); setInterval(checkBuild, 60_000);
  setInterval(drift, 180_000);
  wake(); wakeCursor();
  hint('Click or press F for full screen · ← → to switch · Space to pause', 9000);
})();
