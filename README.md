# Restream

Restream is a web proxy for your Stalker/MAG IPTV provider. Multiple users can watch live TV, movies, and series from the same provider account in a web browser.

Each active player uses an upstream stream. Simultaneous viewing is limited by your provider's stream allocation and Restream's `MAX_STREAMS` setting. Paused players still count toward that limit.

You need your provider's portal URL and registered MAC address, plus any serial number or device IDs your provider requires.

## Run with Docker

Replace the example portal URL and MAC address with your provider's details:

```sh
docker run -d \
  --name restream \
  --restart unless-stopped \
  --stop-timeout 20 \
  -p 8080:8080 \
  -v restream-data:/data \
  -e STALKER_PORTAL_URL='http://your-provider.example' \
  -e STALKER_MAC='00:11:22:33:44:55' \
  -e MAX_STREAMS=1 \
  ghcr.io/pushpinderbal/restream:latest
```

## Or use Docker Compose

Save this as `compose.yaml` and enter your provider's details in `environment`:

```yaml
services:
  restream:
    image: ghcr.io/pushpinderbal/restream:latest
    ports:
      - "8080:8080"
    environment:
      STALKER_PORTAL_URL: "http://your-provider.example"
      STALKER_MAC: "00:11:22:33:44:55"
      STALKER_TIMEZONE: "UTC"
      MAX_STREAMS: "1"
    volumes:
      - restream-data:/data
    restart: unless-stopped
    stop_grace_period: 20s

volumes:
  restream-data:
```

Start it with:

```sh
docker compose up -d
```

Open `http://localhost:8080`, or `http://<server-address>:8080` from another device. Choose **Live TV**, **Movies**, or **Series**, open a title, and press **Play**. Use **Settings** to check or refresh the library and programme guide. Stop playback to release a stream for another viewer.

Restream has no sign-in screen. Keep access private or protect it with authentication before making it available outside your network.

## Environment variables

Pass these with Docker's `-e` option or add them to the Compose `environment` section. Defaults below are for the Docker image and apply when a setting is omitted or empty. Duration values use units such as `250ms`, `45s`, `1m`, and `24h`.

`-` means no default is supplied.

| Variable | Default | Description |
| --- | --- | --- |
| `STALKER_PORTAL_URL` | - | (required) Your provider's portal URL, such as `http://your-provider.example`. |
| `STALKER_MAC` | - | (required) The MAC address registered with your provider. |
| `STALKER_TIMEZONE` | `UTC` | Timezone used with the provider, such as `America/Toronto`. |
| `STALKER_SERIAL_NUMBER` | - | Registered device serial number. Required only if your provider asks for it. |
| `STALKER_DEVICE_ID` | - | Registered device ID. Required only if your provider asks for it. |
| `STALKER_DEVICE_ID2` | - | Second registered device ID. Required only if your provider asks for it. |
| `STALKER_USER_AGENT` | Built-in MAG user agent | Override the device identification only if your provider requires a specific value. |
| `MAX_STREAMS` | `1` | Maximum simultaneous players. Increase only within your provider's allowance. Must be at least 1. |
| `CATALOG_REFRESH_INTERVAL` | `24h` | How often to refresh the library and how long to keep saved movie/series listings. Minimum `1m`. |
| `EPG_REFRESH_INTERVAL` | `6h` | How often to refresh the programme guide. Minimum `1m`. |
| `EPISODE_CACHE_TTL` | `1h` | How long to keep an episode list before checking for updates when it is opened again. Minimum `1m`. |
| `STALKER_EPG_HOURS` | `6` | Hours of programme guide information to request. Range: 1–168. |
| `STALKER_REQUEST_TIMEOUT` | `1m` | Maximum wait for a provider request. Minimum `1s`. |
| `STALKER_REQUEST_INTERVAL` | `250ms` | Minimum delay between provider requests. Minimum `100ms`. |
| `STALKER_MAX_RESPONSE_MB` | `64` | Maximum size of a provider response in MB. Range: 1–512. |
| `SESSION_TTL` | `45s` | Release a stream after its browser stops checking in. Minimum `30s`. |
| `TRANSCODE_MODE` | `auto` | `auto`: convert video when needed; `copy`: pass it through without conversion; `transcode`: always convert it. |
| `LISTEN_ADDR` | `:8080` | Address and port inside the container. Match the container port in your Docker port mapping if changed. |
| `DATA_DIR` | `/data` | Storage for saved library information and temporary playback files. Match your volume mount if changed. |
| `WEB_DIR` | `/app/web` | Location of the browser interface files. Change only if you provide those files at a different location. |

FFmpeg and FFprobe are included in the Docker image and used automatically.

## License

MIT. See [LICENSE](LICENSE).
