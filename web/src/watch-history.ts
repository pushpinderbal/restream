import { useCallback, useEffect, useRef, useState } from "react";
import type { Item } from "./api";

const WATCH_HISTORY_KEY = "restream.watch-history.v1";
const perSectionLimit = 12;
const progressWriteInterval = 5000;
const kinds = ["live", "movie", "series"] as const;

export type WatchHistoryEntry = {
  title: Item;
  item: Item;
  watchedAt: number;
  position: number;
  duration: number;
  completed: boolean;
  updatedAt?: number;
};
type HistoryUndo = { id: number; label: string };
type HistoryState = { entries: WatchHistoryEntry[]; persistent: boolean };
type PlaybackSelection = { title: Item; item: Item };

function positiveNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function validTimestamp(value: unknown): value is number {
  return (
    positiveNumber(value) > 0 &&
    !Number.isNaN(new Date(value as number).getTime())
  );
}

/** History positions use the full source timeline, including any seek offset. */
export function isContinueWatching(entry: WatchHistoryEntry): boolean {
  return (
    entry.title.kind !== "live" &&
    !entry.completed &&
    entry.position >= 10 &&
    entry.duration > entry.position
  );
}

// Keep only display metadata and catalogue IDs, never stream URLs or sessions.
function historyItem(value: unknown): Item | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<Item>;
  if (
    typeof item.id !== "string" ||
    !item.id ||
    typeof item.name !== "string" ||
    ![...kinds, "episode"].includes(item.kind || "")
  )
    return null;
  return {
    id: item.id,
    kind: item.kind!,
    name: item.name,
    category: typeof item.category === "string" ? item.category : "",
    categoryId:
      typeof item.categoryId === "string" ? item.categoryId : undefined,
    image: typeof item.image === "string" ? item.image : undefined,
    season:
      Number.isInteger(item.season) && item.season! > 0
        ? item.season
        : undefined,
    episode:
      Number.isInteger(item.episode) && item.episode! > 0
        ? item.episode
        : undefined,
  };
}

function validEntry(value: unknown): WatchHistoryEntry | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Partial<WatchHistoryEntry>;
  const title = historyItem(entry.title);
  const item = historyItem(entry.item);
  if (
    !title ||
    !item ||
    title.kind === "episode" ||
    (title.kind === "series"
      ? item.kind !== "episode"
      : item.kind !== title.kind || item.id !== title.id) ||
    !validTimestamp(entry.watchedAt)
  )
    return null;
  const live = title.kind === "live";
  const duration = live ? 0 : positiveNumber(entry.duration);
  const position = live ? 0 : positiveNumber(entry.position);
  return {
    title,
    item,
    watchedAt: entry.watchedAt,
    position: duration > 0 ? Math.min(position, duration) : position,
    duration,
    completed: !live && entry.completed === true,
    updatedAt: validTimestamp(entry.updatedAt)
      ? entry.updatedAt
      : entry.watchedAt,
  };
}

function recentEntries(entries: WatchHistoryEntry[]) {
  const seen = new Set<string>();
  const counts = { live: 0, movie: 0, series: 0 };
  return [...entries]
    .sort((a, b) => b.watchedAt - a.watchedAt)
    .filter((entry) => {
      const kind = entry.title.kind as keyof typeof counts;
      const key = `${kind}:${entry.title.id}`;
      if (seen.has(key) || counts[kind] >= perSectionLimit) return false;
      seen.add(key);
      counts[kind]++;
      return true;
    });
}

function readHistory(storageKey: string): HistoryState {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(storageKey);
  } catch {
    return { entries: [], persistent: false };
  }
  try {
    const saved = raw ? JSON.parse(raw) : null;
    const entries =
      saved?.version === 1 && Array.isArray(saved.entries)
        ? saved.entries.map(validEntry).filter(Boolean)
        : [];
    return { entries: recentEntries(entries), persistent: true };
  } catch {
    return { entries: [], persistent: true };
  }
}

