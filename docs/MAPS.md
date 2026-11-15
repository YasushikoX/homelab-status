# Drawing your maps

`maps.mjs` exports `MAPS`, a list of maps. Each map is hand-laid-out on a fixed
canvas: you choose every box's position, and the renderer draws the links,
routes them around boxes, animates packets and colours everything live.
[`examples/maps.mjs`](../examples/maps.mjs) has three complete maps to copy from.

```js
export const MAPS = [network, services, data];   // shown as tabs, in this order
```

## A map

```js
const network = {
  id: 'network', title: 'Network',
  blurb: 'One sentence under the title.',
  w: 1500, h: 960,            // canvas size in map units (the view scales to fit)
  router: 'smart',            // how links are drawn, see below
  fit: 'width',               // optional: fill the width and scroll (for tall maps)
  impact: true,               // optional: the Impact button (what breaks without X)
  edgeTypes: { … },           // link kinds and their legend
  zones: [ … ],               // optional: labelled areas (sites, hosts)
  bus: { … },                 // optional: one long bar many things connect to (the tailnet)
  risers: [12, 1032, 1488],   // optional: x positions of free vertical lanes for links to the bus
  lanes: [ … ], columns: [ … ],   // optional: row and column labels (services map)
  nodes: [ … ],
  edges: [ … ],
};
```

### Routers

| `router` | Draws | Good for |
|---|---|---|
| *(none)* | Smooth curves | Small maps with columns (data & backups) |
| `smart` | Curves when the path is clear, right-angle detours around boxes otherwise | Network maps with zones |
| `ortho` | Circuit-board style: right angles through the gaps between columns | Big grids (services) |

Any edge can force its path with `via: [[x, y], …]` waypoints. Use them when the
automatic route crosses a box or a label.

## Nodes

```js
{ id: 'ct103', label: 'jellyfin', sub: 'CT 103 · media', icon: 'film',
  x: 320, y: 486,             // the CENTER, in map units
  w: 170,                     // optional width (default ~160); height is fixed
  bind: [{ guest: 103 }, { probe: 'jellyfin' }],   // live status, see below
  open: '/#pve',              // the "Open" link in the side panel (a machine drawer)
  info: [['Runs', 'Jellyfin 10.11'], ['Note', '…']],   // rows in the side panel
  badges: ['exit node'],      // small tags on the box; 'core' marks a critical service
  faded: true,                // dimmed (stopped on purpose, retired)
  risk: 'A gap worth fixing', // amber "Gap" tag + text in the panel (data map)
}
```

**Icons:** `server laptop desktop phone router globe cloud shield box vm disk
network chat code bot bolt gauge sync archive mail note brain parts calendar
search pulse pen hub chip spark key alert home film image lock`

### `bind`: where the colour comes from

| Bind | Status from |
|---|---|
| `{ machine: 'pve' }` | The machine's status and its CPU and memory |
| `{ probe: 'jellyfin' }` | A check in `PROBES` |
| `{ check: ['studio', 'Ollama'] }` | A check on a machine card (exact name as shown in the drawer) |
| `{ checkGroup: ['pve', 'Resources'] }` | The worst check in that group |
| `{ guest: 103 }` | A Proxmox guest (running, stopped, stopped on purpose) |
| `{ ts: 'phone' }` | A Tailscale device being online (offline = grey, not red) |
| `{ quota: 'claude' }` | AI quota for that provider (the worst account) |

An array means the worst of them. A node without `bind` stays neutral (for things
you can't check, like "the internet"). Find any bind that points at nothing:

```bash
curl -s 'localhost:3900/api/maps?defs=0' | jq .missing
```

## Edges

```js
{ from: 'router', to: 'pve', type: 'lan', label: 'LAN (vmbr0)' }
{ from: 'ct106', to: 'statusbk', type: 'monitor', both: true }   // arrows both ways
{ from: 'owui', to: 'ollamagpu', type: 'model', hard: false }    // soft dependency (Impact: "loses a feature")
{ from: 'ct102', to: 'pubdns', type: 'dns', via: [[615, 486], [615, 156], [1020, 156]] }
```

`from`/`to` can be a node id or the bus id. Packets flow from `from` to `to`.

### Edge types

```js
edgeTypes: {
  tailnet: { label: 'Tailscale', slot: 1, dash: '6 5', flow: true },
  dns:     { label: 'DNS', slot: 5, dash: '1 4' },
  monitor: { label: 'Dashboard failover', slot: 0, dash: '3 3', optional: true },
}
```

- **`slot`**: a colour from the categorical palette (0–7). It's tuned for both themes and kept separate from the status colours.
- **`dash`**: an SVG dash pattern. Give each type its own pattern, so the map still reads without colour.
- **`flow: true`**: animated packets.
- **`optional: true`**: hidden until switched on in the legend.

## Layout that reads well

- **Pick a grid and stick to it.** Rows about 80 units apart and columns 180 or more apart; the examples use exactly that. Boxes are about 34 units tall.
- **Group with zones.** One zone per site (Home, Cloud, …), with an `inner: true` zone per host inside. Leave about 30 units between zones, so links have room.
- **Leave gutters for links.** Keep the space between columns empty: the routers use it.
- **Put the bus on top.** A tailnet bar under the Internet row, with `risers` at free x positions, keeps the many tailnet links tidy.
- **Fewer, true nodes beat many.** Every box should be something you'd want to see turn red.
- **Check it at a glance.** Open `/maps`, press `0` to fit, hover each node and look for links crossing boxes. Add a `via` where one does.

Maps are reloaded on restart. The wall screen picks up changes automatically
(it reloads when the build changes).
