// Rebuild the README showcase with: bun run --cwd web build && bun docs/showcase.mjs
// Serve the same fictional library for manual review: bun docs/showcase.mjs --serve
// All artwork, titles, guide entries, and preview video are original demo material.
import { createServer } from "node:http";
import { readFile, mkdir, rm, stat } from "node:fs/promises";
import { resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "output/showcase");
const assets = resolve(root, "docs/assets");
const port = Number(process.env.SHOWCASE_PORT || 4178);
const origin = `http://127.0.0.1:${port}`;
const now = Date.now();
const require = createRequire(resolve(root, "web/package.json"));
const { chromium } = require("@playwright/test");

const titles = [
  [
    "quiet-coast",
    "The Quiet Coast",
    "movie",
    "Adventure",
    "An open road. A changing tide. A journey back to the places that matter.",
    "#617b8b",
    "#eab77e",
  ],
  [
    "last-orbit",
    "The Last Orbit",
    "movie",
    "Sci-Fi",
    "One final signal, somewhere beyond the familiar sky.",
    "#45476b",
    "#c3a1bb",
  ],
  [
    "golden-hour",
    "Golden Hour",
    "movie",
    "Drama",
    "A summer of small discoveries and unexpected beginnings.",
    "#8b6558",
    "#edc685",
  ],
  [
    "wild-north",
    "Wild North",
    "movie",
    "Documentary",
    "Follow the seasons through a landscape shaped by water and time.",
    "#365d60",
    "#c1d5b5",
  ],
  [
    "paper-cities",
    "Paper Cities",
    "movie",
    "Drama",
    "Every street has a story. Some are still waiting to be told.",
    "#73577a",
    "#e0b1af",
  ],
  [
    "blue-distance",
    "Blue Distance",
    "movie",
    "Adventure",
    "Across the water, a new horizon is waiting.",
    "#315e86",
    "#b0dce1",
  ],
  [
    "night-shift",
    "Night Shift",
    "series",
    "Drama",
    "The city changes after dark. So do the people who keep it moving.",
    "#3c4464",
    "#d8a789",
  ],
  [
    "field-notes",
    "Field Notes",
    "series",
    "Documentary",
    "Stories from the quieter corners of our world.",
    "#486b54",
    "#d4d3a6",
  ],
  [
    "signal-house",
    "Signal House",
    "series",
    "Sci-Fi",
    "At the edge of town, every frequency holds a different story.",
    "#5b567c",
    "#c8b2d4",
  ],
  [
    "after-rain",
    "After the Rain",
    "series",
    "Drama",
    "A new season brings old friends back together.",
    "#496d78",
    "#c4d6c6",
  ],
];
const items = titles.map(([id, name, kind, category, description]) => ({
  id,
  name,
  kind,
  category,
  categoryId: `${kind}-${category.toLowerCase()}`,
  description,
  duration: kind === "movie" ? 5400 : undefined,
  image: `/showcase/art/${id}?poster=1`,
}));
const liveItems = [
  {
    id: "north-news",
    kind: "live",
    name: "North News",
    category: "News",
    categoryId: "live-news",
    number: "1",
  },
  {
    id: "earth-stories",
    kind: "live",
    name: "Earth Stories",
    category: "Documentary",
    categoryId: "live-documentary",
    number: "2",
  },
  {
    id: "culture-one",
    kind: "live",
    name: "Culture One",
    category: "Culture",
    categoryId: "live-culture",
    number: "3",
  },
];
const categories = [
  ...new Map(
    [...items, ...liveItems].map((item) => [
      item.categoryId,
      { id: item.categoryId, name: item.category, kind: item.kind },
    ]),
  ).values(),
];
const episodes = [
  "First Light",
  "After Hours",
  "The Long Way Home",
  "Fresh Start",
].map((name, index) => ({
  id: `night-shift-${index + 1}`,
  kind: "episode",
  name,
  category: "Drama",
  duration: 2700,
  season: 1,
  episode: index + 1,
}));
const discoveryTitle = (item) => ({
  item,
  name: item.name,
  overview: item.description,
  year: 2026,
  genres: [item.category],
  poster: item.image,
  backdrop: `/showcase/art/${item.id}`,
});
const preferences = {
  refreshIntervalSeconds: 21600,
  categories: [],
  configuration: { dashboardCategories: [], blockedCategories: [] },
};
const programs = liveItems.flatMap((item, index) => [
  {
    channelId: item.id,
    title: ["The World Today", "Coastlines", "The Creative Life"][index],
    description:
      "Stories, perspectives, and discoveries from around the world.",
    start: new Date(now - 900000).toISOString(),
    end: new Date(now + 2700000).toISOString(),
  },
  {
    channelId: item.id,
    title: ["City Desk", "Into the Forest", "Studio Sessions"][index],
    start: new Date(now + 2700000).toISOString(),
    end: new Date(now + 6300000).toISOString(),
  },
]);
let history = [
  {
    title: items[6],
    item: episodes[1],
    position: 840,
    duration: 2700,
    completed: false,
    watchedAt: now - 3600000,
    playbackId: "demo-history",
  },
];
let session = null;
let nextSession = 0;

