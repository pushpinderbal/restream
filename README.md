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

## How it works

Restream caches live channels, guide data, categories, and requested movie and series pages in SQLite under `/data`. It fetches movie and series pages as people browse; it does not download the full catalog at startup. Episode lists are shared after the first visit. Keep the `/data` volume to retain the cache across restarts.

Each viewer uses a separate upstream stream. `MAX_STREAMS` (default: `1`) limits simultaneous players, including paused players; when all slots are in use, the browser shows a warning. Set the limit within your provider's allowance.

Restream has no built-in client authentication. If you expose it beyond your LAN, put authentication in front of it and proxy the entire site, including `/api/streams/`. Run one container replica because playback slots and FFmpeg sessions are local to that container.

## License

MIT. See [LICENSE](LICENSE).
