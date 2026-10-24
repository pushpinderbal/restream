import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, request, type Item } from "./api";

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
  playbackId?: string;
};
type HistoryUndo = { id: number; label: string };
type HistoryState = {
  entries: WatchHistoryEntry[];
  persistent: boolean;
  pendingUndo: HistoryUndo | null;
};
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
    image:
      typeof item.image === "string" &&
      /^\/api\/(?:images\/[^/?#\\\s]+|discovery\/images\/[^/?#\\\s]+\/(?:poster|backdrop))(?:\?v=[0-9a-f]{16})?$/.test(
        item.image,
      )
        ? item.image
        : undefined,
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
    playbackId:
      typeof entry.playbackId === "string" ? entry.playbackId : undefined,
  };
}

function entryKey(entry: WatchHistoryEntry) {
  return `${entry.title.kind}:${entry.title.id}`;
}

function recentEntries(entries: WatchHistoryEntry[]) {
  const seen = new Set<string>();
  return [...entries]
    .sort((a, b) => b.watchedAt - a.watchedAt)
    .filter((entry) => {
      const key = entryKey(entry);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

type Snapshot = { entries: WatchHistoryEntry[]; scope: string; userId: string };
type Undo = HistoryUndo & { entries: WatchHistoryEntry[]; token?: string };
type Operation =
  | { type: "record"; entry: WatchHistoryEntry }
  | { type: "remove"; entry: WatchHistoryEntry; undo: Undo }
  | { type: "clear"; undo: Undo }
  | { type: "undo"; undo: Undo };

// One short-lived store per mounted account. Only progress is buffered; there is
// no browser persistence and no retry loop. A later focus or playback update can
// retry a failed progress write after the cooldown.
class HistoryStore {
  entries: WatchHistoryEntry[] = [];
  persistent = true;
  undo: Undo | null = null;
  private alive = true;
  private scope = "";
  private operations: Operation[] = [];
  private progress = new Map<string, WatchHistoryEntry>();
  private busy = false;
  private suspended = false;
  private refreshRequested = false;
  private flushRequested = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastWrite = 0;
  private retryAfter = 0;
  private sequence = 0;
  private progressSequence = 0;
  private acknowledgedSequence = 0;
  private writer: { key: string; itemId: string; playbackId: string } | null =
    null;
  private revision = 0;
  private controller = new AbortController();

  constructor(
    private userId: string,
    private publish: (state: HistoryState) => void,
  ) {}

  private emit() {
    if (this.alive)
      this.publish({
        entries: recentEntries(this.entries),
        persistent: this.persistent,
        pendingUndo: this.undo
          ? { id: this.undo.id, label: this.undo.label }
          : null,
      });
  }

  private async api<T>(
    path = "",
    method = "GET",
    body?: unknown,
    keepalive = false,
  ) {
    return request<T>(`/api/watch-history${path}`, {
      method,
      cache: "no-store",
      ...(body === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...body, scope: this.scope }),
          }),
      keepalive,
      signal: keepalive
        ? AbortSignal.timeout(15000)
        : AbortSignal.any([this.controller.signal, AbortSignal.timeout(15000)]),
    });
  }

  private applySnapshot(snapshot: Snapshot, revision: number) {
    // Focus can race AuthGate's cookie recheck. Do not display another account's
    // history, even briefly, or adopt its scope for a queued mutation.
    if (snapshot.userId !== this.userId) {
      this.operations = [];
      this.progress.clear();
      this.controller.abort();
      this.entries = [];
      this.undo = null;
      this.persistent = false;
      this.emit();
      return false;
    }
    if (this.scope && this.scope !== snapshot.scope) {
      this.operations = [];
      this.progress.clear();
      this.writer = null;
      this.undo = null;
      this.revision++;
      revision = this.revision;
    }
    this.scope = snapshot.scope;
    if (revision !== this.revision || this.operations.length > 0) {
      // A recovered initial GET may finish after actions were already queued.
      // Establish its scope now, then reconcile after those edits reach the server.
      this.refreshRequested = true;
      return true;
    }
    this.entries = recentEntries(
      snapshot.entries.map(validEntry).filter((entry) => entry !== null),
    ).map((entry) => {
      const key = entryKey(entry);
      const local = this.progress.get(key);
      if (local && local.playbackId === entry.playbackId) return local;
      this.progress.delete(key);
      return entry;
    });
    const present = new Set(this.entries.map(entryKey));
    for (const key of this.progress.keys())
      if (!present.has(key)) this.progress.delete(key);
    return true;
  }

  private enqueue(operation: Operation) {
    // Normal playback contributes one coalesced progress entry, never an action
    // per timeupdate. Bound explicit actions as well during a stalled network.
    if (this.operations.length >= 64) {
      this.refreshRequested = true;
      this.persistent = false;
      this.emit();
      return false;
    }
    this.operations.push(operation);
    void this.drain();
    return true;
  }

  refresh = () => {
    this.suspended = document.visibilityState === "hidden";
    this.refreshRequested = true;
    this.flushRequested = this.progress.size > 0;
    void this.drain();
  };

  private async drain() {
    if (!this.alive || this.busy) return;
    this.busy = true;
    try {
      while (this.alive) {
        if (!this.scope || (!this.operations.length && this.refreshRequested)) {
          this.refreshRequested = false;
          const revision = this.revision;
          const snapshot = await this.api<Snapshot>();
          if (!this.alive) return;
          if (!this.applySnapshot(snapshot, revision)) return;
          this.retryAfter = 0;
          this.persistent = true;
          this.emit();
          continue;
        }
        const operation = this.operations.shift();
        if (operation) {
          await this.perform(operation);
          if (!this.alive) return;
          this.retryAfter = 0;
          this.persistent = true;
          this.emit();
          continue;
        }
        if (this.flushRequested && Date.now() >= this.retryAfter) {
          this.flushRequested = false;
          for (const [key, entry] of [...this.progress]) {
            // A failed record has no server playback ID; the next refresh will
            // reconcile that optimistic entry rather than creating it as progress.
            if (!entry.playbackId || entry.playbackId.startsWith("local:")) {
              this.progress.delete(key);
              continue;
            }
            const body = this.progressBody(entry);
            const result = await this.api<{ entry: WatchHistoryEntry | null }>(
              "/progress",
              "PATCH",
              body,
            );
            if (!this.alive) return;
            this.acceptProgress(key, entry, result.entry, body.seq);
            this.lastWrite = Date.now();
            this.persistent = true;
            this.emit();
          }
          // Updates arriving during this batch wait for the next interval.
          if (this.progress.size && this.timer === null)
            this.timer = setTimeout(this.flushProgress, progressWriteInterval);
          continue;
        }
        break;
      }
    } catch (error) {
      if (this.alive) {
        this.persistent = false;
        this.retryAfter = Date.now() + 30000;
        this.refreshRequested = true;
        if (
          error instanceof ApiError &&
          (error.status === 401 || error.status === 409)
        ) {
          this.operations = [];
          this.progress.clear();
          this.writer = null;
          this.entries = [];
          this.scope = "";
          this.undo = null;
        }
        this.emit();
      }
    } finally {
      this.busy = false;
    }
  }

  private async perform(operation: Operation) {
    if (operation.type === "record") {
      const { playbackId: _localId, ...entry } = operation.entry;
      const result = await this.api<{ entry: WatchHistoryEntry }>(
        "/record",
        "POST",
        entry,
      );
      if (!this.alive) return;
      const current = this.entries.find(
        (value) => entryKey(value) === entryKey(operation.entry),
      );
      if (current && current.playbackId === operation.entry.playbackId) {
        const next = { ...current, playbackId: result.entry.playbackId };
        this.entries = this.entries.map((value) =>
          value === current ? next : value,
        );
        const key = entryKey(current);
        if (this.progress.has(key)) this.progress.set(key, next);
        if (
          this.writer &&
          this.writer.playbackId === operation.entry.playbackId
        )
          this.writer.playbackId = result.entry.playbackId!;
      }
      this.lastWrite = Date.now();
      return;
    }
    if (operation.type === "undo") {
      if (!operation.undo.token) return;
      const revision = this.revision;
      const snapshot = await this.api<Snapshot>("/undo", "POST", {
        undoToken: operation.undo.token,
      });
      if (this.alive) this.applySnapshot(snapshot, revision);
      return;
    }
    const body =
      operation.type === "remove"
        ? { kind: operation.entry.title.kind, id: operation.entry.title.id }
        : {};
    const result = await this.api<{ undoToken: string }>("", "DELETE", body);
    if (this.alive) operation.undo.token = result.undoToken;
  }

  private progressBody(entry: WatchHistoryEntry) {
    return {
      kind: entry.title.kind,
      id: entry.title.id,
      itemId: entry.item.id,
      playbackId: entry.playbackId,
      position: entry.position,
      duration: entry.duration,
      completed: entry.completed,
      seq: ++this.progressSequence,
    };
  }

  private acceptProgress(
    key: string,
    sent: WatchHistoryEntry,
    result: WatchHistoryEntry | null,
    seq: number,
  ) {
    if (this.progress.get(key) === sent) this.progress.delete(key);
    if (seq < this.acknowledgedSequence) return;
    this.acknowledgedSequence = seq;
    const local = this.entries.find((entry) => entryKey(entry) === key);
    if (!local || local.playbackId !== sent.playbackId) return;
    if (result === null) {
      // Another device removed this title or started a different episode.
      this.progress.delete(key);
      if (this.writer?.playbackId === sent.playbackId) this.writer = null;
      this.entries = this.entries.filter((entry) => entry !== local);
      this.refreshRequested = true;
    } else if (!this.progress.has(key))
      this.entries = this.entries.map((entry) =>
        entry === local ? result : entry,
      );
  }

  record = (selection: PlaybackSelection) => {
    const previous = this.entries.find(
      (entry) =>
        entry.title.kind === selection.title.kind &&
        entry.title.id === selection.title.id &&
        entry.item.id === selection.item.id,
    );
    const entry = validEntry({
      ...selection,
      watchedAt: Date.now(),
      updatedAt: Date.now(),
      position: previous?.position ?? 0,
      duration: previous?.duration ?? positiveNumber(selection.item.duration),
      completed: previous?.completed ?? false,
      playbackId: `local:${++this.sequence}`,
    });
    if (!entry || !this.alive) return;
    this.suspended = document.visibilityState === "hidden";
    this.revision++;
    this.progress.delete(entryKey(entry));
    this.writer = {
      key: entryKey(entry),
      itemId: entry.item.id,
      playbackId: entry.playbackId!,
    };
    this.entries = [
      entry,
      ...this.entries.filter((value) => entryKey(value) !== entryKey(entry)),
    ];
    this.emit();
    this.enqueue({ type: "record", entry });
  };

  updateProgress = (
    selection: PlaybackSelection,
    position: number,
    duration: number,
    completed?: boolean,
  ) => {
    if (
      !this.alive ||
      selection.title.kind === "live" ||
      !Number.isFinite(position) ||
      position < 0
    )
      return;
    const entry = this.entries.find(
      (entry) =>
        entry.title.kind === selection.title.kind &&
        entry.title.id === selection.title.id &&
        entry.item.id === selection.item.id,
    );
    if (
      !entry ||
      this.writer?.key !== entryKey(entry) ||
      this.writer.itemId !== selection.item.id ||
      this.writer.playbackId !== entry.playbackId
    )
      return;
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
    const next = {
      ...entry,
      position: sourcePosition,
      duration: sourceDuration,
      completed: isCompleted,
      updatedAt: Date.now(),
    };
    this.entries = this.entries.map((value) =>
      value === entry ? next : value,
    );
    this.progress.set(entryKey(next), next);
    const remaining = Math.max(
      progressWriteInterval - (Date.now() - this.lastWrite),
      this.retryAfter - Date.now(),
    );
    if (remaining <= 0) this.flushProgress();
    else if (this.timer === null)
      this.timer = setTimeout(this.flushProgress, remaining);
  };

  flushProgress = () => {
    if (this.suspended || document.visibilityState === "hidden") {
      this.flushForExit();
      return;
    }
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.flushRequested = this.progress.size > 0;
    void this.drain();
  };

  remove = (entry: WatchHistoryEntry) => {
    if (!this.entries.some((value) => entryKey(value) === entryKey(entry)))
      return;
    const undo: Undo = {
      id: ++this.sequence,
      label: "Removed from history",
      entries: this.entries.filter(
        (value) => entryKey(value) === entryKey(entry),
      ),
    };
    this.revision++;
    this.undo = undo;
    this.progress.delete(entryKey(entry));
    if (this.writer?.key === entryKey(entry)) this.writer = null;
    this.entries = this.entries.filter(
      (value) => entryKey(value) !== entryKey(entry),
    );
    this.emit();
    this.enqueue({ type: "remove", entry, undo });
  };

  clear = () => {
    if (!this.entries.length) return;
    const undo: Undo = {
      id: ++this.sequence,
      label: "History cleared",
      entries: this.entries,
    };
    this.revision++;
    this.undo = undo;
    this.progress.clear();
    this.writer = null;
    this.entries = [];
    this.emit();
    this.enqueue({ type: "clear", undo });
  };

  undoRemoval = () => {
    const undo = this.undo;
    if (!undo) return;
    this.revision++;
    const present = new Set(this.entries.map(entryKey));
    this.entries = recentEntries([
      ...this.entries,
      ...undo.entries.filter((entry) => !present.has(entryKey(entry))),
    ]);
    this.undo = null;
    this.emit();
    this.enqueue({ type: "undo", undo });
  };

  dismissUndo = () => {
    this.undo = null;
    this.emit();
  };

  flushForExit = () => {
    this.suspended = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (!this.scope) return;
    if (this.progress.size) this.lastWrite = Date.now();
    for (const [key, entry] of this.progress) {
      if (!entry.playbackId || entry.playbackId.startsWith("local:")) continue;
      const body = this.progressBody(entry);
      // This may overlap a normal request that was already sent. The server's
      // monotonic per-playback sequence makes the newest write win either order.
      void this.api<{ entry: WatchHistoryEntry | null }>(
        "/progress",
        "PATCH",
        body,
        true,
      )
        .then((result) => {
          if (!this.alive) return;
          this.acceptProgress(key, entry, result.entry, body.seq);
          this.persistent = true;
          this.emit();
        })
        .catch(() => {
          if (!this.alive) return;
          this.persistent = false;
          this.retryAfter = Date.now() + 30000;
          this.emit();
        });
    }
  };

  stop = () => {
    this.alive = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.controller.abort();
    // Never drain actions after an account switch. Only an acknowledged playback
    // receives a final best-effort write, bound to its original account scope.
    this.flushForExit();
    this.operations = [];
    this.progress.clear();
  };
}

