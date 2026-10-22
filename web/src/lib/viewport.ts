/** Recover Chrome on iPad retaining its portrait viewport after fullscreen. */
export function trackViewportRecovery() {
  const viewport = document.querySelector<HTMLMetaElement>(
    'meta[name="viewport"]',
  );
  if (!viewport || !/CriOS\//.test(navigator.userAgent)) return () => {};

  const original = viewport.content;
  const root = document.documentElement;
  let appliedWidth = 0;
  let timer: number | undefined;
  const update = () => {
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

    // The layout height can stay at 1499px while only 682px is visible, even
    // after the width recovers. Keep fixed navigation inside the visible area.
    const height = window.visualViewport?.height ?? window.innerHeight;
    if (height > 0)
      root.style.setProperty("--sidebar-viewport-height", `${height}px`);
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
    window.clearTimeout(timer);
    timer = window.setTimeout(update, 300);
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
  schedule();

  return () => {
    listeners.abort();
    window.clearTimeout(timer);
    root.style.removeProperty("--sidebar-viewport-height");
    if (appliedWidth) viewport.content = original;
  };
}
