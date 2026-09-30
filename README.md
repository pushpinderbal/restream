# Restream

Restream is a browser player for one Stalker/MAG IPTV portal. Watch live TV, movies, and series from devices on your network without installing an IPTV app on each one.

```text
Browsers <-- HTTP(S) --> Restream <-- Stalker portal --> Provider
                           |
                           +-- SQLite cache in /data
                           +-- FFmpeg --> HLS playback
```

## Run with Docker Compose

```sh
git clone https://github.com/pushpinderbal/restream.git
cd restream
cp .env.example .env
```

Set `STALKER_PORTAL_URL` and `STALKER_MAC` in `.env` to your portal URL and registered MAC address, then run:

```sh
docker compose up -d
```

Compose pulls `ghcr.io/pushpinderbal/restream:latest`. Open `http://localhost:8080` or your server's LAN address. Keep `.env` private. See [.env.example](.env.example) for optional portal device identity and refresh settings.

Choose Live TV, Movies, or Series, browse or search, then open a title and press **Play**.

Open **Settings** to check library and programme guide sync states, last successful and upcoming refreshes, guide coverage, and stream usage. Use the refresh icon beside each sync state to start a background refresh without interrupting playback. The icon spins and its state changes to **Syncing** while the refresh runs. Library refresh updates live channels and categories; movie and series pages continue to refresh as you browse. Refreshes respect provider cooldowns. Intervals and playback limits are configured in `.env`.

To update the published app:

```sh
docker compose pull
docker compose up -d
```

## Develop with Docker Compose

Use the standalone `compose.dev.yaml` for local development. Configure `.env` as above, then run from the repository root:

```sh
docker compose -f compose.dev.yaml up --build --watch
```

Or use `mise run dev` if you have [mise](https://mise.jdx.dev/) installed. Development only requires Docker Compose 2.32 or newer; Go, Bun, and FFmpeg run inside the containers.

Open `http://localhost:5173` or your development machine's LAN address on port 5173. The frontend proxies API requests and video playback to the development backend over the Compose network.

- React and CSS edits hot reload from the mounted `web/` directory, without a container rebuild.
- Go source changes automatically rebuild and restart the backend through Compose Watch. Active playback stops when the backend restarts.
- Changes to `web/package.json` or `web/bun.lock` restart the frontend and reinstall dependencies.
- Development uses separate data and dependency volumes from the published app. The backend build skips the production UI bundle.

Stop development with Ctrl+C, or remove its containers while retaining cached data:

```sh
docker compose -f compose.dev.yaml down
```

The equivalent mise commands are `mise run dev:logs` and `mise run dev:down`. Plain `docker compose up -d` continues to run the published app on port 8080. Use the development file by itself, rather than combining it with `compose.yaml`.

To work on the UI using a locally installed Bun instead, keep a backend running on `localhost:8080` and run `mise run dev:ui`, or run `bun install --frozen-lockfile` followed by `bun run dev` from `web/`.

## How it works

Restream caches live channels, guide data, categories, and requested movie and series pages in SQLite under `/data`. It fetches movie and series pages as people browse; it does not download the full catalog at startup. Episode lists are shared after the first visit. Keep the `/data` volume to retain the cache across restarts.

Each viewer uses a separate upstream stream. `MAX_STREAMS` (default: `1`) limits simultaneous players, including paused players; when all slots are in use, the browser shows a warning. Set the limit within your provider's allowance.

Restream has no built-in client authentication. If you expose it beyond your LAN, put authentication in front of it and proxy the entire site, including `/api/streams/`. Run one container replica because playback slots and FFmpeg sessions are local to that container.

## License

MIT. See [LICENSE](LICENSE).