export function useWatchHistory(userId = "") {
  const [state, setState] = useState<HistoryState>({
    entries: [],
    persistent: true,
    pendingUndo: null,
  });
  const store = useRef<HistoryStore | null>(null);
  useEffect(() => {
    const current = new HistoryStore(userId, setState);
    store.current = current;
    setState({ entries: [], persistent: true, pendingUndo: null });
    current.refresh();
    const visible = () => {
      if (document.visibilityState === "hidden") current.flushForExit();
      else current.refresh();
    };
    window.addEventListener("focus", current.refresh);
    window.addEventListener("pagehide", current.flushForExit);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("focus", current.refresh);
      window.removeEventListener("pagehide", current.flushForExit);
      document.removeEventListener("visibilitychange", visible);
      current.stop();
      if (store.current === current) store.current = null;
    };
  }, [userId]);
  // These callbacks stay stable: the player must not restart when history syncs.
  const record = useCallback(
    (selection: PlaybackSelection) => store.current?.record(selection),
    [],
  );
  const updateProgress = useCallback(
    (
      selection: PlaybackSelection,
      position: number,
      duration: number,
      completed?: boolean,
    ) =>
      store.current?.updateProgress(selection, position, duration, completed),
    [],
  );
  const flushProgress = useCallback(() => store.current?.flushProgress(), []);
  const remove = useCallback(
    (entry: WatchHistoryEntry) => store.current?.remove(entry),
    [],
  );
  const clear = useCallback(() => store.current?.clear(), []);
  const undoRemoval = useCallback(() => store.current?.undoRemoval(), []);
  const dismissUndo = useCallback(() => store.current?.dismissUndo(), []);
  return {
    ...state,
    record,
    updateProgress,
    flushProgress,
    remove,
    clear,
    undoRemoval,
    dismissUndo,
  };
}
