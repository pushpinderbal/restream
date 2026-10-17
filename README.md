# Restream

Restream brings your IPTV subscription to the browser. Host it on your own computer or server to watch live TV, movies, and shows from a Stalker/MAG provider on desktop or mobile.

## What you can do

- Watch live channels and see what's on with the programme guide.
- Browse movies and shows by category, or search across your whole library.
- Pick up where you left off with Continue watching, Up next, and Recently played.
- Discover titles from your library on Home, with optional Trending recommendations.

## Get started

You'll need Docker, an IPTV subscription that uses a Stalker/MAG portal, and your provider's portal URL and registered MAC address. If your provider requires a serial number or device IDs, you'll need those too. Restream uses the content available through your subscription.

The Docker image includes everything needed to run Restream.

Start Restream:

```sh
docker run -d \
  --name restream \
  --restart unless-stopped \
  --stop-timeout 20 \
  -p 8080:8080 \
  -v restream-data:/data \
  ghcr.io/pushpinderbal/restream:latest
```

Open [http://localhost:8080](http://localhost:8080). From another device on your network, use `http://<server-address>:8080`.

Open **Settings** using the sliders icon, enter your provider's portal URL and MAC address, then save. Add any device details your provider requires under the advanced provider options. Once connected, choose **Live TV** for channels or **VOD** for movies and shows, open a title, and press **Play**.

### Using Docker Compose

If you've cloned this repository, start Restream with the included [Compose file](compose.yaml):

```sh
docker compose up -d
```

Open [http://localhost:8080](http://localhost:8080) and connect your provider in **Settings**. No environment file is required.

## Finding and watching something

- **Home** brings together suggestions, your watch history, and titles you can continue.
- **Search** finds channels, movies, and shows together. Enter at least two characters to see results.
- **VOD** has separate Movies and Shows tabs, with categories to help you browse.
- **Settings**, opened through the sliders icon, manages your provider, library, Trending, playback, and refresh status.

On mobile, navigation is at the bottom of the screen and you can swipe through content rows. Watch history and progress are saved in the browser you're using; **Clear history** resets them.

Multiple people can watch at once if your provider allows it. Set **Maximum simultaneous streams** in Settings to your subscription's limit; it defaults to `1`. Each open player uses a stream, including paused players. Leave playback when you're finished to save your progress and free the stream for someone else.

## Make it yours

Manage everyday options in **Settings**:

- Connect your provider and choose its timezone.
- Choose how often the library refreshes, which categories appear on Home, and which categories are blocked.
- Set your simultaneous stream limit and, when needed, playback processing and programme guide hours.
- Enable **Trending** with a read access token from your [TMDB account settings](https://www.themoviedb.org/settings/api). Restream only recommends titles available through your provider. Without a token, Home shows **Explore** suggestions from your library.

Cached results appear immediately while updates load in the background, and everyone shares the same cache. Opening a show can check for new seasons and episodes sooner; Restream manages those checks and the programme guide automatically. **Refresh now** brings updates forward while keeping saved results available.

App settings are saved in the `restream-data` volume and survive container replacements. Library, Trending and playback options are managed only in the app.

You can optionally supply provider details through environment variables: `STALKER_PORTAL_URL`, `STALKER_MAC`, `STALKER_TIMEZONE`, `STALKER_SERIAL_NUMBER`, `STALKER_DEVICE_ID`, and `STALKER_DEVICE_ID2`. Each supplied field appears as **Managed by environment** in Settings and cannot be edited there; the remaining provider fields stay editable. Environment-managed values are not displayed or copied into the saved app settings. Omit a variable to manage that field in the app; even an explicitly empty value manages the field through the environment.

[.env.example](.env.example) lists these optional overrides and the server and upstream request controls. Copy it to `.env` only if needed, uncomment the fields you want to supply, then recreate the container to apply changes. Keep that file private.

Restream has no sign-in screen. Everyone who can access it can change Settings. Keep it on your private network, or protect it with authentication before making it available over the internet.

## Local development

Install [mise](https://mise.jdx.dev/getting-started.html), then run:

```sh
mise install
mise run dev
```

Connect your provider in Settings, just as with the container. Open [http://localhost:5173](http://localhost:5173). Go and UI changes reload automatically; press Ctrl+C to stop.

Run `mise run test` for Go tests and `mise run test:container` to check the packaged app using temporary containers and storage.

## License

MIT. See [LICENSE](LICENSE).
