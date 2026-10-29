# WAVS Dashboard: tech stack

A self-hosted production dashboard. One computer at the venue (the **host**) runs a small Node.js
server that talks to the gear on the local network; every screen, laptop, tablet, TV and phone is
just a web browser pointed at it. There is no build step. Data is saved on that computer or, optionally,
in a cloud database (MongoDB Atlas).

```
 Gear on the venue network                Host computer (Node.js)                    Browsers
 ─────────────────────────                ───────────────────────                    ────────
 Shure SLX-D / ULX-D / QLX-D  ──TCP 2202──┐
 Blackmagic ATEM              ──UDP 9910──┤
 vMix                         ──HTTP──────┤   Express (HTTP + pages)                Dashboards, Green Room,
 ProPresenter 7               ──HTTP──────┼─▶ ws (live state, comms signalling) ◀─▶ Live service, Schedule,
 Planning Center (cloud)      ──HTTPS─────┤   Runtime per organization              Comms phones, TVs (kiosk)
 YouTube / Facebook (cloud)   ──HTTPS─────┘   JSON files on disk, or MongoDB
                                              cloudflared (optional, off-site access)
```

## Server

| Piece | What it's used for |
|---|---|
| **Node.js** (≥ 18; developed on 22), ES modules | The whole backend: `server/` |
| **Express 5** | HTTP routes (`/api/...`), pages, uploads, static files |
| **ws** 8 | WebSockets: live state to every screen (`/ws`), comms signalling and audio relay (`/comms-ws`) |
| **multer** | Photo and logo uploads |
| **mongodb** (driver 7) | Optional cloud database (MongoDB Atlas): `server/docs.js` |
| **yaml** | Reading the original `config.yaml` / demo config (settings are now saved as JSON per organization) |
| **selfsigned** | A self-signed HTTPS certificate (port 8443) so phones may use the microphone for comms on the local network |
| **qrcode** | QR codes for joining comms from a phone |
| **multicast-dns** | Answers for `http://<name>.local` (Bonjour/mDNS) |
| **atem-connection** (optional) | Blackmagic ATEM switchers |
| **cloudflared** (downloaded on demand) | "Use from anywhere": a Cloudflare quick tunnel or named tunnel on your own domain |
| Built-in `node:crypto` | Account passwords (scrypt), session tokens, encrypted backups (AES-256-GCM) |
| Built-in `node:test` | Tests: `npm test` |

### Gear and services it talks to

| Device / service | How | Driver |
|---|---|---|
| Shure SLX-D, ULX-D, QLX-D, Axient Digital | TCP command strings, port 2202 | `server/drivers/shure.js` |
| Blackmagic ATEM (incl. Constellation) | ATEM protocol over UDP via `atem-connection` | `server/drivers/switchers.js` |
| vMix | HTTP API (XML) | `server/drivers/switchers.js` |
| ProPresenter 7.9+ | HTTP REST API (playlists, slides, timers, video transport, stage messages) | `server/drivers/propresenter.js` |
| Planning Center Services | REST API with a personal access token | `server/drivers/planningcenter.js` |
| YouTube Live / Facebook Live | YouTube Data API v3 / Graph API (viewers, comments) | `server/streams.js` |
| Everything above, without hardware | Simulators for the demo and testing | `server/drivers/simulator.js` |

### Main server modules

| File | Role |
|---|---|
| `server/index.js` | Starts everything: HTTP/HTTPS/remote servers, routes, WebSockets, sign-in checks |
| `server/runtime.js` | Everything for the active organization: drivers, people, dashboards, service plan, schedule, comms, alerts |
| `server/hub.js` | Live device state, broadcast to screens |
| `server/service.js` | Order of service and where we are in it (Planning Center, ProPresenter playlist, typed plans) |
| `server/schedule.js` | Services planned ahead, events, repeating services, auto-switching, undo |
| `server/station.js` | Base stations: pairing and syncing a laptop with the website (StationHub on the website; StationLink, StationDocs, StationAuth on the laptop) |
| `server/docs.js` | Where everything is saved: the data folder or MongoDB (with a copy on this computer for when the internet drops), and moving between them |
| `server/store.js` | People, photos, face positions, mic assignments |
| `server/collab.js` | Dashboards (layouts) and shared notes/checklists |
| `server/comms.js` | Comms roster, channels, permissions, cues, signalling |
| `server/alerts.js` | Battery / RF / offline alerts (with snooze in `runtime.js`) |
| `server/auth.js` | Accounts, roles (crew / producer / admin), invites, sessions |
| `server/orgs.js` | Organizations (e.g. WAVS and the church) and their settings |
| `server/backup.js` | Export / import (`.wavsbackup`), for moving to another computer |
| `server/tunnel.js` | Off-site access through Cloudflare |
| `server/system.js` | Version, "Check for updates" (git + npm), restart |
| `server/localname.js` | `name.local` address |
| `scripts/service.mjs` | Runs it in the background: launchd (macOS), systemd (Linux), Startup script (Windows) |

