import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { request, type BrowsePage, type Item, type Program } from "../api";
import { Artwork } from "./artwork";
import { Button } from "./ui/button";
import { Skeleton } from "./ui/skeleton";
import "./search-page.css";

type SearchKind = "movie" | "series" | "live";
type Results = {
  items: Item[];
  page: number;
  hasMore: boolean;
  loading: boolean;
  error: string;
};
const sections = [
  { kind: "live", label: "Live TV", action: "live TV" },
  { kind: "movie", label: "Movies", action: "movies" },
  { kind: "series", label: "Shows", action: "shows" },
] as const;
const empty = (): Results => ({
  items: [],
  page: 0,
  hasMore: false,
  loading: false,
  error: "",
});
const initialResults = (): Record<SearchKind, Results> => ({
  movie: empty(),
  series: empty(),
  live: empty(),
});
const normalize = (text: string) =>
  text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

export type SearchPageProps = {
  value: string;
  onQueryChange: (value: string) => void;
  enabled: boolean;
  liveItems: Item[];
  currentPrograms?: Map<string, Program>;
  refreshRevision?: string;
  isVisible: (item: Item) => boolean;
  onOpen: (item: Item, button: HTMLButtonElement) => void;
  selectedItem: Item | null;
  selectedId: string;
  details: ReactNode;
  setCatalogGrid: (node: HTMLDivElement | null) => void;
  gridColumns: number;
};

