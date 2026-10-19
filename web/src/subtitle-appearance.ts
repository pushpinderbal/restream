import { useSyncExternalStore, type CSSProperties } from "react";
import "./subtitle-appearance.css";

export const subtitleAppearanceOptions = {
  font: [
    { value: "sans", label: "Sans serif" },
    { value: "serif", label: "Serif" },
    { value: "mono", label: "Monospace" },
  ],
  size: [
    { value: "small", label: "Small" },
    { value: "medium", label: "Medium" },
    { value: "large", label: "Large" },
  ],
  color: [
    { value: "white", label: "White" },
    { value: "yellow", label: "Yellow" },
    { value: "cyan", label: "Cyan" },
  ],
  background: [
    { value: "dark", label: "Dark translucent" },
    { value: "solid", label: "Solid black" },
    { value: "none", label: "None" },
  ],
} as const;

export type SubtitleAppearance = {
  [
    Key in keyof typeof subtitleAppearanceOptions
  ]: (typeof subtitleAppearanceOptions)[Key][number]["value"];
};

export const defaultSubtitleAppearance: SubtitleAppearance = {
  font: "sans",
  size: "medium",
  color: "white",
  background: "dark",
};
const storageKey = "restream:subtitle-appearance";
const listeners = new Set<() => void>();
type Snapshot = {
  appearance: SubtitleAppearance;
  storageAvailable: boolean;
};
let snapshot: Snapshot | undefined;

function normalize(value: unknown): SubtitleAppearance {
  const next = { ...defaultSubtitleAppearance };
  if (!value || typeof value !== "object") return next;
  for (const key of Object.keys(next) as (keyof SubtitleAppearance)[]) {
    const candidate = (value as Record<string, unknown>)[key];
    if (subtitleAppearanceOptions[key].some(({ value }) => value === candidate))
      // The option table above validates the value for this particular key.
      Object.assign(next, { [key]: candidate });
  }
  return next;
}

function parse(value: string | null) {
  try {
    return normalize(value ? JSON.parse(value) : null);
  } catch {
    return { ...defaultSubtitleAppearance };
  }
}

function getSnapshot(): Snapshot {
  if (!snapshot) {
    try {
      snapshot = {
        appearance: parse(localStorage.getItem(storageKey)),
        storageAvailable: true,
      };
    } catch {
      snapshot = {
        appearance: { ...defaultSubtitleAppearance },
        storageAvailable: false,
      };
    }
  }
  return snapshot;
}

function publish(next: Snapshot) {
  snapshot = next;
  listeners.forEach((listener) => listener());
}

function storageChanged(event: StorageEvent) {
  if (event.key === storageKey || event.key === null)
    publish({ appearance: parse(event.newValue), storageAvailable: true });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    window.addEventListener("storage", storageChanged);
    // No component subscribes while the library is open. Pick up changes made
    // in another tab during that time without losing an in-memory fallback.
    const current = getSnapshot();
    if (current.storageAvailable) {
      try {
        const appearance = parse(localStorage.getItem(storageKey));
        if (JSON.stringify(appearance) !== JSON.stringify(current.appearance))
          publish({ appearance, storageAvailable: true });
      } catch {
        publish({ ...current, storageAvailable: false });
      }
    }
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.removeEventListener("storage", storageChanged);
  };
}

function updateAppearance(patch: Partial<SubtitleAppearance>) {
  const appearance = normalize({ ...getSnapshot().appearance, ...patch });
  let storageAvailable = true;
  try {
    localStorage.setItem(storageKey, JSON.stringify(appearance));
  } catch {
    storageAvailable = false;
  }
  // Settings and a mounted player update together, even when storage is denied.
  publish({ appearance, storageAvailable });
}

function resetAppearance() {
  let storageAvailable = true;
  try {
    localStorage.removeItem(storageKey);
  } catch {
    storageAvailable = false;
  }
  publish({ appearance: { ...defaultSubtitleAppearance }, storageAvailable });
}

const fonts = {
  sans: "Arial, Helvetica, sans-serif",
  serif: 'Georgia, "Times New Roman", serif',
  mono: '"Courier New", monospace',
};
const scales = { small: 0.8, medium: 1, large: 1.25 };
const colors = { white: "#ffffff", yellow: "#ffe56b", cyan: "#80edff" };
const backgrounds = {
  dark: "#000000cc",
  solid: "#000000",
  none: "transparent",
};

export function subtitleAppearanceStyle(
  appearance: SubtitleAppearance,
): CSSProperties {
  return {
    "--subtitle-font-family": fonts[appearance.font],
    "--subtitle-font-scale": scales[appearance.size],
    "--subtitle-color": colors[appearance.color],
    "--subtitle-background": backgrounds[appearance.background],
    "--subtitle-shadow": "0 1px 2px #000, 0 0 3px #000",
  } as CSSProperties;
}

export function useSubtitleAppearance() {
  const { appearance, storageAvailable } = useSyncExternalStore(
    subscribe,
    getSnapshot,
  );
  return {
    appearance,
    storageAvailable,
    style: subtitleAppearanceStyle(appearance),
    updateAppearance,
    resetAppearance,
  };
}
