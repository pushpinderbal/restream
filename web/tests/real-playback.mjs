import { chromium, expect } from "@playwright/test";

const baseURL = process.argv[2];
if (!baseURL) throw new Error("Usage: bun tests/real-playback.mjs <baseURL>");

const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
    : {}),
  args: ["--autoplay-policy=no-user-gesture-required"],
});

const page = await browser.newPage();
page.on("console", (message) => {
  if (message.type() === "error" || message.type() === "warning")
    console.log(`Browser ${message.type()}: ${message.text()}`);
});
const browserErrors = [];
const activeWorkers = new Set();
page.on("worker", (worker) => {
  activeWorkers.add(worker);
  worker.on("close", () => activeWorkers.delete(worker));
});
const cdp = await page.context().newCDPSession(page);
const heapUsage = async () => {
  await cdp.send("HeapProfiler.collectGarbage");
  return (await cdp.send("Runtime.getHeapUsage")).usedSize;
};
const checkReleasedMedia = async () => {
  await expect.poll(() => activeWorkers.size, { timeout: 5000 }).toBe(0);
  await expect(page.locator("video")).toHaveCount(0);
};
const checkBufferWindow = async () => {
  const window = await page.locator("video").evaluate((video) => {
    let duration = 0;
    for (let i = 0; i < video.buffered.length; i++)
      duration += video.buffered.end(i) - video.buffered.start(i);
    return {
      duration,
      ahead: video.buffered.length
        ? Math.max(
            0,
            video.buffered.end(video.buffered.length - 1) - video.currentTime,
          )
        : 0,
      back: video.buffered.length
        ? Math.max(0, video.currentTime - video.buffered.start(0))
        : 0,
    };
  });
  // Allow segment boundaries around each configured 30-second window.
  if (window.ahead > 35 || window.back > 35)
    throw new Error(
      `HLS buffer exceeded its media window: ${JSON.stringify(window)}`,
    );
  return window.duration;
};
const sessionIds = new Set();
let seekCount = 0;
page.on("pageerror", (error) => {
  browserErrors.push(error.message);
  console.log("Browser error:", error.message);
});
page.on("request", (request) => {
  if (/\/api\/sessions\/[^/]+\/seek$/.test(request.url())) seekCount++;
});
page.on("response", async (response) => {
  if (
    response.request().method() === "POST" &&
    new URL(response.url()).pathname === "/api/sessions" &&
    response.status() === 201
  ) {
    try {
      sessionIds.add((await response.json()).id);
    } catch {
      // Cleanup still happens through the player and heartbeat expiry.
    }
  }
});

const navigateLibrary = async (kind) => {
  const navigation = page.getByRole("navigation", {
    name: page.viewportSize().width <= 820 ? "Primary navigation" : "Library",
    exact: true,
  });
  const types = page.getByRole("tablist", { name: "VOD type", exact: true });
  if (kind === "live" || !(await types.isVisible()))
    await navigation
      .getByRole("button", {
        name: kind === "live" ? "Live TV" : "VOD",
        exact: true,
      })
      .click();
  if (kind !== "live")
    await types
      .getByRole("tab", {
        name: kind === "movie" ? "Movies" : "Shows",
        exact: true,
      })
      .click();
};
const openSettings = async () => {
  await page
    .getByRole("button", { name: "Account", exact: true })
    .filter({ visible: true })
    .click();
  const menu = page.getByRole("menu", { name: "Account", exact: true });
  await menu.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expect(menu).toHaveCount(0);
};
const checkReleasedPlayback = async () => {
  await checkReleasedMedia();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`${baseURL}/api/status`)).json())
          .activeStreams,
      { timeout: 10000 },
    )
    .toBe(0);
};
const playTestMovie = async ({ fromSearch = false } = {}) => {
  if (fromSearch) {
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(
      page.getByRole("searchbox", { name: "Search library", exact: true }),
    ).toHaveValue("");
    await page
      .getByRole("searchbox", { name: "Search library", exact: true })
      .fill("Test");
  } else await navigateLibrary("movie");
  const titles = fromSearch
    ? page.getByRole("region", { name: "Movies results", exact: true })
    : page;
  await titles
    .getByRole("button", { name: "Open Test movie", exact: true })
    .click();
  await page
    .getByRole("region", { name: "Expanded title", exact: true })
    .getByRole("button", { name: "Play", exact: true })
    .click();
  await page.waitForFunction(progressing, undefined, { timeout: 15000 });
};