## Browser side

Plain HTML, CSS and JavaScript (ES modules), served as-is. No framework, no bundler.

| Piece | What it's used for |
|---|---|
| Vanilla JS modules in `public/js/` | Every page; shared state and helpers in `common.js` |
| **GridStack** 12 | Drag-and-resize dashboard builder |
| **hls.js** | HLS video feeds |
| WebRTC (**WHEP**), MJPEG, capture devices (`getUserMedia`) | Other video feed types |
| **@vladmandic/face-api** (TensorFlow.js, SSD MobileNet) | Finds faces in photos, in the browser, so crops keep faces in frame; model files ship with the app |
| CSS (custom properties, grid, container queries) | Layout, theming per organization, widgets that scale with their size |

## Comms (intercom on phones)

| Piece | What it's used for |
|---|---|
| **WebRTC** (phone ⇄ engine), public STUN | Low-latency audio between phones and the comms engine |
| WebSocket audio relay (16 kHz μ-law) | Fallback when a phone can't connect directly (cellular, hotspot, strict Wi-Fi) |
| **Web Audio API** + **AudioWorklet** | The comms engine: a browser tab on the host computer that mixes every channel with a gain matrix |
| `AudioContext.setSinkId` (Chrome / Edge) | Audio out to an audio interface (to the sound board) |

## Data and storage

- Plain **JSON files** on disk, one folder per organization (settings, people, dashboards, service
  plan, schedule, comms), plus uploaded photos. No database server needed.
- Or **MongoDB** (Settings → This computer → Where everything is saved, or `MONGODB_URI`). Two
  collections: `docs` (each former JSON file as `{ _id: "orgs/<id>/greenroom.json", json }`) and
  `files` (photos and logos). Every store keeps its data in memory; writes are saved in the
  background in order and retried. Change streams bring in edits made by other computers. A copy
  in the data folder (`cloud-copy/`) lets it start and run without internet.
- `server/docs.js` is the one storage layer (`FileDocs` and `MongoDocs`, same interface); the
  stores (`store.js`, `schedule.js`, `comms.js`, `auth.js`, `orgs.js`, …) don't know which one they use.
- Location: `~/Library/Application Support/WAVS Dashboard` (macOS), `~/.wavs-dashboard` (Linux),
  `%APPDATA%\WAVS Dashboard` (Windows), or `WAVS_DATA`.
- Backups: gzip'd JSON, optionally encrypted with a password (AES-256-GCM, scrypt key).

## Running, updating and access

| | |
|---|---|
| Install | `git clone` + `npm install`, then `npm run service:install` (or the Mac / Windows installer scripts) |
| Run | Background service on the host computer; `npm start` / `npm run demo` for development |
| Update | Settings → This computer → Check for updates (git fast-forward + `npm install`, then restart) |
| Local access | `http://<name>.local` or the host's IP (port 8080; 80 when available); HTTPS on 8443 for phones' microphones |
| Off-site access | Cloudflare tunnel (quick link, or a named tunnel on your own domain); sign-in always required |
| TVs / signage | Any browser (Fire TV + AbleSign, smart TVs) with a TV link (`/tv/<org>/<dashboard>`) |

## The hosted website

Steps to a real website with accounts:
1. **Storage in MongoDB** (done): the setup can live in MongoDB Atlas instead of one computer's folder.
2. **The website** (done): the same server in website mode (`WAVS_HOSTED=1`) on an always-on Node
   host (Render Starter, $7/month; `render.yaml`, `Dockerfile`), on MongoDB. Anyone invited signs
   up with their own organization, every organization runs at once, and teams only see their own
   data. An always-on host keeps WebSockets (live updates, comms), so no paid realtime service or
   rewrite is needed, which a serverless host like Vercel would require. See
   [HOSTING.md](HOSTING.md).
3. **Base stations** (in progress): a laptop at an event runs the dashboard as before (gear,
   in-room screens, no internet needed) but linked to the website (`server/station.js`). It
   signs in with a website account and keeps the website's organizations in sync both ways over
   one outbound WebSocket (`/station-ws`), with a copy on the laptop for offline. Next: the
   website shows the base station's live state.

Gear can't be reached from the cloud, so a computer at the venue is always part of it.

## Testing

`npm test` runs the `node:test` suites in `test/`: accounts, backups, comms, data folder, organizations,
service plan, schedule, Shure parsing, people store, storage (files, and MongoDB when
`WAVS_TEST_MONGODB` is set), streams and updates. UI changes are checked in
headless Chromium (Playwright) against a demo server with simulated gear.
