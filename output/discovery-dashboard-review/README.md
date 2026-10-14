# Discovery dashboard review

Reviewed the production build at `http://127.0.0.1:8080` against the configured provider on 14 October 2026.

- [Desktop with viewing history](desktop-recent.png)
- [Mobile with viewing history](mobile-recent.png)
- [Desktop without history](desktop-empty.png)
- [Mobile without history](mobile-empty.png)
- [Detailed live review results](review.json)

The dashboard combines featured artwork, Continue watching, Up next, provider discovery, Live now and filterable Recently played. Browser-local history is recorded after playback starts. No-history views keep provider discovery visible and hide the personal sections.

## Validation

`go test ./...` passed. The browser integration suite completed with 65 passed and one optional screenshot test skipped. It covers source-position Resume, replay from zero, completion, next episodes across seasons, availability-only discovery, clearing history during playback and the existing player/library workflows.

Live browser review decoded video for a channel, movie and series. Movie Resume started a real stream at the saved source position; Up next resolved and played the next provider episode. History persisted across reloads, opening watched episode details did not allocate a stream, and clearing history remained effective after reload. There were no browser page errors or horizontal overflow at 900, 821, 390 or 320 pixels. All review streams were closed.

Completion flags for two genuinely played episodes were seeded to exercise Up next; the review did not watch full episodes. The exact actions, source offsets and decoded video sizes are recorded in `review.json`. Mobile screenshots capture the entire scrollable page, so the fixed navigation appears at the original viewport boundary within the stitched image.

## Metadata configuration

TMDB is unconfigured on this instance. Live screenshots show **Explore your library**, with 18 provider movies and 18 provider shows, rather than genuine trends. The server integration tests exercise configured TMDB discovery, conservative matches, rejection of ambiguous/unavailable titles, persistent caching, image proxy restrictions and refresh failures. Live external TMDB discovery still requires the app's own `TMDB_API_READ_ACCESS_TOKEN` or `TMDB_API_KEY`.

The attribution asset at `web/public/tmdb-logo.svg` is the unmodified TMDB logo obtained from [Seerr's asset repository](https://github.com/seerr-team/seerr/blob/develop/src/assets/tmdb_logo.svg). It appears with the required attribution notice when TMDB metadata is used.

## Reproduce

Build the frontend and run the backend with the configured provider, then:

```sh
cd web
RESTREAM_PREVIEW_URL=http://127.0.0.1:8080 \
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/root/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome \
bun tests/dashboard-review.mjs
```
