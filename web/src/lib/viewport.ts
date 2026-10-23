/** Contain Chrome iOS fullscreen viewport inconsistencies at the app boundary. */
export function trackAppViewport() {
  const viewport = document.querySelector<HTMLMetaElement>(
    'meta[name="viewport"]',
  );
  if (!viewport || !/CriOS\//.test(navigator.userAgent)) return () => {};

  const original = viewport.content;
  const root = document.documentElement;
  let appliedWidth = 0;
  let frame = 0;
  const update = () => {
    frame = 0;
    const width = window.outerWidth;
    const scale = window.visualViewport?.scale ?? 1;
    // iOS can fit the previous explicit width to a smaller window on rotation.
    const fittedToWindow =
      appliedWidth > width && Math.abs(scale - width / appliedWidth) < 0.01;
    const video = document.querySelector("video") as
      (HTMLVideoElement & { webkitDisplayingFullscreen?: boolean }) | null;
    if (
      !width ||
      document.hidden ||
      document.fullscreenElement ||
      video?.webkitDisplayingFullscreen ||
      (Math.abs(scale - 1) > 0.01 && !fittedToWindow)
    )
      return;

    // The shell occupies the visible viewport. Its content scrolls independently
    // of the stale layout viewport, so navigation and content share one frame.
    const height = window.visualViewport?.height ?? window.innerHeight;
    if (height > 0)
      root.style.setProperty("--app-viewport-height", `${height}px`);
    root.style.setProperty(
      "--app-viewport-top",
      `${window.visualViewport?.offsetTop ?? 0}px`,
    );
    if (
      (!appliedWidth || appliedWidth === width) &&
      Math.abs(window.innerWidth - width) <= 1
    )
      return;

    // On the affected iPad, outerWidth correctly becomes 1180 while innerWidth,
    // screen.width and screen.orientation remain at their portrait values.
    // Keep this explicit width in sync with subsequent rotation/window changes.
    appliedWidth = width;
    viewport.content = original.replace(
      /width\s*=\s*[^,;]+/i,
      `width=${width}`,
    );
  };
  const schedule = () => {
    if (!frame) frame = window.requestAnimationFrame(update);
  };
  const listeners = new AbortController();
  const options = { signal: listeners.signal };
  for (const event of ["resize", "orientationchange"])
    window.addEventListener(event, schedule, options);
  for (const event of [
    "fullscreenchange",
    "webkitendfullscreen",
    "visibilitychange",
  ])
    document.addEventListener(event, schedule, { ...options, capture: true });
  window.visualViewport?.addEventListener("resize", schedule, options);
  window.visualViewport?.addEventListener("scroll", schedule, options);
  schedule();

  return () => {
    listeners.abort();
    window.cancelAnimationFrame(frame);
    root.style.removeProperty("--app-viewport-height");
    root.style.removeProperty("--app-viewport-top");
    if (appliedWidth) viewport.content = original;
  };
}