const videoState = () => {
  const video = document.querySelector("video");
  return (
    video && {
      time: video.currentTime,
      paused: video.paused,
      width: video.videoWidth,
      height: video.videoHeight,
      src: video.currentSrc,
    }
  );
};
const progressing = () => {
  const video = document.querySelector("video");
  return (
    video && !video.paused && video.currentTime > 0.5 && video.videoWidth > 0
  );
};

async function checkNativePlayback() {
  const nativePage = await browser.newPage();
  const supported = await nativePage.evaluate(
    () =>
      !!document
        .createElement("video")
        .canPlayType("application/vnd.apple.mpegurl"),
  );
  if (!supported) {
    console.log(
      "Native HLS decoding unavailable in this browser; native selection covered by workflow tests",
    );
    await nativePage.close();
    return;
  }
  // Emulate a native-only browser while retaining Chrome's real HLS decoder.
  await nativePage.addInitScript(() => {
    document.addEventListener(
      "error",
      (event) => {
        if (event.target instanceof HTMLVideoElement && event.target.error)
          window.__restreamNativeMediaError = {
            code: event.target.error.code,
            message: event.target.error.message,
            source: event.target.currentSrc || event.target.src,
          };
      },
      true,
    );
    for (const name of [
      "MediaSource",
      "ManagedMediaSource",
      "WebKitMediaSource",
    ])
      Reflect.deleteProperty(window, name);
  });
  let nativeSeeks = 0;
  const nativeErrors = [];
  nativePage.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning")
      console.log(`Native browser ${message.type()}: ${message.text()}`);
  });
  const workers = new Set();
  nativePage.on("worker", (worker) => {
    workers.add(worker);
    worker.on("close", () => workers.delete(worker));
  });
  nativePage.on("pageerror", (error) => nativeErrors.push(error.message));
  nativePage.on("request", (request) => {
    if (/\/api\/sessions\/[^/]+\/seek$/.test(request.url())) nativeSeeks++;
    if (/\/assets\/hls(?:[.-])/.test(new URL(request.url()).pathname))
      nativeErrors.push("Native playback loaded the JS decoder");
  });
  nativePage.on("response", async (response) => {
    if (
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/sessions" &&
      response.status() === 201
    )
      sessionIds.add((await response.json()).id);
  });
  try {
    await nativePage.goto(`${baseURL}/?section=movie`);
    await nativePage.getByRole("button", { name: "Open Test movie" }).click();
    await nativePage.getByRole("button", { name: "Play", exact: true }).click();
    await nativePage
      .waitForFunction(progressing, undefined, {
        timeout: 15000,
      })
      .catch(async (error) => {
        console.log(
          "Native initial state:",
          JSON.stringify(
            await nativePage.locator("video").evaluate((video) => ({
              currentTime: video.currentTime,
              currentSrc: video.currentSrc,
              paused: video.paused,
              readyState: video.readyState,
              networkState: video.networkState,
              error: video.error && {
                code: video.error.code,
                message: video.error.message,
              },
              hasMediaSource: "MediaSource" in window,
              capturedError: window.__restreamNativeMediaError,
            })),
          ),
        );
        console.log(
          "Native player alerts:",
          await nativePage.getByRole("alert").allTextContents(),
        );
        throw error;
      });
    const source = (await nativePage.evaluate(videoState)).src;
    const nativeArea = nativePage.locator(".playback-area");
    await nativeArea.hover();
    await nativePage
      .getByRole("button", { name: "Pause", exact: true })
      .click();
    await nativePage.waitForFunction(
      () => document.querySelector("video")?.paused,
    );
    const window = await nativePage.locator("video").evaluate((video) => ({
      time: video.currentTime,
      mediaError: window.__restreamNativeMediaError ?? null,
      seekable: Array.from({ length: video.seekable.length }, (_, i) => ({
        start: video.seekable.start(i),
        end: video.seekable.end(i),
      })),
      buffered: Array.from({ length: video.buffered.length }, (_, i) => ({
        start: video.buffered.start(i),
        end: video.buffered.end(i),
      })),
    }));
    console.log(`Native HLS media window: ${JSON.stringify(window)}`);
    if (window.mediaError)
      throw new Error(
        `Native playback failed: ${JSON.stringify(window.mediaError)}`,
      );
    // A native decoder can play EVENT playlists without exposing a seekable
    // window. Only attempt a local slider seek when a distinct whole-second
    // target exists; the server seek below remains required in every browser.
    const target = window.seekable
      .flatMap((range) =>
        [Math.ceil(range.start), Math.floor(range.end - 0.251)].filter(
          (value) => value >= range.start && value < range.end - 0.25,
        ),
      )
      .sort((a, b) => Math.abs(b - window.time) - Math.abs(a - window.time))
      .find((value) => Math.abs(value - window.time) > 0.5);
    const timeline = await nativePage.locator(".timeline").boundingBox();
    const thumb = await nativePage.locator(".timeline-thumb").boundingBox();
    if (!timeline || !thumb)
      throw new Error("Native HLS timeline was not visible");
    if (target !== undefined) {
      // Drag from the thumb: a nearby track click can hit the thumb without
      // changing its value when the native buffer window is only a few seconds.
      await nativePage.mouse.move(
        thumb.x + thumb.width / 2,
        thumb.y + thumb.height / 2,
      );
      await nativePage.mouse.down();
      await nativePage.mouse.move(
        timeline.x +
          thumb.width / 2 +
          ((timeline.width - thumb.width) * target) / 60,
        timeline.y + timeline.height / 2,
      );
      await nativePage.mouse.up();
      await expect
        .poll(() =>
          nativePage.locator("video").evaluate((video) => video.currentTime),
        )
        .toBeCloseTo(target, 0);
      if (nativeSeeks || (await nativePage.evaluate(videoState)).src !== source)
        throw new Error("Native in-window seek restarted the server stream");
      console.log("Native in-window seek kept its HLS source");
    } else {
      console.log(
        "Native decoder exposes no local slider seek target; local seeking remains covered by controlled workflow tests",
      );
    }
    await nativeArea.hover();
    await nativePage.getByRole("button", { name: "Play", exact: true }).click();
    await nativePage.waitForFunction(progressing, undefined, {
      timeout: 10000,
    });
    await nativeArea.hover();
    const seekResponse = nativePage.waitForResponse((response) =>
      /\/api\/sessions\/[^/]+\/seek$/.test(response.url()),
    );
    await nativePage.mouse.click(
      timeline.x + timeline.width * 0.9,
      timeline.y + timeline.height / 2,
    );
    await seekResponse;
    await nativePage.waitForFunction(
      (source) => document.querySelector("video")?.currentSrc !== source,
      source,
      { timeout: 15000 },
    );
    await nativePage
      .waitForFunction(progressing, undefined, { timeout: 15000 })
      .catch(async (error) => {
        console.log(
          "Native seek result:",
          await nativePage.locator("video").evaluate((video) => ({
            time: video.currentTime,
            paused: video.paused,
            ended: video.ended,
            readyState: video.readyState,
            networkState: video.networkState,
            source: video.currentSrc,
            error: window.__restreamNativeMediaError,
            duration: video.duration,
          })),
        );
        console.log(
          "Native alerts:",
          await nativePage.getByRole("alert").allTextContents(),
        );
        throw error;
      });
    await nativePage.getByRole("button", { name: "Stop playback" }).click();
    await expect(nativePage.locator("video")).toHaveCount(0);
    await expect.poll(() => workers.size, { timeout: 5000 }).toBe(0);
    await nativePage.waitForFunction(
      async () =>
        (await (await fetch("/api/status")).json()).activeStreams === 0,
    );
    if (nativeErrors.length) throw new Error(nativeErrors.join("\n"));
    console.log(
      "Native-only HLS decodes, pauses, resumes after a server seek, and releases playback",
    );
  } finally {
    await nativePage.close();
  }
}

