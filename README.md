# Casino Diko: Web

Player front-end for the live-dealer table games: **one Next.js app on one domain**.

| Path | Page |
|---|---|
| `/` | lobby (tables, results, road maps, bet history, settings) |
| `/baccarat/<table>` | baccarat table |
| `/dragon-tiger/<table>` | dragon-tiger table |
| `/poker/<table>` | poker (casino hold'em) table |

The game screens are the original browser games (CreateJS / jQuery / Vue 1 / Angular), served unchanged. Next.js renders the pages and runs the JSON API they call: bets, balances, settings, bet history, junket rooms. Data lives in the MongoDB shared with the game-server, and live game events come from the socket-server. Both are in the [casino-diko/backend](https://github.com/casino-diko/backend) repository.

## Requirements

- **Docker** 24+ with **Docker Compose** v2 to run the whole stack, **or**
- **Node.js 22** + npm 10 for local development (plus MongoDB 7 as a replica set and Redis 7, e.g. in Docker)
- **git**

## Installation

This repository is built and run by the backend's `docker-compose.yml`. Clone both repositories **next to each other**:

```sh
mkdir casino-diko && cd casino-diko
git clone git@github.com:casino-diko/backend.git
git clone git@github.com:casino-diko/web.git
```

## Run the whole stack (recommended)

```sh
cd backend
cp .env.example .env
# edit .env: SESSION_SECRET=<openssl rand -hex 32>, DEV_LOGIN=true
#            optional fake video: COMPOSE_PROFILES=dev and HLS_URL_TEMPLATE=http://localhost:8080/hls/{app}-{table}.m3u8
docker compose up -d --build
docker compose run --rm seed            # demo tables, dealers and players

cd game-server && npm install && npm run dealer   # simulated dealer playing rounds on every table
```

Open **http://localhost:3000/login/dev**, pick a demo player, then open a table from the lobby. Full details (ports, demo data, troubleshooting) are in the backend README.

After changing this repository, rebuild only the front-end: `cd ../backend && docker compose up -d --build web`.

## Develop locally

1. Start MongoDB, Redis, the game-server and the socket-server without Docker for the Node services, as described under "Develop locally" in the backend README. The front-end needs MongoDB on `localhost:27017` and the socket-server on `localhost:8000`.
2. Then:

```sh
cd web
cp .env.example .env          # defaults match the local backend setup
npm install
npm run dev                   # http://localhost:3000/login/dev (hot reload)
```

| Command | |
|---|---|
| `npm run dev` | development server on port 3000 |
| `npm run build` | production build (`.next/standalone`, used by the Dockerfile) |
| `npm run typecheck` | TypeScript check |
| `npm test` | unit tests (`test/*.test.ts`, no services needed) |
| `node --test --experimental-strip-types test/poker.test.ts` | one test file |
| `node scripts/check-<lobby\|baccarat\|dragon-tiger\|poker>.mjs` | end-to-end checks against running servers (see each script's header) |
| `npm run build:legacy` | rebuild the compiled game bundles (see below) |

For production use the Docker image (`Dockerfile`): it runs the standalone server with `public/`, `templates/` and `lang/`.

## Configuration

`.env` (local development; in Docker the backend's compose file sets these):

| Variable | Default | |
|---|---|---|
| `MONGO_URI` | `mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true` | MongoDB shared with the game-server (must be a replica set) |
| `MONGO_SHARED_DB` | `nihtan_api` | dealers, users, vendors, rooms |
| `BACCARAT_DB` / `DRAGONTIGER_DB` / `POKER_DB` | `baccarat` / `dragontiger` / `poker` | one database per game |
| `APP_SOCKET` | `http://localhost:8000` | socket-server url as seen from the browser |
| `SESSION_SECRET` | none, **required** (32+ characters) | signs the session cookie |
| `SESSION_SECURE` | `false` | `true` behind https |
| `DEV_LOGIN` | `false` | `true` enables `/login/dev` (pick any player). **Development only.** |
| `API_URL` | empty | vendor API for seamless wallets |
| `HLS_URL_TEMPLATE` | empty | live video url per table (see below) |

## How it is built

- **Pages are not React.** The former Blade views live in `templates/<app>/*.html`, rendered by a small Blade-compatible engine (`src/lib/template.ts`) from route handlers in `src/app/<app>/`. The API logic is in `src/server/<app>/controller.ts`.
- **One domain, four apps.** The game scripts request root-relative urls (`/img/...`, `/bet/store/...`). `src/middleware.ts` maps them to the app of the page that made the request (Referer). Each app's static files are in `public/<app>/`.
- **Bets** are stored in MongoDB in a transaction, guarded by round status and balance. Payouts are settled by the game-server.
- **Sign-in:** operators' players arrive through a signed `/launch` link, players created in the admin back-office sign in at `/login` with a password; see [Player sign-in](#player-sign-in).

## Player sign-in

Every way in ends in the same signed session cookie (`src/lib/session.ts`). The code is in `src/server/auth/controller.ts`.

| Route | Who | |
|---|---|---|
| `GET /launch` | an operator's players | signed link, below; the player is created on the first visit |
| `GET/POST /login` | players with a password | login id + password set in the admin back-office; 5 wrong passwords lock the account for 15 minutes (the admin can unlock) |
| `GET/POST /login/dev` | anyone, `DEV_LOGIN=true` only | pick any player |
| `GET/POST /logout` | | back to the operator's site (`lobby_url` of the launch), else `/login` |

### Launch links (for operators)

```
https://<player site>/launch?vendor=<vendor_name>&payload=<base64url JSON>&hash=<hex>

hash = HMAC-SHA256(payload, vendor secret), lower- or upper-case hex,
       computed over the payload string exactly as it appears in the url
```

| Payload field | | |
|---|---|---|
| `user_id` | required | the operator's player id, 1–64 of `A-Z a-z 0-9 _ . @ -`; unique per vendor |
| `ts` | required | unix seconds; a link is valid for 5 minutes either side |
| `nonce` | required | 16–64 of `A-Z a-z 0-9 _ -`, new for every link; a link works once |
| `user_name` | optional | display name, updated on every launch |
| `currency` | optional | used only when the player is created (else the vendor's) |
| `lang` | optional | `en`, `kr`, `jp`, `zh`, `th` |
| `game`, `table` | optional | `baccarat`, `dragon-tiger` or `poker` and a table number: straight to that table, else the lobby |
| `lobby_url` | optional | `http(s)` url where logout sends the player |

The vendor secret is generated on the admin back-office's **Vendors** page (64 hex characters; at least 32 are required). It also signs the seamless wallet calls, so a new secret must reach the operator at once. A refused link shows the player "This link has expired"; the reason (bad signature, expired, nonce reused, unknown vendor, …) is in the server log as `[launch] refused`.

Example in Node:

```js
import { createHmac, randomBytes } from 'node:crypto';

const payload = Buffer.from(JSON.stringify({
	user_id : 'p-1001', user_name : 'Kim', ts : Math.floor(Date.now() / 1000),
	nonce : randomBytes(16).toString('hex'), game : 'poker', table : 1, lobby_url : 'https://casino.example/'
})).toString('base64url');
const hash = createHmac('sha256', process.env.VENDOR_SECRET).update(payload).digest('hex');
const url = `https://games.example/launch?${new URLSearchParams({ vendor : 'my-casino', payload, hash })}`;
```

For testing: `LAUNCH_SECRET=<secret> npm run launch-link -- --vendor demo-transfer --user p-1001 --game poker --table 1` prints a fresh link.

Not built yet: rate limiting by IP (the lockout is per account), and account deletion (needed for the store apps, phase 3 of the phone app plan). Operators that embed the games in an iframe on their own domain will need the session cookie set to `SameSite=None; Secure`.

## Live video (HLS)

The dealer video plays over HLS in a `<video>` element (`public/shared/video/tg-video.js`, using the vendored hls.js). Safari and iOS play HLS natively. It replaced the Flash player and the JSMpeg socket stream.

Each table's stream URL, first match wins:

1. `game_tables.env_setting.hls`: `{ "hd": "https://…/index.m3u8", "sd": "…", "korea": "…" }` (`sd`, `korea` optional)
2. `HLS_URL_TEMPLATE`, e.g. `https://cdn.example.com/{app}/{table}/{quality}.m3u8`, with placeholders `{app}`, `{game}`, `{table}`, `{table2}` and `{quality}`
3. the legacy `web_stream` / `korea_stream` fields when they are http(s) URLs

The stream server must send `Access-Control-Allow-Origin` headers. Browsers block autoplay with sound, so the video may start muted and unmutes on the first click or tap.

Phones get the browser version of the mobile pages, which plays the video. The installed-app pages (`/m/...`) leave video to the native app.

## Legacy game bundles

`public/<app>/dist/*.js` and `public/lobby/css/app.css` are compiled from `legacy-src/<app>` and committed, so a normal build doesn't need the old toolchains. To change a game's browser code, edit `legacy-src/<app>`, then rebuild:

```sh
npm run build:legacy:baccarat     # or :dragon-tiger, :poker, :lobby, or build:legacy for all
```

The original toolchains are pinned in `legacy-build/` (the sources need Babel 5 / browserify), with their own `package.json` and lockfiles, so the builds are reproducible.