// Geometric landscapes created for this showcase; no downloaded posters or media.
function artwork(id, poster = false) {
  const title = titles.find((item) => item[0] === id) || titles[0];
  const [, name, , , , sky, light] = title;
  const text = poster
    ? `<text x="80" y="1115" fill="#fff9ef" font-family="sans-serif" font-size="57" font-weight="600" letter-spacing="-1">${name.replaceAll("&", "&amp;")}</text><text x="84" y="1160" fill="#ddd9d1" font-family="sans-serif" font-size="18" letter-spacing="7">RESTREAM COLLECTION</text>`
    : "";
  const width = poster ? 800 : 1600;
  const height = poster ? 1200 : 900;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="${sky}"/><stop offset=".65" stop-color="${light}"/><stop offset="1" stop-color="#eed6b3"/></linearGradient><linearGradient id="water" x2="0" y2="1"><stop stop-color="${sky}"/><stop offset="1" stop-color="#152c3e"/></linearGradient><radialGradient id="sun"><stop stop-color="#fff9df" stop-opacity=".55"/><stop offset="1" stop-color="#fff9df" stop-opacity="0"/></radialGradient><linearGradient id="shade" x2="0" y2="1"><stop stop-opacity="0"/><stop offset="1" stop-color="#07151c" stop-opacity=".8"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#sky)"/><circle cx="${poster ? 585 : 1160}" cy="${poster ? 340 : 255}" r="245" fill="url(#sun)"/><circle cx="${poster ? 585 : 1160}" cy="${poster ? 340 : 255}" r="47" fill="#fff2d4" opacity=".85"/><path d="M0 595 160 460 265 510 430 350 620 450 800 350 1020 455 1240 320 1600 510V1000H0Z" fill="${sky}" opacity=".42"/><path d="M0 650 140 600 305 640 480 490 655 560 800 500 1040 625 1260 500 1600 600V1000H0Z" fill="#234751" opacity=".6"/><rect y="660" width="100%" height="600" fill="url(#water)"/><g stroke="#e8d5b8" opacity=".15" stroke-width="2"><path d="M0 700H1600M100 745H1500M0 790H1600M300 835H1400M0 890H1600"/></g><path d="M0 720Q100 675 240 730T440 800L${poster ? 850 : 1000} 1250H0Z" fill="#132e36"/><path d="M0 790Q105 755 230 802T490 915L760 1250H0Z" fill="#0a202b"/><path d="M0 820Q110 785 225 832T500 965" fill="none" stroke="${light}" stroke-opacity=".5" stroke-width="3"/><rect y="780" width="100%" height="500" fill="url(#shade)"/>${text}</svg>`;
}

