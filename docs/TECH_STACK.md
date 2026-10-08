# WAVS Dashboard: tech stack

A self-hosted production dashboard. One computer at the venue (the **host**) runs a small Node.js
server that talks to the gear on the local network; every screen, laptop, tablet, TV and phone is
just a web browser pointed at it. There is no build step and no cloud backend.

```
 Gear on the venue network                Host computer (Node.js)                    Browsers
 ─────────────────────────                ───────────────────────                    ────────
 Shure SLX-D / ULX-D / QLX-D  ──TCP 2202──┐
 Blackmagic ATEM              ──UDP 9910──┤
 vMix                         ──HTTP──────┤   Express (HTTP + pages)                Dashboards, Green Room,
 ProPresenter 7               ──HTTP──────┼─▶ ws (live state, comms signalling) ◀─▶ Live service, Schedule,
 Planning Center (cloud)      ──HTTPS─────┤   Runtime per organization              Comms phones, TVs (kiosk)
 YouTube / Facebook (cloud)   ──HTTPS─────┘   JSON files on disk
                                              cloudflared (optional, off-site access)
```

## Server

| Piece | What it's used for |
|---|---|
| **Node.js** (≥ 18; developed on 22), ES modules | The whole backend: `server/` |
| **Express 5** | HTTP routes (`/api/...`), pages, uploads, static files |
| **ws** 8 | WebSockets: live state to every screen (`/ws`), comms signalling and audio relay (`/comms-ws`) |
| **multer** | Photo and logo uploads |
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
  plan, schedule, comms), plus uploaded photos. No database server.
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

## Why not a cloud host (e.g. Vercel)?

The server has to sit on the venue network to reach the receivers, switcher and ProPresenter, keep
long-lived WebSocket connections open to every screen and phone, and save files to disk. Cloud
platforms built around short-lived serverless functions (Vercel, Netlify Functions) provide none of
those. For a public web address, use **Use from anywhere** with a named Cloudflare tunnel on your own
domain; the dashboard keeps running on the venue computer.

## Testing

`npm test` runs the `node:test` suites in `test/`: accounts, backups, comms, data folder, organizations,
service plan, schedule, Shure parsing, people store, streams and updates. UI changes are checked in
headless Chromium (Playwright) against a demo server with simulated gear.