export function useWatchHistory(userId?: string) {
  const storageKey = userId
    ? `${WATCH_HISTORY_KEY}.user.${encodeURIComponent(userId)}`
    : WATCH_HISTORY_KEY;
  const [state, setState] = useState(() => readHistory(storageKey));
  const current = useRef(state);
  const pendingFlush = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(false);
  const lastWrite = useRef(0);
  const [pendingUndo, setPendingUndo] = useState<HistoryUndo | null>(null);
  const removedEntries = useRef<WatchHistoryEntry[]>([]);
  const undoSequence = useRef(0);

  const dismissUndo = useCallback(() => {
    removedEntries.current = [];
    setPendingUndo(null);
  }, []);

  const persist = useCallback(
    (entries: WatchHistoryEntry[]) => {
      if (pendingFlush.current !== null) clearTimeout(pendingFlush.current);
      pendingFlush.current = null;
      dirty.current = false;
      lastWrite.current = Date.now();
      let persistent = true;
      try {
        if (entries.length)
          window.localStorage.setItem(
            storageKey,
            JSON.stringify({ version: 1, entries }),
          );
        else window.localStorage.removeItem(storageKey);
      } catch {
        persistent = false;
      }
      current.current = { entries, persistent };
      setState(current.current);
    },
    [storageKey],
  );

  const update = useCallback(
    (change: (entries: WatchHistoryEntry[]) => WatchHistoryEntry[]) =>
      persist(recentEntries(change(current.current.entries))),
    [persist],
  );

  const flushProgress = useCallback(() => {
    if (pendingFlush.current !== null) clearTimeout(pendingFlush.current);
    pendingFlush.current = null;
    if (dirty.current) persist(current.current.entries);
  }, [persist]);

  useEffect(() => {
    const restore = (event: StorageEvent) => {
      if (event.key !== storageKey && event.key !== null) return;
      // A clear/remove in another tab wins over this tab's pending progress.
      if (pendingFlush.current !== null) clearTimeout(pendingFlush.current);
      pendingFlush.current = null;
      dirty.current = false;
      // Another tab explicitly clearing history also cancels restoration.
      if (event.key === null || event.newValue === null) dismissUndo();
      current.current = readHistory(storageKey);
      setState(current.current);
    };
    const hide = () => {
      if (document.visibilityState === "hidden") flushProgress();
    };
    window.addEventListener("storage", restore);
    window.addEventListener("pagehide", flushProgress);
    document.addEventListener("visibilitychange", hide);
    return () => {
      window.removeEventListener("storage", restore);
      window.removeEventListener("pagehide", flushProgress);
      document.removeEventListener("visibilitychange", hide);
      flushProgress();
    };
  }, [dismissUndo, flushProgress, storageKey]);

  const record = useCallback(
    (selection: PlaybackSelection) => {
      const previous = current.current.entries.find(
        (entry) =>
          entry.title.id === selection.title.id &&
          entry.title.kind === selection.title.kind &&
          entry.item.id === selection.item.id,
      );
      const entry = validEntry({
        ...selection,
        watchedAt: Date.now(),
        updatedAt: Date.now(),
        position: previous?.position ?? 0,
        duration: previous?.duration ?? positiveNumber(selection.item.duration),
        completed: previous?.completed ?? false,
      });
      if (entry)
        update((entries) => [
          entry,
          ...entries.filter(
            (value) =>
              value.title.id !== entry.title.id ||
              value.title.kind !== entry.title.kind,
          ),
        ]);
    },
    [update],
  );

  const updateProgress = useCallback(
    (
      selection: PlaybackSelection,
      position: number,
      duration: number,
      completed?: boolean,
    ) => {
      if (
        selection.title.kind === "live" ||
        !Number.isFinite(position) ||
        position < 0
      )
        return;
      const index = current.current.entries.findIndex(
        (entry) =>
          entry.title.id === selection.title.id &&
          entry.title.kind === selection.title.kind &&
          entry.item.id === selection.item.id,
      );
      // Seeking or timeupdate after clearing history must not recreate it.
      if (index < 0) return;
      const entry = current.current.entries[index];
      const sourceDuration = positiveNumber(duration) || entry.duration;
      const sourcePosition =
        sourceDuration > 0 ? Math.min(position, sourceDuration) : position;
      const nearEnd =
        sourceDuration >= 60 &&
        sourcePosition >= sourceDuration * 0.95 &&
        sourceDuration - sourcePosition <= 120;
      const isCompleted = completed === true || nearEnd;
      if (
        entry.position === sourcePosition &&
        entry.duration === sourceDuration &&
        entry.completed === isCompleted
      )
        return;
      const entries = [...current.current.entries];
      entries[index] = {
        ...entry,
        position: sourcePosition,
        duration: sourceDuration,
        completed: isCompleted,
        updatedAt: Date.now(),
      };
      current.current = { ...current.current, entries };
      dirty.current = true;
      const remaining =
        progressWriteInterval - (Date.now() - lastWrite.current);
      if (remaining <= 0) flushProgress();
      else if (pendingFlush.current === null)
        pendingFlush.current = setTimeout(flushProgress, remaining);
    },
    [flushProgress],
  );
  const remove = useCallback(
    (entry: WatchHistoryEntry) => {
      const removed = current.current.entries.filter(
        (value) =>
          value.title.id === entry.title.id &&
          value.title.kind === entry.title.kind,
      );
      if (!removed.length) return;
      removedEntries.current = removed;
      setPendingUndo({
        id: ++undoSequence.current,
        label: "Removed from history",
      });
      update((entries) => entries.filter((value) => !removed.includes(value)));
    },
    [update],
  );
  const clear = useCallback(() => {
    if (!current.current.entries.length) return;
    removedEntries.current = [...current.current.entries];
    setPendingUndo({ id: ++undoSequence.current, label: "History cleared" });
    update(() => []);
  }, [update]);

  const undoRemoval = useCallback(() => {
    const removed = removedEntries.current;
    if (!removed.length) return;
    const saved = readHistory(storageKey);
    // An external clear may arrive before its storage event. Respect it even
    // when this tab still has the previous entries in memory.
    if (
      saved.persistent &&
      current.current.persistent &&
      !saved.entries.length &&
      current.current.entries.length
    ) {
      dismissUndo();
      return;
    }
    // Read storage again in case another tab wrote before its storage event
    // arrived. Keep locally buffered progress only for entries still present.
    const entries =
      saved.persistent && current.current.persistent
        ? saved.entries
        : current.current.entries;
    const merged = entries.map((entry) => {
      const local = current.current.entries.find(
        (value) =>
          value.title.id === entry.title.id &&
          value.title.kind === entry.title.kind,
      );
      return dirty.current &&
        local &&
        (local.updatedAt ?? local.watchedAt) >
          (entry.updatedAt ?? entry.watchedAt)
        ? local
        : entry;
    });
    // Existing entries always win: a later playback may use another episode
    // or a newer position for the same title.
    const present = new Set(
      merged.map((entry) => `${entry.title.kind}:${entry.title.id}`),
    );
    persist(
      recentEntries([
        ...merged,
        ...removed.filter(
          (entry) => !present.has(`${entry.title.kind}:${entry.title.id}`),
        ),
      ]),
    );
    dismissUndo();
  }, [dismissUndo, persist, storageKey]);

  return {
    ...state,
    pendingUndo,
    record,
    updateProgress,
    flushProgress,
    remove,
    clear,
    undoRemoval,
    dismissUndo,
  };
}