const types = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t",
};
const server = createServer(async (req, res) => {
  const url = new URL(req.url, origin);
  const path = url.pathname;
  const json = (value, code = 200) => {
    res.writeHead(code, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(value));
  };
  const body = async () => {
    let value = "";
    for await (const chunk of req) value += chunk;
    return value ? JSON.parse(value) : {};
  };
  try {
    if (path.startsWith("/showcase/art/")) {
      res.writeHead(200, { "Content-Type": "image/svg+xml" });
      return res.end(
        artwork(path.split("/").at(-1), url.searchParams.has("poster")),
      );
    }
    if (path === "/api/auth")
      return json({
        mode: "oidc",
        user: { id: "showcase", name: "Demo", role: "viewer" },
      });
    if (path === "/api/preferences") return json(preferences);
    if (path === "/api/status")
      return json({
        configured: true,
        refreshing: false,
        libraryUpdatedAt: new Date(now).toISOString(),
        catalogUpdatedAt: new Date(now).toISOString(),
        epgUpdatedAt: new Date(now).toISOString(),
        activeStreams: session ? 1 : 0,
        maxStreams: 3,
        timezone: "UTC",
        guideHours: 48,
        playback: { transcodeMode: "auto", sessionTimeoutSeconds: 45 },
        library: {
          liveChannels: 3,
          cachedMovies: 6,
          cachedSeries: 4,
          categories: categories.length,
          programmes: programs.length,
        },
      });
    if (path === "/api/settings")
      return json({
        providerEnvironment: [],
        provider: {
          portalUrl: "",
          mac: "",
          timezone: "UTC",
          serialNumber: "",
          deviceId: "",
          deviceId2: "",
        },
        library: {
          ...preferences,
          guideHours: 48,
          dashboardCategories: [],
          blockedCategories: [],
        },
        discovery: { tmdbTokenConfigured: false },
        playback: { maxStreams: 3, transcodeMode: "auto" },
        updatedAt: new Date(now).toISOString(),
      });
    if (path === "/api/catalog") return json({ items: liveItems });
    if (path === "/api/categories") return json({ categories });
    if (path === "/api/epg") return json({ programs });
    if (path === "/api/discovery")
      return json({
        configured: false,
        refreshing: false,
        trendingMovies: [],
        trendingSeries: [],
        exploreMovies: items
          .filter((item) => item.kind === "movie")
          .map(discoveryTitle),
        exploreSeries: items
          .filter((item) => item.kind === "series")
          .map(discoveryTitle),
      });
    if (path === "/api/browse") {
      const selected = [...items, ...liveItems].filter(
        (item) =>
          item.kind === url.searchParams.get("kind") &&
          (!url.searchParams.get("search") ||
            item.name
              .toLowerCase()
              .includes(url.searchParams.get("search").toLowerCase())) &&
          [null, "*", item.categoryId].includes(
            url.searchParams.get("category"),
          ),
      );
      return json({
        items: selected,
        page: 1,
        total: selected.length,
        hasMore: false,
      });
    }
    if (path.startsWith("/api/items/"))
      return json({
        item: [...items, ...liveItems].find(
          (item) => item.id === decodeURIComponent(path.slice(11)),
        ),
      });
    if (/^\/api\/series\/[^/]+\/episodes$/.test(path))
      return json({ items: episodes, seasons: [1], season: 1 });
    if (path === "/api/watch-history" && req.method === "GET")
      return json({
        entries: history,
        scope: "provider:showcase",
        userId: "showcase",
      });
    if (path === "/api/watch-history/record") {
      const entry = {
        ...(await body()),
        watchedAt: Date.now(),
        updatedAt: Date.now(),
        playbackId: "showcase-playing",
      };
      history = [
        entry,
        ...history.filter((value) => value.title.id !== entry.title.id),
      ];
      return json({ entry, scope: "provider:showcase" });
    }
    if (path === "/api/watch-history/progress")
      return json({ entry: null, scope: "provider:showcase" });
    if (path === "/api/sessions" && req.method === "POST") {
      const input = await body();
      session = {
        id: `showcase-${++nextSession}`,
        state: "ready",
        url: "/showcase/media/index.m3u8",
        duration: 120,
        offset: input.start || 0,
        subtitles: [
          {
            id: "english",
            label: "English",
            language: "en",
            url: "/showcase/cues.json",
            default: true,
          },
        ],
      };
      return json(session, 201);
    }
    if (path.endsWith("/heartbeat")) {
      res.writeHead(204);
      return res.end();
    }
    if (path.startsWith("/api/sessions/")) {
      if (req.method === "DELETE") {
        session = null;
        res.writeHead(204);
        return res.end();
      }
      return json(session);
    }
    if (path === "/showcase/cues.json")
      return json({
        cues: [
          {
            start: 0,
            end: 110,
            text: "A little closer to your next discovery.",
          },
        ],
      });
    if (path.startsWith("/api/"))
      return json({ error: "Not available in the showcase" }, 404);
    const base = path.startsWith("/showcase/media/")
      ? resolve(output, "media")
      : resolve(root, "web/dist");
    const relative = path.startsWith("/showcase/media/")
      ? path.slice("/showcase/media/".length)
      : path.slice(1);
    let file = resolve(base, relative || "index.html");
    if (!file.startsWith(`${base}/`)) {
      res.writeHead(403);
      return res.end();
    }
    try {
      if (!(await stat(file)).isFile()) throw new Error("Not a file");
    } catch {
      file = resolve(base, "index.html");
    }
    res.writeHead(200, {
      "Content-Type": types[extname(file)] || "application/octet-stream",
    });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404);
    res.end();
  }
});

