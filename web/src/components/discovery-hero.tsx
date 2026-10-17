import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { DiscoveryTitle, Item } from "../api";
import { isContinueWatching, type WatchHistoryEntry } from "../watch-history";
import { PlayButton } from "./ui/play-button";
import { Spinner } from "./spectrumui/spinner-dependencies";

type HeroTitle = DiscoveryTitle & { resume?: WatchHistoryEntry };

function shuffled(values: string[]) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index--) {
    const other = Math.floor(Math.random() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

function artwork(title?: DiscoveryTitle) {
  return title?.backdrop || title?.poster || title?.item.image;
}

export function DiscoveryHero({
  titles,
  history,
  configured,
  opening,
  onPlay,
  onResume,
  children,
}: {
  titles: DiscoveryTitle[];
  history: WatchHistoryEntry[];
  configured: boolean;
  opening: string;
  onPlay: (item: Item) => void;
  onResume: (entry: WatchHistoryEntry) => void;
  children: ReactNode;
}) {
  const reducedMotion = useReducedMotion();
  const element = useRef<HTMLDivElement>(null);
  const [order, setOrder] = useState<string[]>([]);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [visible, setVisible] = useState(!document.hidden);
  const [inView, setInView] = useState(true);
  const candidates = useMemo(() => {
    const values = new Map<string, HeroTitle>();
    for (const title of titles) values.set(title.item.id, title);
    for (const entry of history.filter(isContinueWatching)) {
      const metadata = values.get(entry.title.id);
      values.set(entry.title.id, {
        ...metadata,
        item: metadata?.item || entry.title,
        name: metadata?.name || entry.title.name,
        resume: entry,
      });
    }
    return [...values.values()];
  }, [titles, history]);

  useEffect(() => {
    const available = new Set(candidates.map((title) => title.item.id));
    setOrder((current) => {
      const retained = current.filter((id) => available.has(id));
      const added = [...available].filter((id) => !current.includes(id));
      if (retained.length === current.length && !added.length) return current;
      if (retained.length) return [...retained, ...shuffled(added)];
      const first =
        candidates.find((title) => title.resume) ||
        candidates.find((title) => title.backdrop) ||
        candidates[0];
      return first
        ? [
            first.item.id,
            ...shuffled(added.filter((id) => id !== first.item.id)),
          ]
        : [];
    });
  }, [candidates]);

  const next = useCallback(() => {
    setOrder((current) =>
      current.length > 1 ? [...current.slice(1), current[0]] : current,
    );
  }, []);
  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", update);
    const observer = new IntersectionObserver(([entry]) =>
      setInView(entry.isIntersecting),
    );
    if (element.current) observer.observe(element.current);
    return () => {
      document.removeEventListener("visibilitychange", update);
      observer.disconnect();
    };
  }, []);
  useEffect(() => {
    if (
      order.length < 2 ||
      hovered ||
      focused ||
      !visible ||
      !inView ||
      reducedMotion ||
      opening ||
      !configured
    )
      return;
    const timer = window.setTimeout(next, 8000);
    return () => window.clearTimeout(timer);
  }, [
    order,
    hovered,
    focused,
    visible,
    inView,
    reducedMotion,
    opening,
    configured,
    next,
  ]);

  const feature =
    candidates.find((title) => title.item.id === order[0]) ||
    candidates.find((title) => title.resume) ||
    candidates.find((title) => title.backdrop) ||
    candidates[0];
  const nextArtwork = artwork(
    candidates.find((title) => title.item.id === order[1]),
  );
  useEffect(() => {
    if (!nextArtwork) return;
    const image = new Image();
    image.decoding = "async";
    image.src = nextArtwork;
  }, [nextArtwork]);

  const image = artwork(feature);
  const resume = feature?.resume;
  const remaining = resume
    ? Math.ceil((resume.duration - resume.position) / 60)
    : 0;
  return (
    <div
      ref={element}
      className={`discovery-lead${candidates.length > 1 ? " discovery-carousel" : ""}`}
      role={candidates.length > 1 ? "region" : undefined}
      aria-roledescription={candidates.length > 1 ? "carousel" : undefined}
      aria-label={candidates.length > 1 ? "Featured titles" : undefined}
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") setHovered(true);
      }}
      onPointerLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setFocused(false);
      }}
    >
      <AnimatePresence initial={false}>
        {image && (
          <motion.div
            key={image}
            className="discovery-lead-art"
            aria-hidden="true"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reducedMotion ? 0 : 0.65 }}
          >
            <img
              src={image}
              alt=""
              decoding="async"
              onError={(event) => {
                event.currentTarget.style.visibility = "hidden";
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>
      {feature ? (
        <section
          className={`discovery-feature${feature.backdrop ? " has-backdrop" : ""}`}
          aria-label={`Featured ${feature.name}`}
          aria-live="off"
        >
          <AnimatePresence initial={false} mode="wait">
            <motion.div
              key={feature.item.id}
              className="discovery-feature-copy"
              initial={{ opacity: 0, y: reducedMotion ? 0 : 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: reducedMotion ? 0 : -4 }}
              transition={{ duration: reducedMotion ? 0 : 0.25 }}
            >
              <span className="discovery-eyebrow">
                {resume ? "Continue watching" : "Featured in your library"}
              </span>
              <h2>{feature.name}</h2>
              <div className="discovery-feature-meta">
                <span>{feature.item.kind === "series" ? "Show" : "Movie"}</span>
                {!!feature.year && <span>{feature.year}</span>}
                {!!feature.rating && (
                  <span>{feature.rating.toFixed(1)} / 10</span>
                )}
                {!!feature.genres?.length && (
                  <span>{feature.genres.slice(0, 2).join(" · ")}</span>
                )}
                {resume?.item.kind === "episode" && (
                  <span>
                    S{resume.item.season || 1} · E{resume.item.episode || 1}
                  </span>
                )}
                {resume && <span>{remaining} min left</span>}
              </div>
              {(feature.overview || feature.item.description) && (
                <p>{feature.overview || feature.item.description}</p>
              )}
              {resume && (
                <div
                  className="discovery-feature-progress"
                  role="progressbar"
                  aria-label="Watch progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(
                    (resume.position / resume.duration) * 100,
                  )}
                >
                  <span
                    style={{
                      width: `${(resume.position / resume.duration) * 100}%`,
                    }}
                  />
                </div>
              )}
              <div className="discovery-feature-actions">
                <PlayButton
                  size="lg"
                  icon={
                    opening === feature.item.id ? (
                      <Spinner size="small" className="app-spinner" />
                    ) : undefined
                  }
                  aria-label={`${resume ? "Continue watching" : "Play"} ${feature.name}`}
                  disabled={!configured || opening === feature.item.id}
                  aria-busy={opening === feature.item.id || undefined}
                  onClick={() =>
                    resume ? onResume(resume) : onPlay(feature.item)
                  }
                >
                  {opening === feature.item.id
                    ? "Opening…"
                    : resume
                      ? "Continue watching"
                      : "Play"}
                </PlayButton>
              </div>
            </motion.div>
          </AnimatePresence>
        </section>
      ) : (
        children
      )}
    </div>
  );
}
