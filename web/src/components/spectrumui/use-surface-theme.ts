import { useSyncExternalStore } from "react";

export type SurfaceTheme = "auto" | "dark" | "light";

const darkQuery = "(prefers-color-scheme: dark)";

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  const mediaQuery = window.matchMedia(darkQuery);
  mediaQuery.addEventListener("change", onChange);
  return () => {
    observer.disconnect();
    mediaQuery.removeEventListener("change", onChange);
  };
}

function read(): "dark" | "light" {
  const classes = document.documentElement.classList;
  if (classes.contains("dark")) return "dark";
  if (classes.contains("light")) return "light";
  return window.matchMedia(darkQuery).matches ? "dark" : "light";
}

const onServer = () => "dark" as const;
const noSubscription = () => () => {};

export function useSurfaceTheme(
  theme: SurfaceTheme = "auto",
): "dark" | "light" {
  const resolved = useSyncExternalStore(
    theme === "auto" ? subscribe : noSubscription,
    read,
    onServer,
  );
  return theme === "auto" ? resolved : theme;
}