await mkdir(output, { recursive: true });
await mkdir(assets, { recursive: true });
await new Promise((done) => server.listen(port, "127.0.0.1", done));
console.log(`Fictional showcase library: ${origin}`);
if (process.argv.includes("--serve")) {
  process.on("SIGINT", () => server.close(() => process.exit(0)));
} else {
  const browser = await chromium.launch({
    headless: true,
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  let page;
  try {
    page = await browser.newPage({
      viewport: { width: 1440, height: 960 },
      deviceScaleFactor: 1,
    });
    page.setDefaultTimeout(10000);
    await page.goto(`${origin}/showcase/art/quiet-coast`);
    await page
      .locator("svg")
      .screenshot({ path: resolve(output, "landscape.png") });
    await mkdir(resolve(output, "media"), { recursive: true });
    if (!process.argv.includes("--reuse-media"))
      execFileSync(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-loop",
          "1",
          "-framerate",
          "24",
          "-i",
          resolve(output, "landscape.png"),
          "-f",
          "lavfi",
          "-i",
          "anullsrc=r=48000:cl=stereo",
          "-t",
          "120",
          "-vf",
          "scale=1280:720,format=yuv420p",
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-tune",
          "stillimage",
          "-g",
          "48",
          "-c:a",
          "aac",
          "-b:a",
          "64k",
          "-f",
          "hls",
          "-hls_time",
          "2",
          "-hls_list_size",
          "0",
          resolve(output, "media/index.m3u8"),
        ],
        { stdio: "inherit" },
      );
    const frames = resolve(output, "frames");
    await rm(frames, { recursive: true, force: true });
    await mkdir(frames, { recursive: true });
    await page.addInitScript(() =>
      localStorage.setItem(
        "restream:subtitles",
        JSON.stringify({ language: "en", label: "English" }),
      ),
    );
    let frame = 0;
    const hold = async (seconds) => {
      for (let tick = 0; tick < seconds * 6; tick++) {
        const start = Date.now();
        await page.screenshot({
          path: resolve(frames, `${String(frame++).padStart(4, "0")}.png`),
        });
        await page.waitForTimeout(Math.max(0, 1000 / 6 - (Date.now() - start)));
      }
    };
    await page.goto(`${origin}/?view=dashboard`);
    await page.locator(".discovery-feature").waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(700);
    await page.mouse.move(20, 20);
    await page.screenshot({ path: resolve(assets, "showcase.png") });
    await hold(2);
    await page
      .getByRole("heading", { name: "Explore", exact: true })
      .scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await hold(1.5);
    await page
      .getByRole("navigation", { name: "Library", exact: true })
      .getByRole("button", { name: "VOD", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Open The Quiet Coast", exact: true })
      .waitFor();
    await hold(1.5);
    await page
      .getByRole("button", { name: "Open The Quiet Coast", exact: true })
      .click();
    await hold(1.5);
    await page
      .getByRole("region", { name: "Expanded title" })
      .getByRole("button", { name: "Play", exact: true })
      .click();
    await page.locator("video").waitFor();
    await page.waitForFunction(
      () => document.querySelector("video")?.readyState >= 2,
    );
    await page.mouse.move(900, 450);
    await hold(2);
    await page
      .getByRole("button", { name: "Stop playback", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Account", exact: true })
      .filter({ visible: true })
      .click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await page.locator("#settings-subtitles").waitFor();
    await page
      .getByRole("link", { name: "Subtitles", exact: true })
      .filter({ visible: true })
      .click();
    await page.waitForTimeout(500);
    await hold(2);
    const color = page.getByRole("combobox", {
      name: "Text color",
      exact: true,
    });
    await color.click();
    await hold(0.5);
    await page.getByRole("option", { name: "Yellow", exact: true }).click();
    await hold(2);
    const gif = resolve(assets, "showcase.gif");
    execFileSync(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-framerate",
        "6",
        "-i",
        resolve(frames, "%04d.png"),
        "-filter_complex",
        "scale=1056:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle",
        "-loop",
        "0",
        gif,
      ],
      { stdio: "inherit" },
    );
    console.log(
      `Saved ${frame} frames, ${(await stat(gif)).size} bytes: docs/assets/showcase.gif`,
    );
  } catch (error) {
    await page
      ?.screenshot({ path: resolve(output, "capture-error.png") })
      .catch(() => {});
    throw error;
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
}
