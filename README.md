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

Open **http://localhost:3000/login**, pick a demo player, then open a table from the lobby. Full details (ports, demo data, troubleshooting) are in the backend README.

After changing this repository, rebuild only the front-end: `cd ../backend && docker compose up -d --build web`.

## Develop locally

1. Start MongoDB, Redis, the game-server and the socket-server without Docker for the Node services, as described under "Develop locally" in the backend README. The front-end needs MongoDB on `localhost:27017` and the socket-server on `localhost:8000`.
2. Then:

```sh
cd web
cp .env.example .env          # defaults match the local backend setup
npm install
npm run dev                   # http://localhost:3000/login (hot reload)
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
| `DEV_LOGIN` | `false` | `true` enables `/login` (pick any player). **Development only.** |
| `API_URL` | empty | vendor API for seamless wallets |
| `HLS_URL_TEMPLATE` | empty | live video url per table (see below) |

## How it is built

- **Pages are not React.** The former Blade views live in `templates/<app>/*.html`, rendered by a small Blade-compatible engine (`src/lib/template.ts`) from route handlers in `src/app/<app>/`. The API logic is in `src/server/<app>/controller.ts`.
- **One domain, four apps.** The game scripts request root-relative urls (`/img/...`, `/bet/store/...`). `src/middleware.ts` maps them to the app of the page that made the request (Referer). Each app's static files are in `public/<app>/`.
- **Bets** are stored in MongoDB in a transaction, guarded by round status and balance. Payouts are settled by the game-server.
- **Login:** only the development login exists (`DEV_LOGIN`). A vendor launch flow (signed redirect creating the session) still has to be built before going live.

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
