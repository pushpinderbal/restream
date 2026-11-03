import { useCallback, useMemo, useState } from "react";
import type { Tab } from "./routing";

type Categories = Partial<Record<Tab, string>>;

function readCategories(storageKey: string): Categories {
  try {
    const saved: unknown = JSON.parse(
      localStorage.getItem(storageKey) || "null",
    );
    if (saved && typeof saved === "object") {
      return Object.fromEntries(
        ["live", "movie", "series"].flatMap((tab) => {
          const value = (saved as Record<string, unknown>)[tab];
          return typeof value === "string" && value ? [[tab, value]] : [];
        }),
      );
    }
  } catch {
    // Remember choices in memory when browser storage is unavailable.
  }
  return {};
}

export function useBrowsePreferences(userId?: string) {
  const storageKey = `restream:browse-categories:${userId ? `user:${userId}` : "anonymous"}`;
  const [categories, setCategories] = useState<Categories>(() =>
    readCategories(storageKey),
  );

  const rememberCategory = useCallback(
    (tab: Tab, category: string) => {
      if (categories[tab] === category) return;
      // Preserve other sections changed in another tab since this page opened.
      const next = {
        ...categories,
        ...readCategories(storageKey),
        [tab]: category,
      };
      setCategories(next);
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        // Browsing does not depend on storage being available.
      }
    },
    [categories, storageKey],
  );

  return useMemo(
    () => ({ categories, rememberCategory }),
    [categories, rememberCategory],
  );
}
