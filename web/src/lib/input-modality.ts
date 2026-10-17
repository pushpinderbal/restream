// Native :focus-visible can survive focus restoration from a pointer-opened
// Radix menu. Keep decorative keyboard cues tied to the user's actual input.
export function trackInputModality() {
  const root = document.documentElement;
  const listeners = new AbortController();
  const options = { capture: true, signal: listeners.signal };
  root.dataset.inputModality = "keyboard";

  document.addEventListener(
    "pointerdown",
    () => {
      root.dataset.inputModality = "pointer";
    },
    options,
  );
  document.addEventListener(
    "keydown",
    (event) => {
      if (
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        ["Alt", "Control", "Meta", "Shift"].includes(event.key)
      )
        return;
      root.dataset.inputModality = "keyboard";
    },
    options,
  );

  return () => listeners.abort();
}
