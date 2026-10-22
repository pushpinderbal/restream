const viewportCheckEvent = "restream:viewport-check";

export function requestViewportRecovery() {
  window.dispatchEvent(new Event(viewportCheckEvent));
}

/** Recover stale mobile viewport constraints after rotation or fullscreen playback. */
export function trackViewportOrientation() {
  const viewport = document.querySelector<HTMLMetaElement>(
    'meta[name="viewport"]',
  );
  const touch =
    navigator.maxTouchPoints > 0 ||
    window.matchMedia("(any-pointer: coarse)").matches;
  if (!viewport || !touch) return () => {};

  const content = viewport.content;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let frame = 0;
  let pending = false;
  let fullscreenExitPending = false;
  let nativeFullscreen: HTMLVideoElement | null = null;
  const fullscreenDocument = document as Document & {
    webkitFullscreenElement?: Element | null;
  };

  const restore = () => {
    viewport.content = content;
    frame = 0;
  };
  const resized = () => {
    if (pending) schedule();
  };
  const schedule = () => {
    pending = true;
    clearTimeout(timer);
    // Fullscreen and orientation events can precede iOS browser chrome resizing.
    timer = setTimeout(() => {
      if (nativeFullscreen && !nativeFullscreen.isConnected)
        nativeFullscreen = null;
      if (
        document.hidden ||
        document.fullscreenElement ||
        fullscreenDocument.webkitFullscreenElement ||
        nativeFullscreen
      )
        return;
      pending = false;
      const width = document.documentElement.clientWidth;
      const landscape = screen.orientation
        ? screen.orientation.type.startsWith("landscape")
        : Math.abs(window.orientation) === 90;
      const screenWidth = landscape
        ? Math.max(screen.width, screen.height)
        : Math.min(screen.width, screen.height);
      const scale = window.visualViewport?.scale ?? 1;
      // Fullscreen can leave the orientation reading stale as well as the viewport.
      const needsRecovery =
        (fullscreenExitPending || Math.abs(width - screenWidth) > 1) &&
        Math.abs(scale - 1) < 0.01;
      fullscreenExitPending = false;
      if (!needsRecovery) return;

      // Reapply device-width through a temporary explicit width. This asks the
      // browser to recalculate its viewport without reloading React or locking zoom.
      viewport.content = content.replace(
        /width\s*=\s*device-width/i,
        `width=${width}`,
      );
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(restore);
    }, 300);
  };
  const fullscreenChanged = () => {
    if (
      document.fullscreenElement ||
      fullscreenDocument.webkitFullscreenElement ||
      nativeFullscreen
    ) {
      clearTimeout(timer);
      if (frame) {
        cancelAnimationFrame(frame);
        restore();
      }
    } else {
      fullscreenExitPending = true;
      schedule();
    }
  };
  const nativeFullscreenBegan = (event: Event) => {
    if (!(event.target instanceof HTMLVideoElement)) return;
    nativeFullscreen = event.target;
    fullscreenChanged();
  };
  const nativeFullscreenEnded = () => {
    nativeFullscreen = null;
    fullscreenExitPending = true;
    schedule();
  };
  const visibilityChanged = () => {
    if (!document.hidden && pending) schedule();
  };

  const listeners = new AbortController();
  const options = { signal: listeners.signal };
  screen.orientation?.addEventListener("change", schedule, options);
  window.addEventListener("orientationchange", schedule, options);
  window.addEventListener(viewportCheckEvent, schedule, options);
  window.addEventListener("resize", resized, options);
  window.visualViewport?.addEventListener("resize", resized, options);
  document.addEventListener("fullscreenchange", fullscreenChanged, options);
  document.addEventListener(
    "webkitfullscreenchange",
    fullscreenChanged,
    options,
  );
  document.addEventListener("webkitbeginfullscreen", nativeFullscreenBegan, {
    ...options,
    capture: true,
  });
  document.addEventListener("webkitendfullscreen", nativeFullscreenEnded, {
    ...options,
    capture: true,
  });
  document.addEventListener("visibilitychange", visibilityChanged, options);
  return () => {
    listeners.abort();
    clearTimeout(timer);
    cancelAnimationFrame(frame);
    if (frame) restore();
  };
}
