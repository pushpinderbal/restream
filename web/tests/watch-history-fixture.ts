import type { Route } from "@playwright/test";
import type { Item } from "../src/api";

export type HistoryEntry = {
  title: Omit<Item, "kind"> & { kind: string };
  item: Omit<Item, "kind"> & { kind: string };
  watchedAt: number;
  updatedAt?: number;
  position: number;
  duration: number;
  completed: boolean;
  playbackId?: string;
};

// One fixture represents the server, so independent browser contexts can share
// account data without sharing cookies, localStorage, or browser events.
export function createHistoryFixture() {
  const accounts = new Map<string, HistoryEntry[]>();
  const key = (entry: HistoryEntry) => `${entry.title.kind}:${entry.title.id}`;
  const undo = new Map<
    string,
    { user: string; generation: number; entries: HistoryEntry[] }
  >();
  const generations = new Map<string, number>();
  const tombstones = new Map<string, string>();
  const sequences = new Map<string, number>();
  const tombstoneKey = (user: string, entry: HistoryEntry) =>
    `${user}:${key(entry)}`;
  const normalizeProgress = (entry: HistoryEntry) => {
    if (entry.title.kind === "live") {
      entry.position = 0;
      entry.duration = 0;
      entry.completed = false;
    } else {
      if (entry.duration > 0)
        entry.position = Math.min(entry.position, entry.duration);
      entry.completed ||=
        entry.duration >= 60 &&
        entry.position >= entry.duration * 0.95 &&
        entry.duration - entry.position <= 120;
    }
  };
  let nextId = 0;
  const read = (user = "shared") => structuredClone(accounts.get(user) ?? []);
  const seed = (entries: HistoryEntry[], user = "shared") => {
    for (const entry of entries) tombstones.delete(tombstoneKey(user, entry));
    accounts.set(
      user,
      structuredClone(entries).map((entry) => ({
        ...entry,
        playbackId: entry.playbackId ?? `seed-${++nextId}`,
      })),
    );
  };
  return {
    read,
    seed,
    async handle(route: Route, user = "shared") {
      const path = new URL(route.request().url()).pathname;
      if (!path.startsWith("/api/watch-history")) return false;
      const method = route.request().method();
      const body = route.request().postData()
        ? route.request().postDataJSON()
        : {};
      const scope = `provider:${user}`;
      const json = (value: unknown, status = 200) =>
        route.fulfill({ status, json: value });
      if (method !== "GET" && body.scope !== scope) {
        await json({ error: "Watch history scope changed" }, 409);
        return true;
      }
      let entries = read(user);
      if (path === "/api/watch-history" && method === "GET") {
        await json({ entries, scope, userId: user === "shared" ? "" : user });
      } else if (path.endsWith("/record") && method === "POST") {
        const entry = {
          ...body,
          watchedAt: Date.now(),
          playbackId: `playback-${++nextId}`,
          updatedAt: Date.now(),
        };
        delete entry.scope;
        normalizeProgress(entry);
        tombstones.delete(tombstoneKey(user, entry));
        entries = [
          entry,
          ...entries.filter((saved) => key(saved) !== key(entry)),
        ];
        accounts.set(user, entries);
        await json({ entry, scope });
      } else if (path.endsWith("/progress") && method === "PATCH") {
        const entry = entries.find(
          (saved) =>
            saved.title.kind === body.kind &&
            saved.title.id === body.id &&
            saved.item.id === body.itemId &&
            saved.playbackId === body.playbackId,
        );
        if (entry && body.seq > (sequences.get(entry.playbackId!) ?? 0)) {
          sequences.set(entry.playbackId!, body.seq);
          Object.assign(entry, {
            position: body.position,
            duration: body.duration,
            completed: body.completed,
            updatedAt: Date.now(),
          });
          normalizeProgress(entry);
          accounts.set(user, entries);
        }
        await json({ entry: entry ?? null, scope });
      } else if (path === "/api/watch-history" && method === "DELETE") {
        const removed = body.id
          ? entries.filter(
              (entry) =>
                entry.title.kind === body.kind && entry.title.id === body.id,
            )
          : entries;
        if (!body.id) generations.set(user, (generations.get(user) ?? 0) + 1);
        const undoToken = `undo-${++nextId}`;
        for (const entry of removed)
          tombstones.set(tombstoneKey(user, entry), undoToken);
        undo.set(undoToken, {
          user,
          generation: generations.get(user) ?? 0,
          entries: removed,
        });
        accounts.set(
          user,
          entries.filter(
            (entry) => !removed.some((removed) => key(entry) === key(removed)),
          ),
        );
        await json({ undoToken, scope });
      } else if (path.endsWith("/undo") && method === "POST") {
        const pending = undo.get(body.undoToken);
        if (
          pending?.user === user &&
          pending.generation === (generations.get(user) ?? 0)
        ) {
          const existing = new Set(entries.map(key));
          entries.push(
            ...pending.entries.filter(
              (entry) =>
                !existing.has(key(entry)) &&
                tombstones.get(tombstoneKey(user, entry)) === body.undoToken,
            ),
          );
          entries.sort((a, b) => b.watchedAt - a.watchedAt);
          accounts.set(user, entries);
          undo.delete(body.undoToken);
        }
        await json({ entries, scope, userId: user === "shared" ? "" : user });
      } else {
        await json({ error: "Unexpected history request" }, 404);
      }
      return true;
    },
  };
}
export type HistoryFixture = ReturnType<typeof createHistoryFixture>;