try {
  if (process.env.RESTREAM_NATIVE_ONLY === "1") {
    await checkNativePlayback();
  } else {
    const codecsSupported = await page.evaluate(
      () =>
        typeof MediaSource !== "undefined" &&
        MediaSource.isTypeSupported('video/mp4;codecs="avc1.42e01e"') &&
        MediaSource.isTypeSupported('audio/mp4;codecs="mp4a.40.2"'),
    );
    if (!codecsSupported)
      throw new Error(
        "Real playback requires H.264/AAC support. Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to a compatible Chrome/Chromium executable.",
      );
    await page.goto(baseURL);
    const initialHeap = await heapUsage();
    if (activeWorkers.size) throw new Error("Decoder started before playback");
    await navigateLibrary("movie");
    await page.getByRole("button", { name: "Open Test movie" }).click();
    const play = page.getByRole("button", { name: "Play", exact: true });
    await play.waitFor({ timeout: 30000 });
    const started = Date.now();
    await play.click();
    await page.waitForFunction(
      () => {
        const video = document.querySelector("video");
        return video && video.getVideoPlaybackQuality().totalVideoFrames > 0;
      },
      undefined,
      { timeout: 15000 },
    );
    const firstFrameMs = Date.now() - started;
    await page
      .waitForFunction(progressing, undefined, { timeout: 15000 })
      .catch(async (error) => {
        console.log(
          "Video state:",
          JSON.stringify(await page.evaluate(videoState)),
        );
        console.log(
          "Player alerts:",
          await page.getByRole("alert").allTextContents(),
        );
        await page.screenshot({ path: "/tmp/restream-playback-debug.png" });
        throw error;
      });
    const decoded = await page.evaluate(videoState);
    if (!decoded.src.startsWith("blob:"))
      throw new Error(
        "HLS.js was not preferred over advertised native support",
      );
    if (
      ![...activeWorkers].some((worker) =>
        /\/assets\/hls\.worker-/.test(worker.url()),
      )
    )
      throw new Error("HLS transmuxing did not start its local worker");
    console.log(
      `Buffered ${await checkBufferWindow()}s; decoding worker active: ${activeWorkers.size}`,
    );
    console.log(
      `Decoded HLS ${decoded.width}x${decoded.height}; first decoded frame observed in ${firstFrameMs}ms`,
    );

    for (const section of ["series", "live", "movie"]) {
      const previousVideo = await page.locator("video").elementHandle();
      await navigateLibrary(section);
      await checkReleasedPlayback();
      if (await previousVideo.evaluate((element) => element.isConnected))
        throw new Error(`Switching to ${section} retained the old player`);
      await playTestMovie();
    }
    console.log(
      "Sidebar navigation releases its decoder and stream slot; returning to VOD starts decoded playback again",
    );

    const area = page.locator(".playback-area");
    const controls = page.locator(".video-controls");
    await page.mouse.move(1, 1);
    await area.hover();
    await page.waitForTimeout(3100);
    if ((await controls.getAttribute("data-visible")) !== "false")
      throw new Error("Playing controls did not auto-hide");
    await area.hover({ position: { x: 30, y: 30 } });
    await page
      .getByRole("button", { name: "Full screen", exact: true })
      .click();
    await page.mouse.move(100, 100);
    await page.waitForTimeout(3100);
    if ((await controls.getAttribute("data-visible")) !== "false")
      throw new Error("Fullscreen controls did not auto-hide");
    await page.mouse.move(200, 120);
    await page.getByRole("button", { name: "Exit full screen" }).click();
    await area.hover({ position: { x: 40, y: 40 } });
    console.log(
      "Controls fade after inactivity, including fullscreen, and return on pointer activity",
    );

    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector("video")?.paused,
      undefined,
      {
        timeout: 5000,
      },
    );
    await page.waitForTimeout(1200);
    const sourceBeforeResume = (await page.evaluate(videoState)).src;
    await page.keyboard.press("m");
    if (!(await page.evaluate(() => document.querySelector("video")?.muted)))
      throw new Error("Mute shortcut failed");
    await page.keyboard.press("m");
    await page.keyboard.press("k");
    await page.waitForFunction(progressing, undefined, { timeout: 10000 });
    if (
      (await page.evaluate(videoState)).src !== sourceBeforeResume ||
      seekCount !== 0
    )
      throw new Error("Pause/resume unnecessarily restarted the stream");
    console.log("Pause/resume keeps the same HLS generation");

    await area.hover({ position: { x: 50, y: 40 } });
    await page.getByRole("button", { name: "Back 10 seconds" }).click();
    await page.waitForTimeout(500);
    if (seekCount !== 0)
      throw new Error("Buffered rewind restarted the stream");
    console.log("Buffered rewind seeks locally");

    await area.hover({ position: { x: 60, y: 40 } });
    await page.getByRole("button", { name: "Forward 10 seconds" }).click();
    await page.waitForTimeout(500);
    if (seekCount !== 0)
      throw new Error("Available forward seek restarted the stream");
    console.log("Available forward seek stays local");
    await checkBufferWindow();
    if (process.env.CAPTURE_SCREENSHOTS === "1")
      await page.screenshot({ path: "/tmp/restream-real-player.png" });
    const bounds = await page.locator(".timeline").boundingBox();
    if (!bounds) throw new Error("Timeline not visible");
    const seeksBefore = seekCount;
    const sourceBeforeSeek = (await page.evaluate(videoState)).src;
    const seekResponse = page.waitForResponse(
      (response) =>
        /\/api\/sessions\/[^/]+\/seek$/.test(response.url()) &&
        response.request().method() === "POST",
      { timeout: 5000 },
    );
    const seekStarted = Date.now();
    await page.mouse.click(
      bounds.x + bounds.width * 0.9,
      bounds.y + bounds.height / 2,
    );
    await seekResponse;
    if (seekCount <= seeksBefore)
      throw new Error("Timeline did not request a seek");
    await page.waitForFunction(
      (previous) => document.querySelector("video")?.currentSrc !== previous,
      sourceBeforeSeek,
      { timeout: 30000 },
    );
    await page.waitForFunction(progressing, undefined, { timeout: 30000 });
    const afterSeek = await page.evaluate(videoState);
    if (afterSeek.paused || afterSeek.width === 0)
      throw new Error("Playback did not resume after timeline seek");
    console.log(
      `Timeline seek resumed decoded playback in ${Date.now() - seekStarted}ms`,
    );
    await checkBufferWindow();
    await page.setViewportSize({ width: 390, height: 844 });
    await area.hover({ position: { x: 70, y: 40 } });
    if (process.env.CAPTURE_SCREENSHOTS === "1")
      await page.screenshot({ path: "/tmp/restream-real-player-mobile.png" });
    if ((await page.evaluate(() => document.documentElement.scrollWidth)) > 390)
      throw new Error("Player overflows mobile viewport");

    const videoBeforeSettings = await page.locator("video").elementHandle();
    await openSettings();
    await page
      .getByRole("heading", { name: "Settings", exact: true })
      .waitFor();
    await checkReleasedPlayback();
    if (await videoBeforeSettings.evaluate((element) => element.isConnected))
      throw new Error("Settings retained the decoding player");
    const beforeRefresh = await (
      await page.request.get(`${baseURL}/api/status`)
    ).json();
    const libraryRefreshed = page.waitForResponse(async (response) => {
      if (!response.url().endsWith("/api/status")) return false;
      const status = await response.json();
      return (
        status.libraryUpdatedAt !== beforeRefresh.libraryUpdatedAt &&
        !status.refreshing
      );
    });
    const refreshResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/refresh" &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Refresh now", exact: true })
      .click();
    const refresh = await refreshResponse;
    expect(refresh.ok()).toBe(true);
    expect(refresh.request().postDataJSON()).toEqual({ target: "all" });
    await libraryRefreshed;
    await checkReleasedPlayback();
    await playTestMovie();
    await area.waitFor({ state: "visible" });
    const playingVideo = await page.locator("video").elementHandle();
    const sourceBeforeCategory = (await page.evaluate(videoState)).src;
    const seeksBeforeCategory = seekCount;
    await page.getByRole("combobox", { name: "Category", exact: true }).click();
    await page.getByRole("option", { name: "Test films", exact: true }).click();
    await expect(
      page.getByRole("combobox", { name: "Category", exact: true }),
    ).toContainText("Test films");
    const filteredVideo = await page.evaluate(videoState);
    if (
      !(await playingVideo.evaluate((element) => element.isConnected)) ||
      filteredVideo.src !== sourceBeforeCategory ||
      filteredVideo.paused ||
      !filteredVideo.width ||
      seekCount !== seeksBeforeCategory
    )
      throw new Error(
        "Changing library category interrupted the decoding player",
      );
    console.log(
      "Library category changes preserve the same decoding video and HLS source",
    );
    await page
      .getByRole("button", { name: "Stop playback", exact: true })
      .click();
    await checkReleasedPlayback();

    await playTestMovie({ fromSearch: true });
    const searchOrigin = await page.evaluate(
      () => window.history.state.restreamPlayerOrigin.url,
    );
    await expect(page.getByRole("searchbox")).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: /^(Movies|Shows|Live TV) results$/ }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "Movies library", exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Stop playback", exact: true })
      .click();
    await checkReleasedPlayback();
    await expect.poll(() => page.url()).toBe(searchOrigin);
    await expect(
      page.getByRole("searchbox", { name: "Search library", exact: true }),
    ).toHaveValue("Test");
    await expect(
      page
        .getByRole("region", { name: "Movies results", exact: true })
        .getByRole("button", { name: "Open Test movie", exact: true }),
    ).toHaveAttribute("aria-expanded", "true");
    await page
      .getByRole("region", { name: "Expanded title", exact: true })
      .getByRole("button", { name: "Play", exact: true })
      .click();
    await page.waitForFunction(progressing, undefined, { timeout: 15000 });
    await page.goBack();
    await checkReleasedPlayback();
    await expect.poll(() => page.url()).toBe(searchOrigin);
    await expect(
      page.getByRole("searchbox", { name: "Search library", exact: true }),
    ).toHaveValue("Test");
    console.log(
      "Search-origin playback hides search results; Stop and browser Back restore its exact query and release the stream",
    );
    await navigateLibrary("live");
    await page
      .getByRole("button", { name: "Open Test live", exact: true })
      .click();
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await page.waitForFunction(progressing, undefined, { timeout: 15000 });
    const firstLiveSource = (await page.evaluate(videoState)).src;
    await page
      .getByRole("complementary", { name: "Watch context", exact: true })
      .getByRole("region", { name: "Channels", exact: true })
      .getByRole("button", { name: "Watch Test live two", exact: true })
      .click();
    await page.waitForFunction(
      (previous) => {
        const video = document.querySelector("video");
        return (
          video &&
          video.currentSrc !== previous &&
          !video.paused &&
          video.videoWidth > 0 &&
          video.currentTime > 0.5
        );
      },
      firstLiveSource,
      { timeout: 15000 },
    );
    const liveStatus = await (await fetch(`${baseURL}/api/status`)).json();
    if (liveStatus.activeStreams !== 1)
      throw new Error("Channel tune lost its single stream slot");
    console.log(
      "One-click live channel switch decodes the next channel with one stream slot",
    );
    await page
      .getByRole("button", { name: "Stop playback", exact: true })
      .click();
    await page.waitForFunction(
      async (url) =>
        (await (await fetch(`${url}/api/status`)).json()).activeStreams === 0,
      baseURL,
      { timeout: 10000 },
    );
    await checkReleasedMedia();
    const finalHeap = await heapUsage();
    console.log(
      `JS heap after GC: ${(initialHeap / 1024 / 1024).toFixed(1)}MiB before playback, ${(finalHeap / 1024 / 1024).toFixed(1)}MiB after playback (decoder modules remain cached)`,
    );
    if (browserErrors.length) throw new Error(browserErrors.join("\n"));
    console.log("Leaving player released stream slot; no browser errors");
    await checkNativePlayback();
  }
} finally {
  for (const id of sessionIds) {
    await fetch(`${baseURL}/api/sessions/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }).catch(() => {});
  }
  await browser.close();
}