export function SearchPage({
  value,
  onQueryChange,
  enabled,
  liveItems,
  currentPrograms,
  refreshRevision,
  isVisible,
  onOpen,
  selectedItem,
  selectedId,
  details,
  setCatalogGrid,
  gridColumns,
}: SearchPageProps) {
  const input = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const controllers = useRef(new Map<SearchKind, AbortController>());
  const [state, setState] = useState({
    query: "",
    started: false,
    results: initialResults(),
  });
  const valid = enabled && Array.from(value.trim()).length >= 2;
  const cancel = useCallback(() => {
    generation.current++;
    for (const controller of controllers.current.values()) controller.abort();
    controllers.current.clear();
  }, []);
  const loadPage = useCallback(
    (kind: "movie" | "series", page: number, query: string, run: number) => {
      const controller = new AbortController();
      controllers.current.get(kind)?.abort();
      controllers.current.set(kind, controller);
      const current = () =>
        !controller.signal.aborted && generation.current === run;
      const update = (apply: (previous: Results) => Results) =>
        setState((previous) =>
          current()
            ? {
                ...previous,
                results: {
                  ...previous.results,
                  [kind]: apply(previous.results[kind]),
                },
              }
            : previous,
        );
      update((previous) => ({ ...previous, loading: true, error: "" }));
      const params = new URLSearchParams({
        kind,
        category: "*",
        search: query,
        page: String(page),
      });
      void request<BrowsePage>(`/api/browse?${params}`, {
        signal: controller.signal,
      })
        .then((response) => {
          if (!current()) return;
          update((previous) => {
            const items = new Map(
              previous.items.map((item) => [item.id, item]),
            );
            for (const item of response.items || []) {
              if (item.kind === kind && isVisible(item))
                items.set(item.id, item);
            }
            return {
              items: [...items.values()],
              page: response.page || page,
              hasMore: !!response.hasMore,
              loading: false,
              error: "",
            };
          });
        })
        .catch((cause: unknown) => {
          update((previous) => ({
            ...previous,
            loading: false,
            error:
              cause instanceof Error
                ? cause.message
                : "Unable to load results.",
          }));
        })
        .finally(() => {
          if (controllers.current.get(kind) === controller)
            controllers.current.delete(kind);
        });
    },
    [isVisible],
  );

  useEffect(() => {
    cancel();
    const run = generation.current;
    setState({ query: value, started: false, results: initialResults() });
    if (!valid) return;
    const timer = window.setTimeout(() => {
      if (generation.current !== run) return;
      const query = value.trim();
      const terms = normalize(query).split(/\s+/).filter(Boolean);
      const live = liveItems.filter(
        (item) =>
          item.kind === "live" &&
          isVisible(item) &&
          terms.every((term) =>
            normalize(`${item.name} ${item.number || ""}`).includes(term),
          ),
      );
      setState({
        query: value,
        started: true,
        results: { ...initialResults(), live: { ...empty(), items: live } },
      });
      loadPage("movie", 1, query, run);
      loadPage("series", 1, query, run);
    }, 350);
    return () => {
      window.clearTimeout(timer);
      cancel();
    };
  }, [value, valid, refreshRevision, liveItems, isVisible, loadPage, cancel]);

  const changeQuery = (query: string) => {
    cancel();
    setState({ query, started: false, results: initialResults() });
    onQueryChange(query);
  };
  const showResults = valid && state.query === value && state.started;
  return (
    <div className="global-search-page">
      <div className="global-search-field">
        <MagnifyingGlassIcon size={28} weight="light" aria-hidden="true" />
        <input
          ref={input}
          autoFocus
          type="search"
          value={value}
          aria-label="Search library"
          placeholder="Search"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => changeQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") changeQuery("");
          }}
        />
        {value && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="global-search-clear"
            aria-label="Clear search"
            onClick={() => {
              changeQuery("");
              input.current?.focus();
            }}
          >
            <XIcon size={20} weight="light" aria-hidden="true" />
          </Button>
        )}
      </div>
      {showResults &&
        sections.map(({ kind, label, action }) => {
          const result = state.results[kind];
          const nextPage = () => {
            if (kind !== "live")
              loadPage(kind, result.page + 1, value.trim(), generation.current);
          };
          const items = result.items.filter(isVisible);
          const selectedIndex = items.findIndex(
            (item) => item.id === selectedId,
          );
          const columns = Math.max(1, gridColumns);
          const rowEnd = Math.min(
            items.length - 1,
            Math.ceil((selectedIndex + 1) / columns) * columns - 1,
          );
          const active = selectedItem?.kind === kind;
          return (
            <section
              key={kind}
              className="global-search-section"
              aria-label={`${label} results`}
            >
              <h2>{label}</h2>
              <div
                ref={active ? setCatalogGrid : undefined}
                className={`catalog-grid global-search-grid${kind === "live" ? " live-grid" : ""}`}
              >
                {items.map((item, index) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`media-card kind-${kind}${selectedId === item.id ? " selected" : ""}`}
                    style={{ order: index * 2 }}
                    aria-label={`Open ${item.name}`}
                    aria-expanded={selectedId === item.id}
                    aria-controls={
                      selectedId === item.id
                        ? "inline-title-details"
                        : undefined
                    }
                    onClick={(event) => onOpen(item, event.currentTarget)}
                  >
                    <div className="card-art">
                      <Artwork item={item} />
                    </div>
                    <div className="card-content">
                      <div className="card-title-row">
                        <h3>{item.name}</h3>
                      </div>
                      {kind === "live" && item.number && (
                        <p className="card-metadata">Channel {item.number}</p>
                      )}
                      {kind !== "live" && item.category && (
                        <p className="card-metadata">{item.category}</p>
                      )}
                      {kind === "live" && currentPrograms?.get(item.id) && (
                        <p className="card-programme">
                          <span className="on-air-dot" aria-hidden="true" />
                          <span>{currentPrograms.get(item.id)?.title}</span>
                        </p>
                      )}
                    </div>
                  </button>
                ))}
                {active && selectedIndex >= 0 && (
                  <div
                    className="global-search-details"
                    style={{ order: rowEnd * 2 + 1 }}
                  >
                    {details}
                  </div>
                )}
              </div>
              {result.loading && (
                <div
                  className="global-search-loading"
                  role="status"
                  aria-label={`Loading ${action}`}
                >
                  {items.length ? (
                    <span>Loading…</span>
                  ) : (
                    Array.from({ length: 4 }, (_, index) => (
                      <Skeleton
                        key={index}
                        className="search-poster-skeleton"
                      />
                    ))
                  )}
                </div>
              )}
              {result.error && (
                <div className="global-search-error" role="alert">
                  <span>{result.error}</span>
                  <Button
                    variant="secondary"
                    aria-label={`Retry ${action}`}
                    onClick={nextPage}
                  >
                    Retry
                  </Button>
                </div>
              )}
              {!result.loading && !result.error && !items.length && (
                <p className="global-search-empty">No matches found.</p>
              )}
              {kind !== "live" && result.hasMore && !result.error && (
                <Button
                  variant="secondary"
                  className="global-search-more"
                  disabled={result.loading}
                  aria-label={`Load more ${action}`}
                  onClick={nextPage}
                >
                  Load more
                </Button>
              )}
            </section>
          );
        })}
    </div>
  );
}
