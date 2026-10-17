import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  loadBrowsePage,
  type BrowsePage,
  type Item,
  type Program,
} from "../api";
import { Artwork } from "./artwork";
import { BeamSearch } from "./spectrumui/beam-search";
import { LoadingButton } from "./spectrumui/loading-button";
import { AnimatedAlert } from "./spectrumui/animated-alert";
import { Skeleton } from "./ui/skeleton";
import { Spinner } from "./spectrumui/spinner-dependencies";
import InfiniteScroll from "./spectrumui/infinite-scroll";
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

type SearchPageProps = {
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
  const generation = useRef(0);
  const controllers = useRef(new Map<SearchKind, AbortController>());
  const pages = useRef(new Map<SearchKind, BrowsePage>());
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
    pages.current.clear();
  }, []);
  const loadPage = useCallback(
    (
      kind: "movie" | "series",
      page: number,
      query: string,
      run: number,
      refreshRange = false,
    ) => {
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
      update((previous) => ({ ...previous, loading: true }));
      const params = new URLSearchParams({
        kind,
        category: "*",
        search: query,
        page: String(page),
      });
      void loadBrowsePage(
        params,
        page,
        pages.current.get(kind) || null,
        controller.signal,
        (response) => {
          if (!current()) return;
          pages.current.set(kind, response);
          update(() => ({
            items: response.items.filter((item) => item.kind === kind),
            page: response.page || page,
            hasMore: !!response.hasMore,
            loading: true,
            error: "",
          }));
        },
        refreshRange,
      )
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
          update((previous) => ({ ...previous, loading: false }));
          if (controllers.current.get(kind) === controller)
            controllers.current.delete(kind);
        });
    },
    [],
  );

  useEffect(() => {
    cancel();
    const run = generation.current;
    setState({ query: value, started: false, results: initialResults() });
    if (!valid) return;
    const timer = window.setTimeout(() => {
      if (generation.current !== run) return;
      const query = value.trim();
      setState({ query: value, started: true, results: initialResults() });
      loadPage("movie", 1, query, run);
      loadPage("series", 1, query, run);
    }, 350);
    return () => {
      window.clearTimeout(timer);
      cancel();
    };
  }, [value, valid, loadPage, cancel]);

  useEffect(() => {
    if (!valid || !state.started || state.query !== value) return;
    const terms = normalize(value.trim()).split(/\s+/).filter(Boolean);
    const live = liveItems.filter(
      (item) =>
        item.kind === "live" &&
        isVisible(item) &&
        terms.every((term) =>
          normalize(`${item.name} ${item.number || ""}`).includes(term),
        ),
    );
    setState((previous) => ({
      ...previous,
      results: {
        ...previous.results,
        live: { ...empty(), items: live },
      },
    }));
  }, [value, valid, state.started, state.query, liveItems, isVisible]);

  const lastRevision = useRef(refreshRevision);
  useEffect(() => {
    const previous = lastRevision.current;
    lastRevision.current = refreshRevision;
    if (previous === refreshRevision || !valid) return;
    for (const kind of ["movie", "series"] as const)
      if (pages.current.has(kind))
        loadPage(kind, 1, value.trim(), generation.current, true);
  }, [refreshRevision, valid, value, loadPage]);

  const changeQuery = (query: string) => {
    cancel();
    setState({ query, started: false, results: initialResults() });
    onQueryChange(query);
  };
  const showResults = valid && state.query === value && state.started;
  const pagedKinds = ["movie", "series"] as const;
  const hasMore = pagedKinds.some(
    (kind) => state.results[kind].hasMore && !state.results[kind].error,
  );
  const loading = pagedKinds.some((kind) => state.results[kind].loading);
  return (
    <div className="global-search-page">
      <BeamSearch
        className="global-search-field"
        autoFocus
        value={value}
        ariaLabel="Search library"
        placeholder="Search"
        onChange={changeQuery}
      />
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
              {result.loading && !result.error && !items.length && (
                <div
                  className="global-search-loading"
                  role="status"
                  aria-label={`Loading ${action}`}
                >
                  {Array.from({ length: 4 }, (_, index) => (
                    <Skeleton key={index} className="search-poster-skeleton" />
                  ))}
                </div>
              )}
              {result.error && (
                <AnimatedAlert className="global-search-error" variant="error">
                  <span>{result.error}</span>
                  <LoadingButton
                    variant="secondary"
                    aria-label={`Retry ${action}`}
                    loading={result.loading}
                    loadingLabel="Retrying…"
                    onClick={nextPage}
                  >
                    Retry
                  </LoadingButton>
                </AnimatedAlert>
              )}
              {!result.loading &&
                !result.error &&
                !result.hasMore &&
                !items.length && (
                  <p className="global-search-empty">No matches found.</p>
                )}
            </section>
          );
        })}
      {showResults && hasMore && (
        <InfiniteScroll
          isLoading={loading}
          hasMore={hasMore}
          next={() => {
            for (const kind of pagedKinds) {
              const result = state.results[kind];
              if (result.hasMore && !result.loading && !result.error)
                loadPage(
                  kind,
                  result.page + 1,
                  value.trim(),
                  generation.current,
                );
            }
          }}
        >
          <div className="auto-loader">
            {loading && (
              <span role="status" aria-label="Loading more results">
                <Spinner size="small" className="app-spinner" />
              </span>
            )}
          </div>
        </InfiniteScroll>
      )}
    </div>
  );
}
