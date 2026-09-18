# Ashfall — Warlock Arena

An original first-person arena game inspired by Warlock (Warcraft III). Aim and cast spells,
build up damage to increase knockback, and push rival mages off a shrinking rock arena into
lava. No original Warcraft assets are used: mages, staff and effects are procedural, the
ground is a CC0 Poly Haven texture, and fire/thunder are licensed field recordings.
Full attributions live in `public/assets/credits.json`.

Language: the game UI is Russian. This README is English.

## Modes

- **Practice (bots):** 5-round tournament against 3 bots with a gold shop between rounds
  (spell levels, blink/shield upgrades), tournament results, replay and menu return.
- **Online (2–4 players):** rooms joined by a 6-letter code. Host starts only when every
  player is ready; an 8-second countdown blocks combat and cancels on unready/disconnect.
  Online runs 5-round tournaments with a server-controlled shop. Disconnects keep the seat
  for 20 seconds: rejoin with the same profile to resume.
- **Profiles:** anonymous device profiles with an opaque recovery code (stored hashed,
  SHA-256, server-side). The code is shown once — copy it somewhere safe. Anyone holding
  the code owns the profile; losing it without a copy means losing the profile.
- **Weekly board:** Monday 00:00 UTC weeks, current top-20 plus previous-week top-3.
  Only completed eligible authenticated matches score (30+ seconds, no disconnects,
  one winner/opponent pair per UTC day, max 20 scored games per account per week).
  Winner +3 points, other participants +1. This is an unverified community board,
  not ranked matchmaking: recovery codes prove token possession, not identity.
- **Rewards:** previous-week top-3 may claim one permanent cosmetic skin
  (Ember / Void / Storm) plus a glowing name color that expires with the weekly honor.
  Cosmetic only — no damage, cooldown, movement or hitbox advantage.

## Controls

WASD move · mouse look · LMB fireball · 2 lightning · 3 homing · 4 meteor ·
Q blink · E shield · Space jump · Esc pause · Tab cycles spectated mage (when dead online).

CS2 sensitivity scale: turn angle = raw counts × sensitivity × 0.022°.
Use the same DPI and stock `m_yaw`/`m_pitch`. Raw input is requested with a fallback
when the browser does not support it.

## Requirements

Node.js >= 22.13 (uses `node:sqlite` and `node:test`).

## Run

```bash
npm ci
npm run dev      # client http://127.0.0.1:5173 + game server 127.0.0.1:3001, SQLite at data/
```

Production (the game server also serves the built client same-origin):

```bash
npm ci
npm run build
STATIC_DIR=dist HOST=0.0.0.0 PORT=3001 DATA_PATH=data/profiles.sqlite ORIGINS=https://play.example.com npm start
```

Open `http://<host>:3001/`. The API and WebSocket live on the same origin
(`/api/*`, `/ws`), so no extra proxy is needed in production.

| Variable    | Default                | Meaning                                                        |
| ----------- | ---------------------- | -------------------------------------------------------------- |
| `PORT`      | `3001`                 | Game server port                                               |
| `HOST`      | `127.0.0.1`            | Bind address (`0.0.0.0` for LAN/production)                    |
| `DATA_PATH` | `data/profiles.sqlite` | SQLite database file (keep out of Git, back it up regularly)   |
| `STATIC_DIR`| `dist` if present      | Directory of the built client to serve; unset disables static |
| `ORIGINS`   | _(same-origin only)_   | Comma-separated extra allowed origins for API/WebSocket        |

Graceful shutdown on SIGINT/SIGTERM closes sockets and the database.

## Checks

```bash
npm test          # 37 unit/integration tests (server + profile store)
npm run lint      # eslint
npm run build     # production bundle (three.js split into its own chunk)
npm run test:browser  # Playwright: menu/settings, practice tournament, online lobby+resume, audio
npm run check     # lint + build + unit + browser, all green required
```

Playwright downloads Chromium on first use (`npx playwright install chromium`).
Browser screenshots go to `artifacts/screenshots/` (gitignored).

## Layout

- `src/main.js` — renderer, game loop, practice logic, online state/spectator/nameplates
- `src/world.js`, `src/wizard.js` — arena and procedural mages (incl. premium skins)
- `src/multiplayer.js` — room lobby client (ready, countdown, shop, resume)
- `src/profile.js` — profiles, leaderboard, reward claim/equip UI
- `src/audio.js`, `src/settings.js` — recorded cues with limiter chain; CS2 mouse math
- `server.mjs` — authoritative rooms, physics, shop economy, settlement, static hosting
- `profile-store.mjs` — SQLite profiles, weekly board, anti-farm rules, rewards
- `static-server.mjs` — safe static file serving (no traversal, no directory listing)
- `tests/` — Playwright suites (`menu`, `practice`, `online`, `audio`)
- `*.test.mjs` — node:test suites next to the modules they cover

## Known limitations

- Community board: no Sybil/collusion resistance, no moderation or account deletion yet.
- No public matchmaking; online needs a shared server URL plus a room code.
- Balance and audio mastering were verified with automated tests and screenshots,
  not with external playtests or calibrated listening sessions.
