/* Maps page: network, services and data/backup maps.
   Hand-laid-out SVG (positions live in maps.mjs on the server), colored live
   from /api/maps. Pan/zoom, hover highlighting, a details panel, search,
   impact mode, moving packets and a table view.
   Uses esc / badge / STATUS_ICONS / LABELS / moveThumb / VIEW from app.js. */
(() => {
  if (location.pathname.replace(/\/$/, '') !== '/maps') return;

  const q = (s, r = document) => r.querySelector(s);
  const NODE_H = 48;
  const RISER = 12;
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const coarse = matchMedia('(pointer: coarse)').matches;
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };

  const ICONS = {
    server: 'M4 4h16v6H4zM4 14h16v6H4zM7.5 7h.01M7.5 17h.01',
    laptop: 'M5 5h14v10H5zM2.5 19h19',
    desktop: 'M3 4h18v12H3zM9 20h6M12 16v4',
    phone: 'M8 2.5h8a1 1 0 0 1 1 1v17a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1v-17a1 1 0 0 1 1-1zM11 18.5h2',
    router: 'M3 14h18v6H3zM7 17h.01M11 17h.01M8 10a5.5 5.5 0 0 1 8 0M5.5 7.5a9 9 0 0 1 13 0',
    globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.5 2.7 3.6 5.7 3.6 9s-1.1 6.3-3.6 9c-2.5-2.7-3.6-5.7-3.6-9S9.5 5.7 12 3z',
    cloud: 'M7 18h10a4 4 0 0 0 .6-8A6 6 0 0 0 6.2 9.2 4.5 4.5 0 0 0 7 18z',
    shield: 'M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z',
    box: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12 4 7.5',
    vm: 'M4 5h16v14H4zM4 9h16M7 7h.01',
    disk: 'M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
    network: 'M12 3v5M5 16v-3h14v3M12 8v5M3 16h4v5H3zM10 16h4v5h-4zM17 16h4v5h-4z',
    chat: 'M4 5h16v11H9l-5 4z',
    code: 'M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14',
    bot: 'M6 9h12v10H6zM12 5v4M9.5 14h.01M14.5 14h.01M3 13v3M21 13v3M12 3.5a1.5 1.5 0 1 0 0 .01',
    bolt: 'M13 2 5 14h6l-1 8 8-12h-6z',
    gauge: 'M4 16a8 8 0 1 1 16 0M12 16l4-5M12 16h.01',
    sync: 'M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3M18 3v4h-4M6 21v-4h4',
    archive: 'M3 5h18v4H3zM5 9v10h14V9M10 13h4',
    mail: 'M3 6h18v12H3zM3 7l9 6 9-6',
    note: 'M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h5',
    brain: 'M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V5a3 3 0 0 0-3-1zM15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1',
    parts: 'M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1',
    calendar: 'M4 5h16v15H4zM4 10h16M8 3v4M16 3v4',
    search: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM15.5 15.5 21 21',
    pulse: 'M3 12h4l3-8 4 16 3-8h4',
    pen: 'M4 20l4-1 11-11-3-3L5 16zM14 6l3 3',
    hub: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 3v6M12 15v6M4.2 7.5l5.2 3M14.6 13.5l5.2 3M4.2 16.5l5.2-3M14.6 10.5l5.2-3',
    chip: 'M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4',
    spark: 'M12 3l2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2z',
    key: 'M8 14a4 4 0 1 1 3.5-6L21 8v3h-2v2h-2v2h-3.5A4 4 0 0 1 8 14zM6.5 10h.01',
    alert: 'M12 4 3 20h18zM12 10v4M12 17h.01',
    home: 'M3.5 11 12 4l8.5 7M6 9.5V20h12V9.5M10 20v-5h4v5',
    film: 'M4 4h16v16H4zM8 4v16M16 4v16M4 8h4M4 12h4M4 16h4M16 8h4M16 12h4M16 16h4',
    image: 'M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5M15.5 9.5h.01',
    lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3M12 15v2',
  };

  // ---------------------------------------------------------------- state
  let DATA = null;            // { maps, status, generatedAt }
  let map = null;             // current map definition
  let nodes = new Map();      // id -> node (with w, h, full name)
  let edgeByKey = new Map();
  let selected = null;
  let hoverId = null;
  let impact = false;
  let query = '';
  let motion = !reduceMotion && store.get('maps.motion') !== 'off';
  let locked = !EMBED && coarse && innerWidth < 760; // phones: one finger scrolls the page until "Explore"
  let onScreen = true;
  const hiddenTypes = {};
  const view = { tx: 0, ty: 0, k: 1 };

  const root = q('#maps-root');
  const wrap = q('.map-wrap');
  const canvas = q('#map-canvas');
  const svg = q('#map-svg');
  const panel = q('#map-panel');
  const tip = q('#tooltip');
  const live = q('#map-live');

  const ctx = document.createElement('canvas').getContext('2d');
  const fontFamily = getComputedStyle(document.body).fontFamily || 'system-ui';
  function fit(text, px, weight, maxW) {
    ctx.font = `${weight} ${px}px ${fontFamily}`;
    if (ctx.measureText(text).width <= maxW) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    return t.trimEnd() + '…';
  }
  const textW = (text, px, weight) => { ctx.font = `${weight} ${px}px ${fontFamily}`; return ctx.measureText(text).width; };

  // ---------------------------------------------------------------- data
  async function loadDefs() {
    const r = await fetch(EMBED ? '/api/maps?wall=1' : '/api/maps', { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    DATA = await r.json();
  }
  async function refreshStatus() {
    try {
      const r = await fetch(EMBED ? '/api/maps?defs=0&wall=1' : '/api/maps?defs=0', { cache: 'no-store' });
      if (!r.ok) return;
      const d = await r.json();
      DATA.status = d.status; DATA.generatedAt = d.generatedAt;
      paintStatus();
      if (selected) patchPanelStatus();
      if (q('.map-table-wrap')?.open) renderTable();
    } catch { /* the header's live dot shows connection trouble */ }
  }
  const statusOf = (id) => DATA?.status?.[map.id]?.[id] || null;

  // ---------------------------------------------------------------- geometry
  const edgeKey = (e) => `${e.from}>${e.to}`;
  const laneLabel = (n) => map.lanes?.find((l) => l.id === n.lane)?.label;
  function sizeNodes() {
    const count = {};
    map.nodes.forEach((n) => { count[n.label] = (count[n.label] || 0) + 1; });
    nodes = new Map(map.nodes.map((n) => [n.id, { ...n, w: n.w || 170, h: NODE_H, full: count[n.label] > 1 ? `${n.label} (${laneLabel(n) || n.sub})` : n.label }]));
    if (map.bus) nodes.set(map.bus.id, { ...map.bus, bus: true, x: (map.bus.x1 + map.bus.x2) / 2, w: map.bus.x2 - map.bus.x1, h: 34, full: map.bus.label });
    edgeByKey = new Map(map.edges.map((e) => [edgeKey(e), e]));
  }
  const typeOf = (e) => map.edgeTypes[e.type] || { slot: 0, dash: '' };
  const isHard = (e) => !e.both && (e.hard ?? ['model', 'data', 'web'].includes(e.type));

  function anchor(n, side) {
    if (side === 'top') return [n.x, n.y - n.h / 2];
    if (side === 'bottom') return [n.x, n.y + n.h / 2];
    if (side === 'left') return [n.x - n.w / 2, n.y];
    return [n.x + n.w / 2, n.y];
  }
  function roundedPolyline(pts, r = 12) {
    let d = `M${pts[0][0]},${pts[0][1]}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
      const l1 = Math.hypot(x1 - x0, y1 - y0) || 1, l2 = Math.hypot(x2 - x1, y2 - y1) || 1;
      const rr = Math.min(r, l1 / 2, l2 / 2);
      d += ` L${x1 - ((x1 - x0) / l1) * rr},${y1 - ((y1 - y0) / l1) * rr} Q${x1},${y1} ${x1 + ((x2 - x1) / l2) * rr},${y1 + ((y2 - y1) / l2) * rr}`;
    }
    const last = pts[pts.length - 1];
    return d + ` L${last[0]},${last[1]}`;
  }
  const inBox = (x, y, n, pad = 5) => x > n.x - n.w / 2 - pad && x < n.x + n.w / 2 + pad && y > n.y - n.h / 2 - pad && y < n.y + n.h / 2 + pad;
  // how many boxes an axis-aligned polyline runs through (its own ends excluded)
  function hits(pts, skip) {
    let c = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
      for (const n of nodes.values()) {
        if (n.bus || skip.includes(n.id)) continue;
        const L = n.x - n.w / 2 - 5, R = n.x + n.w / 2 + 5, T = n.y - n.h / 2 - 5, B = n.y + n.h / 2 + 5;
        if (Math.abs(x0 - x1) < 0.5) { if (x0 > L && x0 < R && Math.max(y0, y1) > T && Math.min(y0, y1) < B) c++; }
        else if (y0 > T && y0 < B && Math.max(x0, x1) > L && Math.min(x0, x1) < R) c++;
      }
    }
    return c;
  }
  const plen = (pts) => pts.slice(1).reduce((s, p, i) => s + Math.abs(p[0] - pts[i][0]) + Math.abs(p[1] - pts[i][1]), 0);
  function pick(cands, skip) {
    let best = cands[0], bestScore = Infinity;
    for (const pts of cands) {
      const s = hits(pts, skip) * 1000 + plen(pts) / 10 + (pts.length - 2) * 6;
      if (s < bestScore) { bestScore = s; best = pts; }
    }
    return best;
  }

  function curve(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    if (Math.abs(dx) >= Math.abs(dy) * 0.9 && Math.abs(dx) > (a.w + b.w) / 2) {
      const s = anchor(a, dx > 0 ? 'right' : 'left'), t = anchor(b, dx > 0 ? 'left' : 'right');
      const c = Math.max(40, Math.abs(t[0] - s[0]) * 0.45) * Math.sign(dx);
      return [s, [s[0] + c, s[1]], [t[0] - c, t[1]], t];
    }
    const s = anchor(a, dy > 0 ? 'bottom' : 'top'), t = anchor(b, dy > 0 ? 'top' : 'bottom');
    const c = Math.max(26, Math.abs(t[1] - s[1]) * 0.45) * Math.sign(dy || 1);
    return [s, [s[0], s[1] + c], [t[0], t[1] - c], t];
  }
  function curveClear([p0, p1, p2, p3], skip) {
    for (let i = 1; i < 30; i++) {
      const t = i / 30, u = 1 - t;
      const x = u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0];
      const y = u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1];
      for (const n of nodes.values()) if (!n.bus && !skip.includes(n.id) && inBox(x, y, n, 3)) return false;
    }
    return true;
  }
  const curveD = ([s, c1, c2, t]) => `M${s[0]},${s[1]} C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${t[0]},${t[1]}`;

  // Network / data: keep the curve when nothing is in the way, otherwise detour at right angles
  function smartPath(a, b, idx) {
    const c = curve(a, b);
    const skip = [a.id, b.id];
    if (curveClear(c, skip)) return curveD(c);
    const o = (((idx * 5) % 7) - 3) * 3;
    const xs = new Set(map.risers || []), ys = new Set();
    for (const n of nodes.values()) {
      if (n.bus) continue;
      xs.add(n.x - n.w / 2 - 16); xs.add(n.x + n.w / 2 + 16);
      ys.add(n.y - n.h / 2 - 14); ys.add(n.y + n.h / 2 + 14);
    }
    for (const z of map.zones || []) { xs.add(z.x + 10); xs.add(z.x + z.w - 10); ys.add(z.y + 34); ys.add(z.y + z.h - 10); }
    const dx = b.x - a.x, dy = b.y - a.y;
    const sa = dx >= 0 ? 'right' : 'left', sb = dx >= 0 ? 'left' : 'right';
    const ta = dy >= 0 ? 'bottom' : 'top', tb = dy >= 0 ? 'top' : 'bottom';
    const cands = [];
    for (const mx of xs) {
      cands.push([anchor(a, sa), [mx + o, a.y], [mx + o, b.y], anchor(b, sb)]);
      cands.push([anchor(a, mx > a.x ? 'right' : 'left'), [mx + o, a.y], [mx + o, b.y], anchor(b, mx > b.x ? 'right' : 'left')]);
    }
    for (const my of ys) cands.push([anchor(a, ta), [a.x, my + o], [b.x, my + o], anchor(b, tb)]);
    cands.push([anchor(a, sa), [b.x, a.y], anchor(b, tb)]);
    cands.push([anchor(a, ta), [a.x, b.y], anchor(b, sb)]);
    return roundedPolyline(pick(cands, skip));
  }

  // Services: route like circuit traces through the gaps between columns
  function orthoPath(a, b, idx) {
    const xs = [...new Set((map.columns || []).map((c) => c.x))].sort((p, q2) => p - q2);
    const gut = [];
    for (let i = 0; i < xs.length - 1; i++) gut.push((xs[i] + xs[i + 1]) / 2);
    gut.unshift(xs[0] - 125); gut.push(xs[xs.length - 1] + 120);
    const rightOf = (x) => gut.find((g) => g > x + 1) ?? gut[gut.length - 1];
    const leftOf = (x) => [...gut].reverse().find((g) => g < x - 1) ?? gut[0];
    const o = (((idx * 5) % 9) - 4) * 3.4; // spread parallel runs so each trace stays traceable
    const skip = [a.id, b.id];
    const cands = [];
    const dx = b.x - a.x, dy = b.y - a.y;
    if (Math.abs(dx) < 10) {
      for (const side of ['right', 'left']) {
        const g = (side === 'right' ? rightOf(a.x) : leftOf(a.x)) + o;
        cands.push([anchor(a, side), [g, a.y], [g, b.y], anchor(b, side)]);
      }
    } else {
      const sa = dx > 0 ? 'right' : 'left', sb = dx > 0 ? 'left' : 'right';
      const nearA = (dx > 0 ? rightOf(a.x) : leftOf(a.x)) + o, nearB = (dx > 0 ? leftOf(b.x) : rightOf(b.x)) + o;
      if (Math.abs(dy) < 8) cands.push([anchor(a, sa), anchor(b, sb)]);
      cands.push([anchor(a, sa), [nearA, a.y], [nearA, b.y], anchor(b, sb)]);
      cands.push([anchor(a, sa), [nearB, a.y], [nearB, b.y], anchor(b, sb)]);
      for (const gy of [b.y - 32 * Math.sign(dy || 1), a.y + 32 * Math.sign(dy || 1), a.y - 32, a.y + 32]) {
        cands.push([anchor(a, sa), [nearA, a.y], [nearA, gy + o / 3], [nearB, gy + o / 3], [nearB, b.y], anchor(b, sb)]);
      }
    }
    let best = pick(cands, skip);
    if (hits(best, skip)) {
      // still clipping a box: try every column gap with every row gap
      const rows = [...new Set([...nodes.values()].filter((n) => !n.bus).flatMap((n) => [n.y - 32, n.y + 32]))];
      const more = [];
      const sides = Math.abs(dx) < 10 ? [['right', 'right'], ['left', 'left']] : [[dx > 0 ? 'right' : 'left', dx > 0 ? 'left' : 'right']];
      for (const [sa, sb] of sides) for (const g1 of gut) for (const g2 of gut) {
        if ((sa === 'right') !== (g1 > a.x) || (sb === 'left') !== (g2 < b.x)) continue;
        more.push([anchor(a, sa), [g1 + o, a.y], [g1 + o, b.y], anchor(b, sb)]);
        for (const gy of rows) more.push([anchor(a, sa), [g1 + o, a.y], [g1 + o, gy + o / 3], [g2 + o, gy + o / 3], [g2 + o, b.y], anchor(b, sb)]);
      }
      // leave or enter through the top/bottom when the row beside the box is full
      for (const gy of rows) {
        const ta = gy > a.y ? 'bottom' : 'top', tb = gy > b.y ? 'bottom' : 'top';
        const yy = gy + o / 3;
        more.push([anchor(a, ta), [a.x, yy], [b.x, yy], anchor(b, tb)]);
        for (const g of gut) {
          more.push([anchor(a, ta), [a.x, yy], [g + o, yy], [g + o, b.y], anchor(b, g < b.x ? 'left' : 'right')]);
          more.push([anchor(a, g > a.x ? 'right' : 'left'), [g + o, a.y], [g + o, yy], [b.x, yy], anchor(b, tb)]);
          for (const gy2 of rows) {
            const tb2 = gy2 > b.y ? 'bottom' : 'top';
            more.push([anchor(a, ta), [a.x, yy], [g + o, yy], [g + o, gy2 + o / 3], [b.x, gy2 + o / 3], anchor(b, tb2)]);
          }
        }
      }
      best = pick([best, ...more], skip);
    }
    return roundedPolyline(best, 10);
  }

  function viaPath(a, b, via) {
    const side = (n, p) => (Math.abs(p[0] - n.x) > Math.abs(p[1] - n.y) ? (p[0] > n.x ? 'right' : 'left') : (p[1] > n.y ? 'bottom' : 'top'));
    const first = via[0], last = via[via.length - 1];
    const s = anchor(a, side(a, first)), t = anchor(b, side(b, last));
    const pts = [s];
    // keep the first and last legs straight
    if (s[0] !== first[0] && s[1] !== first[1]) pts.push(Math.abs(first[0] - s[0]) > Math.abs(first[1] - s[1]) ? [first[0], s[1]] : [s[0], first[1]]);
    pts.push(...via);
    if (t[0] !== last[0] && t[1] !== last[1]) pts.push(Math.abs(last[0] - t[0]) > Math.abs(last[1] - t[1]) ? [t[0], last[1]] : [last[0], t[1]]);
    pts.push(t);
    return roundedPolyline(pts);
  }

  function edgePath(e, idx) {
    const a = nodes.get(e.from), b = nodes.get(e.to);
    if (e.via) return viaPath(a, b, e.via);
    if (b.bus || a.bus) {
      const n = b.bus ? a : b, bus = b.bus ? b : a;
      const below = n.y > bus.y, busEdge = bus.y + (below ? bus.h / 2 : -bus.h / 2);
      const straight = [anchor(n, below ? 'top' : 'bottom'), [n.x, busEdge]];
      if (!hits(straight, [n.id])) return `M${straight[0][0]},${straight[0][1]} L${n.x},${busEdge}`;
      const risers = [...(map.risers || [RISER, map.w - RISER])].sort((p, q2) => Math.abs(p - n.x) - Math.abs(q2 - n.x));
      for (const rx of risers) {
        const pts = [anchor(n, rx > n.x ? 'right' : 'left'), [rx, n.y], [rx, busEdge]];
        if (!hits(pts, [n.id])) return roundedPolyline(pts);
      }
      return roundedPolyline([anchor(n, risers[0] > n.x ? 'right' : 'left'), [risers[0], n.y], [risers[0], busEdge]]);
    }
    if (map.router === 'ortho') return orthoPath(a, b, idx);
    if (map.router === 'smart') return smartPath(a, b, idx);
    return curveD(curve(a, b));
  }

  // ---------------------------------------------------------------- render
  const slotVar = (slot) => (slot ? `var(--s${slot})` : 'var(--edge-neutral)');

  function render() {
    sizeNodes();
    const hide = hiddenTypes[map.id] ||= new Set(Object.entries(map.edgeTypes).filter(([, t]) => t.optional).map(([k]) => k));
    const parts = ['<defs>'];
    for (const [k, t] of Object.entries(map.edgeTypes)) {
      parts.push(`<marker id="arr-${k}" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1,1.5 L8.5,5 L1,8.5 z" style="fill:${slotVar(t.slot)}"/></marker>`);
    }
    parts.push('<marker id="arr-impact" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1,1.5 L8.5,5 L1,8.5 z" style="fill:var(--impact)"/></marker>');
    parts.push('<pattern id="map-dots" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" class="dot-grid"/></pattern></defs>');
    parts.push(`<rect class="map-bg" x="-4000" y="-4000" width="${map.w + 8000}" height="${map.h + 8000}" fill="url(#map-dots)"/>`);
    for (const l of map.lanes || []) {
      parts.push(`<g class="lane"><rect x="20" y="${l.y}" width="${map.w - 40}" height="${l.h}" rx="12"/>
        <text class="lane-label" transform="translate(40 ${l.y + l.h / 2}) rotate(-90)" text-anchor="middle">${esc(l.label)}</text></g>`);
    }
    for (const c of map.columns || []) parts.push(`<text class="col-label" x="${c.x}" y="${map.lanes ? 34 : 40}" text-anchor="middle">${esc(c.label)}</text>`);
    for (const z of map.zones || []) {
      parts.push(`<g class="zone${z.inner ? ' inner' : ''}"><rect x="${z.x}" y="${z.y}" width="${z.w}" height="${z.h}" rx="${z.inner ? 10 : 14}"/>
        <text class="zone-label" x="${z.x + 16}" y="${z.y + 22}">${esc(z.label)}${z.sub ? `<tspan class="zone-sub" dx="10">${esc(z.sub)}</tspan>` : ''}</text></g>`);
    }
    parts.push('<g class="edges">');
    map.edges.forEach((e, i) => {
      const t = typeOf(e);
      const d = edgePath(e, i);
      const toBus = nodes.get(e.to)?.bus || nodes.get(e.from)?.bus;
      const arrow = toBus ? '' : `marker-end="url(#arr-${e.type})"${e.both ? ` marker-start="url(#arr-${e.type})"` : ''}`;
      parts.push(`<g class="medge${hide.has(e.type) ? ' hidden' : ''}" data-edge="${esc(edgeKey(e))}" data-type="${esc(e.type)}" style="--ec:${slotVar(t.slot)}">
        <path class="me-hit" d="${d}"/>
        <path class="me-line" id="mp-${map.id}-${i}" d="${d}" ${t.dash ? `stroke-dasharray="${t.dash}"` : ''} ${arrow}/>
        <g class="me-pkts"></g></g>`);
    });
    parts.push('</g>');
    if (map.bus) {
      const b = nodes.get(map.bus.id);
      parts.push(`<g class="mnode bus" data-node="${esc(b.id)}" tabindex="0" role="button" aria-label="${esc(b.label)}">
        <rect class="bus-bar" x="${map.bus.x1}" y="${b.y - b.h / 2}" width="${b.w}" height="${b.h}" rx="${b.h / 2}"/>
        <line class="bus-flow" x1="${map.bus.x1 + 18}" x2="${map.bus.x2 - 18}" y1="${b.y + b.h / 2 - 5}" y2="${b.y + b.h / 2 - 5}"/>
        <text class="bus-label" x="${map.bus.x1 + 22}" y="${b.y + 4.5}">${esc(b.label)}<tspan class="bus-sub" dx="12">${esc(b.sub || '')}</tspan></text></g>`);
    }
    parts.push('<g class="nodes">');
    for (const n of nodes.values()) {
      if (n.bus) continue;
      const w = n.w, h = n.h, x = n.x - w / 2, y = n.y - h / 2;
      const label = fit(n.label, 13, 600, w - 66);
      const sub = fit(n.sub || '', 11, 400, w - 66);
      let off = 12;
      const badges = (n.badges || []).map((b) => {
        const bw = Math.ceil(textW(b, 10, 600)) + 14;
        off += bw + 4;
        return `<g class="mn-badge${b === 'core' ? ' core' : ''}" transform="translate(${w - off + 4} -9)"><rect width="${bw}" height="16" rx="8"/><text x="${bw / 2}" y="11.5" text-anchor="middle">${esc(b)}</text></g>`;
      }).join('');
      const risk = n.risk ? '<g class="mn-risk" transform="translate(12 -9)"><rect width="40" height="16" rx="8"/><text x="20" y="11.5" text-anchor="middle">Gap</text></g>' : '';
      parts.push(`<g class="mnode${n.faded ? ' faded' : ''}${n.risk ? ' has-risk' : ''}" data-node="${esc(n.id)}" data-status="none" transform="translate(${x} ${y})" tabindex="0" role="button" aria-label="${esc(`${n.full}${n.sub ? `, ${n.sub}` : ''}`)}">
        <rect class="mn-halo" x="-5" y="-5" width="${w + 10}" height="${h + 10}" rx="13"/>
        <rect class="mn-box" width="${w}" height="${h}" rx="9"/>
        <g class="mn-ico" transform="translate(13 ${h / 2 - 9}) scale(.75)"><path d="${ICONS[n.icon] || ICONS.box}"/></g>
        <text class="mn-label" x="40" y="${h / 2 - 3}">${esc(label)}</text>
        <text class="mn-sub" x="40" y="${h / 2 + 13}">${esc(sub)}</text>
        <g class="mn-st" transform="translate(${w - 22} ${h / 2 - 8})"></g>
        ${n.ts ? `<g class="mn-ts" transform="translate(${w - 4} ${h - 4})"><title>On the tailnet: ${esc(n.ts)}</title><circle r="4"/></g>` : ''}
        ${badges}${risk}</g>`);
    }
    parts.push('</g>');
    svg.innerHTML = `<g id="map-vp">${parts.join('')}</g>`;
    painted = false;
    applyView();
    addPackets();
    paintStatus();
    renderLegend();
    renderTable();
    applyHighlight();
  }

  let painted = false; // false on a map's first paint, so nothing flashes on load
  function paintStatus() {
    if (!map) return;
    const counts = { ok: 0, warn: 0, down: 0, off: 0, unknown: 0 };
    svg.querySelectorAll('.mnode[data-node]').forEach((g) => {
      const n = nodes.get(g.dataset.node); if (!n || n.bus) return;
      const s = statusOf(n.id);
      const st = s?.status || 'none';
      if (s) counts[st] = (counts[st] || 0) + 1;
      if (g.dataset.status === st) return;
      g.dataset.status = st;
      g.setAttribute('aria-label', `${n.full}${n.sub ? `, ${n.sub}` : ''}${s ? `, ${LABELS[st] || st}` : ', not monitored'}`);
      const holder = g.querySelector('.mn-st');
      if (holder) {
        const ring = st === 'warn' || st === 'down' ? `<circle class="st-ring status ${st}" cx="8" cy="8" r="7" style="animation-delay:-${(Math.random() * 2).toFixed(2)}s"/>` : '';
        holder.innerHTML = s ? `${ring}<svg width="16" height="16" viewBox="0 0 16 16" class="status ${esc(st)}">${(STATUS_ICONS[st] || STATUS_ICONS.unknown).replace(/^<svg[^>]*>|<\/svg>$/g, '')}</svg>` : '';
      }
      if (painted) { g.classList.remove('changed'); void g.getBBox(); g.classList.add('changed'); setTimeout(() => g.classList.remove('changed'), 1600); }
    });
    const parts = [];
    if (counts.down) parts.push(`<span class="status down">${STATUS_ICONS.down}<span class="lbl">${counts.down} down</span></span>`);
    if (counts.warn) parts.push(`<span class="status warn">${STATUS_ICONS.warn}<span class="lbl">${counts.warn} need attention</span></span>`);
    parts.push(`<span class="status ok">${STATUS_ICONS.ok}<span class="lbl">${counts.ok} OK</span></span>`);
    if (counts.off) parts.push(`<span class="status off">${STATUS_ICONS.off}<span class="lbl">${counts.off} off</span></span>`);
    q('#map-summary').innerHTML = parts.join('');
    q('#hero-sub').innerHTML = `<span class="dot ${counts.down ? 'down' : counts.warn ? 'warn' : 'ok'}"></span><span>${esc(map.blurb)}</span>`;
    painted = true;
  }

  // ---------------------------------------------------------------- packets
  // Glowing dots ride each visible connection in the direction data flows
  // (both ways on two-way links). Long links carry more; busy kinds run faster.
  function addPackets() {
    if (reduceMotion) return;
    svg.querySelectorAll('.medge').forEach((g) => {
      const e = edgeByKey.get(g.dataset.edge); const line = g.querySelector('.me-line'); const holder = g.querySelector('.me-pkts');
      if (!e || !line || !holder) return;
      const t = typeOf(e);
      const len = line.getTotalLength();
      const light = e.type === 'tool' || e.type === 'message';
      const speed = t.flow ? 95 : light ? 50 : 60;
      const dur = Math.min(11, Math.max(1.6, len / speed));
      const count = light ? 1 : Math.max(t.flow ? 2 : 1, Math.round(len / (t.flow ? 240 : 400)));
      let html = '';
      for (let k = 0; k < count; k++) {
        const reverse = e.both && k % 2 === 1;
        const begin = -((dur * k) / count + Math.random() * dur * 0.25);
        html += `<circle class="pkt" r="2.4"><animateMotion dur="${dur.toFixed(2)}s" begin="${begin.toFixed(2)}s" repeatCount="indefinite" calcMode="linear"${reverse ? ' keyPoints="1;0" keyTimes="0;1"' : ''}><mpath href="#${line.id}"/></animateMotion></circle>`;
      }
      holder.innerHTML = html;
    });
    syncMotion();
  }
  function syncMotion() {
    svg.classList.toggle('still', !motion);
    motion && onScreen ? svg.unpauseAnimations?.() : svg.pauseAnimations?.();
  }
  function setMotion(on) {
    motion = on && !reduceMotion;
    store.set('maps.motion', motion ? 'on' : 'off');
    syncMotion();
    const b = q('#map-motion');
    b.setAttribute('aria-pressed', String(!motion));
    b.title = motion ? 'Pause all motion' : 'Play the moving packets';
    b.innerHTML = motion ? '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>' : '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5l12 7-12 7z" fill="currentColor"/></svg>';
  }
  new IntersectionObserver(([en]) => { onScreen = en.isIntersecting; syncMotion(); }).observe(canvas);

  // ---------------------------------------------------------------- legend + table
  function renderLegend() {
    const hide = hiddenTypes[map.id];
    const open = q('#map-legend').classList.contains('open');
    const note = { network: '<i class="ts-dot"></i>on the tailnet', data: '<i class="gap-dot"></i>Gap: worth fixing', services: '<b class="core-chip">core</b>everything depends on it' }[map.id] || '';
    q('#map-legend').innerHTML = `<button type="button" class="lg-toggle btn" aria-expanded="${open}">Legend</button>`
      + Object.entries(map.edgeTypes).map(([k, t]) => `<button type="button" class="lg-item${hide.has(k) ? ' off' : ''}" data-type="${esc(k)}" aria-pressed="${!hide.has(k)}" title="${hide.has(k) ? 'Show' : 'Hide'}: ${esc(t.label)}" style="--ec:${slotVar(t.slot)}">
      <svg width="26" height="10" aria-hidden="true"><line x1="1" y1="5" x2="25" y2="5" ${t.dash ? `stroke-dasharray="${t.dash}"` : ''}/></svg>${esc(t.label)}</button>`).join('')
      + (note ? `<span class="lg-note">${note}</span>` : '');
  }
  function renderTable() {
    const name = (id) => nodes.get(id)?.full || id;
    const rows = map.edges.map((e) => `<tr><td>${esc(name(e.from))}</td><td>${e.both ? '↔' : '→'}</td><td>${esc(name(e.to))}</td><td>${esc(map.edgeTypes[e.type]?.label || e.type)}${map.impact && !isHard(e) && !e.both ? ' · optional' : ''}</td><td>${esc(e.label || '')}</td></tr>`).join('');
    const nrows = map.nodes.map((n) => { const s = statusOf(n.id); return `<tr><td>${esc(nodes.get(n.id)?.full || n.label)}</td><td>${esc(n.sub || '')}</td><td>${s ? badge(s.status) : '<span class="muted">not monitored</span>'}</td></tr>`; }).join('');
    q('#map-table').innerHTML = `<div class="tbl-grid"><div><h3>Connections (${map.edges.length})</h3><div class="tbl-scroll"><table class="map-tbl"><thead><tr><th>From</th><th></th><th>To</th><th>Kind</th><th>Note</th></tr></thead><tbody>${rows}</tbody></table></div></div>
      <div><h3>Nodes (${map.nodes.length})</h3><div class="tbl-scroll"><table class="map-tbl"><thead><tr><th>Name</th><th>Detail</th><th>Status</th></tr></thead><tbody>${nrows}</tbody></table></div></div></div>`;
  }

  // ---------------------------------------------------------------- highlight / impact
  function neighbors(id) {
    const edges = map.edges.filter((e) => e.from === id || e.to === id);
    const ids = new Set([id]); edges.forEach((e) => { ids.add(e.from); ids.add(e.to); });
    return { ids, edges: new Set(edges.map(edgeKey)) };
  }
  // What breaks without `id`: follow hard links upward; soft (optional) users only lose a feature.
  function impactOf(id) {
    const hard = new Set(), hardEdges = new Set(), stack = [id];
    while (stack.length) {
      const cur = stack.pop();
      for (const e of map.edges) {
        if (e.to !== cur || !isHard(e) || nodes.get(e.from)?.bus) continue;
        hardEdges.add(edgeKey(e));
        if (!hard.has(e.from) && e.from !== id) { hard.add(e.from); stack.push(e.from); }
      }
    }
    const soft = new Set(), softEdges = new Set();
    for (const e of map.edges) {
      if (e.both || isHard(e) || nodes.get(e.from)?.bus) continue;
      if ((e.to === id || hard.has(e.to)) && !hard.has(e.from) && e.from !== id) { soft.add(e.from); softEdges.add(edgeKey(e)); }
    }
    return { hard, soft, hardEdges, softEdges };
  }
  function needs(id) {
    const out = new Set(), stack = [id];
    while (stack.length) {
      const cur = stack.pop();
      for (const e of map.edges) if (isHard(e) && e.from === cur && !out.has(e.to) && e.to !== id && !nodes.get(e.to)?.bus) { out.add(e.to); stack.push(e.to); }
    }
    return out;
  }

  function applyHighlight() {
    if (!map) return;
    const focus = hoverId || selected;
    const hide = hiddenTypes[map.id];
    const imp = impact && selected && map.impact ? impactOf(selected) : null;
    const hl = focus ? neighbors(focus) : { ids: new Set(), edges: new Set() };
    const matches = new Set();
    if (query) for (const n of nodes.values()) if (`${n.full} ${n.sub || ''} ${n.id}`.toLowerCase().includes(query)) matches.add(n.id);
    svg.classList.toggle('dimmed', !!focus || !!query || !!imp);
    svg.classList.toggle('impact-on', !!imp);
    svg.querySelectorAll('.mnode[data-node]').forEach((g) => {
      const id = g.dataset.node;
      const onPath = imp && (imp.hard.has(id) || imp.soft.has(id));
      g.classList.toggle('hl', hl.ids.has(id) || matches.has(id) || !!onPath);
      g.classList.toggle('sel', id === selected);
      g.classList.toggle('imp-hard', !!imp && imp.hard.has(id));
      g.classList.toggle('imp-soft', !!imp && imp.soft.has(id));
      g.classList.toggle('match', matches.has(id));
    });
    svg.querySelectorAll('.medge').forEach((g) => {
      const k = g.dataset.edge, e = edgeByKey.get(k);
      const lit = hl.edges.has(k) || (imp && (imp.hardEdges.has(k) || imp.softEdges.has(k)));
      g.classList.toggle('hidden', hide.has(g.dataset.type) && !lit); // optional kinds still show for the focused node
      g.classList.toggle('hl', !!lit);
      const hardImp = !!imp && imp.hardEdges.has(k);
      g.classList.toggle('imp-hard', hardImp);
      const line = g.querySelector('.me-line');
      if (line && line.hasAttribute('marker-end')) {
        line.setAttribute('marker-end', `url(#arr-${hardImp ? 'impact' : e.type})`);
        if (e.both) line.setAttribute('marker-start', `url(#arr-${hardImp ? 'impact' : e.type})`);
      }
    });
    const cnt = q('#map-search-count');
    cnt.textContent = query ? (matches.size ? `${matches.size} found` : 'No match') : '';
    cnt.classList.toggle('none', !!query && !matches.size);
  }

  // ---------------------------------------------------------------- side panel
  const statusBlock = (n) => {
    const s = statusOf(n.id);
    return s ? `${badge(s.status)}<div class="mp-details">${s.details.map((d) => `<div>${esc(d)}</div>`).join('')}${n.statusNote ? `<div class="muted">${esc(n.statusNote)}</div>` : ''}</div>` : '<span class="muted small">Not monitored by a check.</span>';
  };
  function patchPanelStatus() {
    const n = nodes.get(selected); const el = q('#mp-status');
    if (!n || !el) return;
    const html = statusBlock(n);
    if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
  }
  function renderPanel() {
    if (!map) return;
    if (!selected) {
      panel.innerHTML = `<div class="mp-empty"><h3>${esc(map.title)}</h3><p>${esc(map.blurb)}</p>
        <ul class="mp-tips"><li>Hover a box to light up its connections${map.edgeTypes.tool ? ' (tool calls appear on hover)' : ''}.</li><li>Click one for details and live status.</li><li>Drag or scroll to pan; pinch or <kbd>⌘</kbd>-scroll to zoom; <kbd>0</kbd> fits.</li>${map.impact ? '<li>Turn on <b>Impact</b>, then pick a service to see what breaks without it.</li>' : ''}<li><kbd>/</kbd> searches.</li></ul></div>`;
      return;
    }
    const n = nodes.get(selected); if (!n) { selected = null; renderPanel(); return; }
    const name = (id) => nodes.get(id)?.full || id;
    const out = map.edges.filter((e) => e.from === n.id), inc = map.edges.filter((e) => e.to === n.id);
    const conn = (list, other) => list.map((e) => {
      const t = map.edgeTypes[e.type] || {};
      return `<li><button type="button" class="mp-link" data-goto="${esc(other(e))}"><i class="sw" style="--ec:${slotVar(t.slot)}"></i><span class="nm">${esc(name(other(e)))}</span><span class="muted">${esc(e.label || t.label || '')}${map.impact && !isHard(e) && !e.both ? ' · optional' : ''}</span></button></li>`;
    }).join('');
    const chips = (ids, cls = '') => [...ids].map((x) => `<button type="button" class="chip ${cls}" data-goto="${esc(x)}">${esc(name(x))}</button>`).join('');
    let impactHtml = '';
    if (map.impact) {
      const imp = impactOf(n.id), need = needs(n.id);
      impactHtml = `<div class="mp-block"><h4>If ${esc(n.full)} goes down</h4>
        ${imp.hard.size ? `<p><b>${imp.hard.size}</b> stop${imp.hard.size === 1 ? 's' : ''} working:</p><p class="mp-chips">${chips(imp.hard, 'imp')}</p>` : '<p class="muted">Nothing else stops working.</p>'}
        ${imp.soft.size ? `<p>${imp.soft.size} lose${imp.soft.size === 1 ? 's' : ''} a feature:</p><p class="mp-chips">${chips(imp.soft)}</p>` : ''}
        ${need.size ? `<h4>It needs</h4><p class="mp-chips">${chips(need)}</p>` : ''}
        ${impact ? '' : '<p class="muted small">Turn on Impact to see this on the map.</p>'}</div>`;
    }
    panel.innerHTML = `<div class="mp-sheet-grip" aria-hidden="true"></div>
      <div class="mp-head"><div class="mp-ico"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[n.icon] || ICONS.pulse}"/></svg></div>
        <div><h3>${esc(n.full)}</h3><div class="muted small">${esc(n.sub || '')}</div></div>
        <button class="btn icon-btn" type="button" id="mp-close" aria-label="Close details"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></button></div>
      <div class="mp-status" id="mp-status">${statusBlock(n)}</div>
      ${n.risk ? `<div class="mp-risk">${STATUS_ICONS.warn}<div><b>Gap.</b> ${esc(n.risk)}</div></div>` : ''}
      ${(n.badges || []).length ? `<p class="mp-chips">${n.badges.map((b) => `<span class="chip accent">${esc(b)}</span>`).join('')}</p>` : ''}
      ${n.info?.length || n.ts ? `<dl class="mp-facts">${(n.info || []).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}${n.ts ? `<dt>Tailnet</dt><dd>${esc(n.ts)}</dd>` : ''}</dl>` : ''}
      ${impactHtml}
      ${out.length ? `<div class="mp-block"><h4>Talks to</h4><ul class="mp-conns">${conn(out, (e) => e.to)}</ul></div>` : ''}
      ${inc.length ? `<div class="mp-block"><h4>Used by</h4><ul class="mp-conns">${conn(inc, (e) => e.from)}</ul></div>` : ''}
      ${n.open ? `<a class="btn mp-open" href="${esc(n.open)}">Open in the dashboard</a>` : ''}`;
    q('#mp-status').dataset.html = statusBlock(n);
  }

  // ---------------------------------------------------------------- pan / zoom
  function applyView() {
    // CSS transform (not the SVG attribute) so camera moves can be animated with transitions
    const vp = q('#map-vp'); if (vp) vp.style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.k})`;
    canvas.dataset.zoom = view.k < 0.55 ? 'far' : 'near';
  }

  // ---------------------------------------------------------------- wall tour (?embed=1&tour=1)
  // On the /wall screen a whole map is too small to read from across the room, so the
  // camera starts on the full map, then glides to each region (zones / host rows) in turn.
  const TOUR = EMBED && new URLSearchParams(location.search).has('tour');
  let tourT = null, tourI = 0;
  function tourTargets() {
    if (map.lanes) return map.lanes.map((l, i) => ({ x: 20, y: i === 0 ? 0 : l.y - 8, w: map.w - 40, h: l.h + (i === 0 ? l.y : 16) }));
    if (map.zones) return map.zones.filter((z) => !z.inner).map((z) => ({ x: z.x - 10, y: z.y - 10, w: z.w + 20, h: z.h + 20 }));
    return [{ x: 0, y: 0, w: map.w, h: map.h / 2 + 40 }, { x: 0, y: map.h / 2 - 40, w: map.w, h: map.h / 2 + 40 }];
  }
  function focusRect(r) {
    const c = canvas.getBoundingClientRect(); if (!c.width) return;
    const legendH = (q('#map-legend')?.offsetHeight || 0) + 18, pad = 28, availH = c.height - legendH;
    const k = Math.min(1.35, (c.width - 2 * pad) / r.w, (availH - 2 * pad) / r.h);
    view.k = k; view.tx = c.width / 2 - (r.x + r.w / 2) * k; view.ty = availH / 2 - (r.y + r.h / 2) * k;
    applyView();
  }
  function tourStep() {
    if (!map) return;
    const ts = tourTargets();
    if (tourI === 0) fitView(); else focusRect(ts[tourI - 1]);
    const dwell = tourI === 0 ? 3500 : 4200;
    tourI = (tourI + 1) % (ts.length + 1);
    tourT = setTimeout(tourStep, dwell);
  }
  function startTour() { if (!TOUR) return; clearTimeout(tourT); tourI = 0; svg.classList.add('tour'); tourStep(); }
  addEventListener('message', (ev) => { if (ev.origin === location.origin && ev.data?.type === 'wall-show') startTour(); });
  function fitView(animate = false) {
    if (!map) return;
    const r = canvas.getBoundingClientRect();
    if (!r.width) return;
    const legendH = (q('#map-legend')?.offsetHeight || 0) + 18;
    const availH = r.height - legendH;
    if (map.fit === 'width' && r.width < map.w && !EMBED) {
      view.k = Math.max(0.42, (r.width / map.w) * 0.98);
      view.tx = (r.width - map.w * view.k) / 2; view.ty = 6;
    } else {
      view.k = Math.min(r.width / map.w, availH / map.h) * 0.98;
      view.tx = (r.width - map.w * view.k) / 2; view.ty = Math.max(4, (availH - map.h * view.k) / 2);
    }
    if (animate) { svg.classList.add('anim'); setTimeout(() => svg.classList.remove('anim'), 450); }
    applyView();
  }
  function zoomAt(cx, cy, factor) {
    const k = Math.min(3, Math.max(0.15, view.k * factor));
    const f = k / view.k;
    view.tx = cx - (cx - view.tx) * f; view.ty = cy - (cy - view.ty) * f; view.k = k;
    applyView();
  }
  function centerOn(id) {
    const n = nodes.get(id); if (!n) return;
    const r = canvas.getBoundingClientRect();
    const k = Math.max(view.k, Math.min(1.1, r.width / 700));
    view.k = k; view.tx = r.width / 2 - n.x * k; view.ty = r.height / 2.4 - n.y * k;
    svg.classList.add('anim'); applyView(); setTimeout(() => svg.classList.remove('anim'), 450);
  }

  // Wheel: pinch (ctrlKey) or ⌘/Ctrl-scroll zooms; plain scroll pans like a trackpad map.
  canvas.addEventListener('wheel', (ev) => {
    if (locked) return;
    ev.preventDefault();
    const r = canvas.getBoundingClientRect();
    if (ev.ctrlKey || ev.metaKey) zoomAt(ev.clientX - r.left, ev.clientY - r.top, Math.exp(-ev.deltaY * (ev.ctrlKey && !ev.metaKey ? 0.01 : 0.0025)));
    else { view.tx -= ev.deltaX; view.ty -= ev.deltaY; applyView(); }
  }, { passive: false });

  const pointers = new Map();
  let drag = null, moved = false, downAt = null;
  canvas.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 && ev.pointerType === 'mouse') return;
    downAt = [ev.clientX, ev.clientY]; moved = false;
    if (locked) return;
    pointers.set(ev.pointerId, [ev.clientX, ev.clientY]);
    if (pointers.size === 1) drag = { x: ev.clientX, y: ev.clientY, tx: view.tx, ty: view.ty };
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; drag = { pinch: Math.hypot(a[0] - b[0], a[1] - b[1]), k: view.k }; }
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (locked) { if (downAt && Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]) > 8) moved = true; return; }
    if (!pointers.has(ev.pointerId)) return;
    pointers.set(ev.pointerId, [ev.clientX, ev.clientY]);
    if (!drag) return;
    if (pointers.size === 2 && drag.pinch) {
      const [a, b] = [...pointers.values()];
      const r = canvas.getBoundingClientRect();
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      zoomAt((a[0] + b[0]) / 2 - r.left, (a[1] + b[1]) / 2 - r.top, (drag.k * d / drag.pinch) / view.k);
      moved = true; return;
    }
    const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
    if (!moved && Math.hypot(dx, dy) < 4) return;
    if (!moved) { moved = true; canvas.setPointerCapture?.(ev.pointerId); canvas.classList.add('grabbing'); hideTip(); }
    view.tx = drag.tx + dx; view.ty = drag.ty + dy; applyView();
  });
  const endPointer = (ev) => {
    pointers.delete(ev.pointerId);
    if (pointers.size === 0) { drag = null; canvas.classList.remove('grabbing'); }
    else if (pointers.size === 1) { const [p] = [...pointers.values()]; drag = { x: p[0], y: p[1], tx: view.tx, ty: view.ty }; }
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', (ev) => { endPointer(ev); moved = true; });

  function setLocked(on) {
    locked = on;
    canvas.classList.toggle('locked', locked);
    q('#map-done').hidden = locked || !(coarse && innerWidth < 760);
  }

  // ---------------------------------------------------------------- hover / click
  function placeTip(ev) {
    tip.hidden = false;
    tip.style.left = `${Math.max(8, Math.min(innerWidth - tip.offsetWidth - 8, ev.clientX + 14))}px`;
    tip.style.top = `${Math.min(innerHeight - tip.offsetHeight - 8, ev.clientY + 14)}px`;
  }
  function hideTip() { tip.hidden = true; }
  svg.addEventListener('pointerover', (ev) => {
    if (coarse || (drag && moved)) return;
    const g = ev.target.closest('.mnode');
    if (g && hoverId !== g.dataset.node) { hoverId = g.dataset.node; applyHighlight(); }
  });
  svg.addEventListener('pointermove', (ev) => {
    if (coarse || (drag && moved)) return;
    const g = ev.target.closest('.mnode');
    if (g) {
      const n = nodes.get(g.dataset.node), s = n && statusOf(n.id);
      if (!n) return;
      tip.innerHTML = `<b>${esc(n.full)}</b>${s ? ` · ${esc(LABELS[s.status] || s.status)}` : ''}${n.sub ? `<div class="t">${esc(n.sub)}</div>` : ''}${s?.details?.[0] ? `<div class="t">${esc(s.details[0])}</div>` : ''}`;
      placeTip(ev); return;
    }
    const eg = ev.target.closest('.medge');
    const e = eg && edgeByKey.get(eg.dataset.edge);
    if (e) {
      tip.innerHTML = `<b>${esc(nodes.get(e.from)?.full)} ${e.both ? '↔' : '→'} ${esc(nodes.get(e.to)?.full)}</b><div class="t">${esc(map.edgeTypes[e.type]?.label || '')}${e.label ? ` · ${esc(e.label)}` : ''}</div>`;
      placeTip(ev); return;
    }
    hideTip();
  });
  svg.addEventListener('pointerout', (ev) => {
    const g = ev.target.closest('.mnode');
    if (g && !g.contains(ev.relatedTarget)) { hoverId = null; applyHighlight(); }
    if (!ev.relatedTarget || !svg.contains(ev.relatedTarget) || !ev.relatedTarget.closest?.('.mnode, .medge')) hideTip();
  });
  canvas.addEventListener('click', (ev) => {
    if (moved) return;
    if (ev.target.closest('.map-zoom, .map-legend')) return;
    const g = ev.target.closest('.mnode');
    if (locked) { setLocked(false); if (g) select(g.dataset.node); return; }
    select(g ? g.dataset.node : null);
  });
  svg.addEventListener('keydown', (ev) => {
    const g = ev.target.closest('.mnode');
    if (g && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); select(g.dataset.node); }
  });
  svg.addEventListener('focusin', (ev) => { const g = ev.target.closest('.mnode'); if (g) { hoverId = g.dataset.node; applyHighlight(); } });
  svg.addEventListener('focusout', () => { hoverId = null; applyHighlight(); });
  panel.addEventListener('click', (ev) => {
    const go = ev.target.closest('[data-goto]');
    if (go) { select(go.dataset.goto); centerOn(go.dataset.goto); return; }
    if (ev.target.closest('#mp-close')) select(null);
  });

  function select(id) {
    selected = id && nodes.has(id) ? id : null;
    const h = `#${map.id}${selected ? `/${selected}` : ''}`;
    if (location.hash !== h) history.replaceState(null, '', h);
    applyHighlight(); renderPanel();
    wrap.classList.toggle('has-sel', !!selected);
    if (selected) { const s = statusOf(selected); live.textContent = `${nodes.get(selected).full}${s ? `: ${LABELS[s.status] || s.status}` : ''}`; }
  }

  // ---------------------------------------------------------------- toolbar
  const sizeKey = () => { const r = canvas.getBoundingClientRect(); return `${Math.round(r.width)}x${Math.round(r.height)}`; };
  let lastSize = '', resizeT = null;
  function switchMap(id, sel = null, push = false) {
    map = DATA.maps.find((m) => m.id === id) || DATA.maps[0];
    selected = null; hoverId = null; query = '';
    q('#map-search').value = '';
    document.querySelectorAll('#map-tabs .seg').forEach((b) => { const on = b.dataset.map === map.id; b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); });
    if (typeof moveThumb === 'function') moveThumb(q('#map-tabs'));
    const ib = q('#map-impact'); ib.hidden = !map.impact;
    impact = false; ib.classList.remove('on'); ib.setAttribute('aria-pressed', 'false');
    q('#hero-title').textContent = 'Maps';
    if (push) history.pushState(null, '', `#${map.id}`);
    render(); fitView(); select(sel);
    if (sel) centerOn(sel);
    lastSize = sizeKey();
  }
  q('#map-tabs').addEventListener('click', (ev) => { const b = ev.target.closest('[data-map]'); if (b && b.dataset.map !== map?.id) switchMap(b.dataset.map, null, true); });
  q('#map-impact').addEventListener('click', (ev) => {
    impact = !impact; ev.currentTarget.classList.toggle('on', impact); ev.currentTarget.setAttribute('aria-pressed', String(impact));
    live.textContent = impact ? 'Impact on: pick a service to see what breaks without it' : 'Impact off';
    applyHighlight(); renderPanel();
  });
  q('#map-legend').addEventListener('click', (ev) => {
    const t = ev.target.closest('.lg-toggle');
    if (t) { const lg = q('#map-legend'); lg.classList.toggle('open'); t.setAttribute('aria-expanded', String(lg.classList.contains('open'))); return; }
    const b = ev.target.closest('[data-type]'); if (!b) return;
    const set = hiddenTypes[map.id];
    set.has(b.dataset.type) ? set.delete(b.dataset.type) : set.add(b.dataset.type);
    renderLegend(); applyHighlight();
  });
  q('#map-search').addEventListener('input', (ev) => { query = ev.target.value.trim().toLowerCase(); applyHighlight(); });
  q('#map-search').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && query) {
      const hit = [...nodes.values()].find((n) => `${n.full} ${n.sub || ''} ${n.id}`.toLowerCase().includes(query));
      if (hit) { if (locked) setLocked(false); select(hit.id); centerOn(hit.id); }
    }
    if (ev.key === 'Escape') { ev.target.value = ''; query = ''; applyHighlight(); ev.target.blur(); }
  });
  const zoomCenter = (f) => { const r = canvas.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, f); };
  q('#map-zoom-in').addEventListener('click', () => zoomCenter(1.25));
  q('#map-zoom-out').addEventListener('click', () => zoomCenter(0.8));
  q('#map-fit').addEventListener('click', () => fitView(true));
  q('#map-motion').addEventListener('click', () => setMotion(!motion));
  q('#map-done').addEventListener('click', (ev) => { ev.stopPropagation(); select(null); setLocked(true); });
  if (reduceMotion) q('#map-motion').hidden = true;
  addEventListener('keydown', (ev) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return; // leave browser zoom and shortcuts alone
    if (ev.target.closest?.('input, textarea, select')) return;
    if (ev.key === 'Escape' && selected) select(null);
    else if (ev.key === '0') fitView(true);
    else if (ev.key === '+' || ev.key === '=') zoomCenter(1.25);
    else if (ev.key === '-') zoomCenter(0.8);
    else if (ev.key === '/') { ev.preventDefault(); q('#map-search').focus(); }
  });
  new ResizeObserver(() => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => { const k = sizeKey(); if (!map || k === lastSize) return; lastSize = k; if (!selected) fitView(); }, 120);
  }).observe(canvas);

  // ---------------------------------------------------------------- boot
  function fromHash() {
    const [id, sel] = location.hash.slice(1).split('/');
    if (id && id !== map?.id && DATA.maps.some((m) => m.id === id)) switchMap(id, sel || null);
    else if ((sel || null) !== selected) { select(sel || null); if (sel) centerOn(sel); }
  }
  (async () => {
    setLocked(locked);
    try {
      await loadDefs();
      q('#map-tabs').innerHTML = '<span class="seg-thumb" aria-hidden="true"></span>' + DATA.maps.map((m) => `<button class="seg" type="button" data-map="${esc(m.id)}" aria-pressed="false">${esc(m.title)}</button>`).join('');
      const [id, sel] = location.hash.slice(1).split('/');
      switchMap(DATA.maps.some((m) => m.id === id) ? id : 'network', sel || null);
      setMotion(motion);
      startTour();
      root.classList.add('ready');
      if (DATA.missing?.length) console.warn('maps: unresolved status bindings', DATA.missing);
    } catch (err) {
      panel.innerHTML = `<div class="banner bad">${STATUS_ICONS.down}<div><b>Couldn't load the maps.</b> ${esc(err.message)}</div></div>`;
      return;
    }
    setInterval(() => { if (!document.hidden) refreshStatus(); }, 15_000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshStatus(); });
    addEventListener('hashchange', fromHash);
    addEventListener('popstate', fromHash);
  })();
})();
