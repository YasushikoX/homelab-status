# Notes for AI agents

**If the user wants Homelab Status set up for their home lab**, follow
[`docs/SETUP.md`](docs/SETUP.md) step by step. It is written for you: discovery
first (read-only), then a few questions, then config, then install (asking
before every change on a machine).

**If the user wants their dashboard changed** (a new machine, a new check, a
map tweak), edit their `config.mjs` / `maps.mjs` / `instance.json` next to
`server.mjs`. [`docs/CONFIG.md`](docs/CONFIG.md) and [`docs/MAPS.md`](docs/MAPS.md)
document every field. Validate with `node --check`, check that
`curl -s 'localhost:3900/api/maps?defs=0' | jq .missing` is empty, and restart the
service.

## Working on the code

- **Zero dependencies, no build step.** Node ≥ 22 standard library on the
  server, vanilla JS/CSS in `public/`, Python 3 standard library in `reporters/`.
  Don't add packages or a bundler.
- **Try it with the demo:** `node server.mjs --demo` (or `PORT=3999 …`). It uses
  `examples/` and `demo/demo.mjs`, contacts nothing and runs nothing.
  `DEMO_INCIDENTS=0` keeps everything green; `DEMO_FIRST_INCIDENT_MIN=0` breaks
  something right away.
- **Checks before you finish:** `npm run check` (syntax of every JS file +
  `py_compile` of the reporters), then run the demo and look at `/`, `/maps` and `/wall`.
- **Screenshots in the README** come from `node scripts/screenshots.mjs` (needs
  Chrome; Pillow for the animated one).
- **Never commit a user's setup.** `config.mjs`, `maps.mjs`, `instance.json`,
  `data/` and `local/` are git-ignored on purpose. Examples belong in `examples/` and must stay
  fictional (`example-tailnet.ts.net`, `100.64.0.x`, `192.168.1.x`, `@example.com`).
- **Security model:** the browser never sends commands, only action ids that
  `config.mjs` maps to fixed command templates. Anything taken from the
  inventory is checked against a strict pattern (`SAFE_NAME`). Owner checks rely on
  the `Tailscale-User-Login` header that `tailscale serve` adds. Keep all of that intact.
- **Style:** small functions, comments that explain *why*, plain words in the UI
  ("Down", "Stopped on purpose", "Needs attention"), status colours always paired
  with an icon.
