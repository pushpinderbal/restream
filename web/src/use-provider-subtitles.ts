import { useEffect, useRef, useState, type RefObject } from "react";
import { request, type Session, type SubtitleTrack } from "./api";

type Preference = { language?: string; label: string } | null;
type Cue = { start: number; end: number; text: string };
const preferenceKey = "restream:subtitles";
type EmbeddedTrack = { metadata: SubtitleTrack; native: TextTrack };
type CuePosition = Pick<VTTCue, "line" | "lineAlign" | "snapToLines">;

function cuePosition(cue: VTTCue): CuePosition {
  return {
    line: cue.line,
    lineAlign: cue.lineAlign,
    snapToLines: cue.snapToLines,
  };
}

function applyCaptionPosition(cue: VTTCue, position: CuePosition) {
  // Native cue setters can schedule cuechange even for equal assignments.
  if (cue.snapToLines !== position.snapToLines)
    cue.snapToLines = position.snapToLines;
  if (cue.lineAlign !== position.lineAlign) cue.lineAlign = position.lineAlign;
  if (cue.line !== position.line) cue.line = position.line;
}

function refreshCaptionPosition(
  cue: VTTCue,
  track: TextTrack,
  before: CuePosition,
  element: HTMLVideoElement,
) {
  if (
    (cue.line === before.line &&
      cue.lineAlign === before.lineAlign &&
      cue.snapToLines === before.snapToLines) ||
    track.mode !== "showing" ||
    element.currentTime < cue.startTime ||
    element.currentTime >= cue.endTime
  )
    return;
  // Chromium can retain an active cue's old layout after its coordinates
  // change. Re-inserting that same cue invalidates the cached display box.
  // Future cues render with their updated coordinates when they become active.
  try {
    track.removeCue(cue);
    track.addCue(cue);
  } catch {
    // Some native decoders may own a track that cannot be edited by script.
  }
}

function captionBottomLine(element: HTMLVideoElement, area: Element | null) {
  const height = Math.max(1, element.clientHeight);
  const padding = Math.min(36, Math.max(12, height * 0.05));
  const controls = area?.querySelector<HTMLElement>(".video-controls");
  const inset =
    controls && !area?.classList.contains("controls-hidden")
      ? Math.max(padding, controls.offsetHeight + 8)
      : padding;
  return Math.max(10, ((height - inset) / height) * 100);
}

function placeCaptionAbove(
  cue: VTTCue,
  bottomLine: number,
  videoHeight: number,
  blockHeight: number,
) {
  // Older Chromium ignores lineAlign. Use its default start alignment and
  // reserve the complete text block above the desired bottom edge ourselves.
  const position: CuePosition = {
    snapToLines: false,
    lineAlign: "start",
    line: Math.max(0, bottomLine - (blockHeight / videoHeight) * 100),
  };
  applyCaptionPosition(cue, position);
}

function captionMeasurer(element: HTMLVideoElement) {
  const probe = document.createElement("div");
  Object.assign(probe.style, {
    position: "fixed",
    left: "-100000px",
    top: "0",
    visibility: "hidden",
    pointerEvents: "none",
    margin: "0",
    padding: "0",
    border: "0",
    whiteSpace: "pre-line",
    overflowWrap: "break-word",
    fontFamily: "var(--subtitle-font-family, Arial, Helvetica, sans-serif)",
    // Match subtitle-appearance.css; ::cue computed styles are not exposed
    // consistently, so measure using the same inherited appearance variables.
    fontSize:
      "clamp(calc(14px * var(--subtitle-font-scale, 1)), calc(2vw * var(--subtitle-font-scale, 1)), calc(24px * var(--subtitle-font-scale, 1)))",
    lineHeight: "normal",
  });
  element.parentElement?.appendChild(probe);
  const cache = new WeakMap<VTTCue, { key: string; height: number }>();
  let fontKey = "";
  let lineHeight = 0;
  return {
    measure(cue: VTTCue) {
      const style = getComputedStyle(element);
      const nextFontKey = [
        element.clientWidth,
        window.innerWidth,
        style.getPropertyValue("--subtitle-font-family"),
        style.getPropertyValue("--subtitle-font-scale"),
      ].join("|");
      if (nextFontKey !== fontKey) {
        fontKey = nextFontKey;
        probe.style.width = `${Math.max(1, element.clientWidth)}px`;
        probe.textContent = "Mg";
        lineHeight = probe.getBoundingClientRect().height;
      }
      const position =
        typeof cue.position === "number"
          ? cue.position
          : cue.align === "left" || cue.align === "start"
            ? 0
            : cue.align === "right" || cue.align === "end"
              ? 100
              : 50;
      const positionAlign =
        "positionAlign" in VTTCue.prototype ? cue.positionAlign : "auto";
      const alignment =
        positionAlign === "auto"
          ? cue.align === "left" || cue.align === "start"
            ? "line-left"
            : cue.align === "right" || cue.align === "end"
              ? "line-right"
              : "center"
          : positionAlign;
      const available =
        alignment === "line-left"
          ? 100 - position
          : alignment === "line-right"
            ? position
            : 2 * Math.min(position, 100 - position);
      const width = Math.max(
        1,
        (element.clientWidth * Math.min(cue.size, available)) / 100,
      );
      const key = `${fontKey}|${width}|${cue.text}`;
      let measured = cache.get(cue);
      if (!measured || measured.key !== key) {
        probe.style.width = `${width}px`;
        probe.replaceChildren(cue.getCueAsHTML());
        measured = {
          key,
          height: Math.ceil(probe.getBoundingClientRect().height) + 2,
        };
        cache.set(cue, measured);
      }
      return { blockHeight: measured.height, lineHeight };
    },
    remove() {
      probe.remove();
    },
  };
}

function canonicalLanguage(language?: string) {
  if (!language) return "";
  try {
    // Intl also canonicalizes provider ISO-639 aliases such as eng -> en.
    return new Intl.Locale(language.replaceAll("_", "-")).language;
  } catch {
    return language.toLowerCase();
  }
}

function preferredTrack(tracks: SubtitleTrack[], preference: Preference) {
  if (!preference) return undefined;
  const language = canonicalLanguage(preference.language);
  return (
    tracks.find(
      (track) =>
        track.label === preference.label &&
        canonicalLanguage(track.language) === language,
    ) ||
    (language
      ? tracks.find((track) => canonicalLanguage(track.language) === language)
      : undefined)
  );
}

function savedPreference(): Preference {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(preferenceKey) || "null",
    );
    if (
      value &&
      typeof value === "object" &&
      "label" in value &&
      typeof value.label === "string"
    ) {
      return {
        label: value.label,
        language:
          "language" in value && typeof value.language === "string"
            ? value.language
            : undefined,
      };
    }
  } catch {
    /* Storage is optional. */
  }
  return null;
}

export function subtitleLabel(track: SubtitleTrack) {
  let language = track.language;
  try {
    if (language)
      language = new Intl.DisplayNames([navigator.language], {
        type: "language",
      }).of(language);
  } catch {
    /* Keep the provider's language label. */
  }
  const label =
    language && /^\w{2,3}(?:\s+t\d+)?$/i.test(track.label)
      ? language
      : track.label;
  const name = track.forced ? `${label} (forced)` : label;
  return track.source === "embedded" ? `${name} (embedded)` : name;
}

// Cues use the original movie timeline. Only presentation timestamps are shifted
// when a seek creates a new local video generation; the video itself is untouched.
export function useProviderSubtitles(
  video: RefObject<HTMLVideoElement | null>,
  session: Session | null,
  enabled: boolean,
) {
  const [preference, setPreference] = useState<Preference>(savedPreference);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("ready");
  const [attempt, setAttempt] = useState(0);
  const [failedProvider, setFailedProvider] = useState<string>();
  const [embedded, setEmbedded] = useState<EmbeddedTrack[]>([]);
  const [explicit, setExplicit] = useState<{ url: string; id: string }>();
  const providerElement = useRef<HTMLTrackElement | null>(null);
  const providerTracks = session?.subtitles || [];
  const tracks = [
    ...providerTracks,
    ...embedded.map((track) => track.metadata),
  ];
  const explicitTrack =
    explicit?.url === session?.url
      ? tracks.find((track) => track.id === explicit?.id)
      : undefined;
  const provider =
    explicitTrack?.source === "embedded"
      ? undefined
      : explicitTrack || preferredTrack(providerTracks, preference);
  const native =
    explicitTrack?.source === "embedded"
      ? explicitTrack
      : preferredTrack(
          embedded.map((track) => track.metadata),
          preference,
        );
  const selected =
    provider && provider.url !== failedProvider ? provider : native || provider;
  const offset = session?.subtitleOffset ?? session?.offset ?? 0;

  useEffect(() => {
    const element = video.current;
    if (!element || !enabled) {
      setEmbedded([]);
      return;
    }
    const update = () => {
      const found = Array.from(element.textTracks)
        .filter(
          (track) =>
            track !== providerElement.current?.track &&
            (track.kind === "captions" || track.kind === "subtitles"),
        )
        .map((native, index) => ({
          native,
          metadata: {
            id: `embedded-${index}`,
            label: native.label || "Closed captions",
            language: native.language || undefined,
            url: "",
            source: "embedded" as const,
          },
        }));
      setEmbedded((current) =>
        current.length === found.length &&
        current.every((track, index) => track.native === found[index].native)
          ? current
          : found,
      );
    };
    element.textTracks.addEventListener("addtrack", update);
    element.textTracks.addEventListener("removetrack", update);
    element.addEventListener("loadedmetadata", update);
    update();
    return () => {
      element.textTracks.removeEventListener("addtrack", update);
      element.textTracks.removeEventListener("removetrack", update);
      element.removeEventListener("loadedmetadata", update);
    };
  }, [video, session?.url, enabled]);

  useEffect(() => {
    for (const track of embedded) {
      track.native.mode =
        enabled && track.metadata.id === selected?.id ? "showing" : "hidden";
    }
    const track = providerElement.current?.track;
    if (track)
      track.mode =
        enabled && selected?.id === provider?.id ? "showing" : "hidden";
  }, [embedded, selected?.id, provider?.id, enabled]);

  useEffect(() => {
    const element = video.current;
    const native = embedded.find(
      (track) => track.metadata.id === selected?.id,
    )?.native;
    if (!element || !native || !enabled) return;
    const area = element.closest(".playback-area");
    const measurement = captionMeasurer(element);
    const originals = new Map<VTTCue, CuePosition>();
    const restore = () => {
      for (const [cue, original] of originals) {
        const before = cuePosition(cue);
        applyCaptionPosition(cue, original);
        refreshCaptionPosition(cue, native, before, element);
      }
      originals.clear();
    };
    const position = () => {
      const bottomLine = captionBottomLine(element, area);
      const height = Math.max(1, element.clientHeight);
      const currentCues = new Set(Array.from(native.cues || []));
      for (const cue of currentCues) {
        if (!(cue instanceof VTTCue)) continue;
        const before = cuePosition(cue);
        if (!originals.has(cue)) originals.set(cue, before);
        // Calculate from the original position without assigning it first:
        // restoring then moving an active cue can cause a cuechange loop.
        const original = originals.get(cue)!;
        if (cue.vertical) {
          applyCaptionPosition(cue, original);
          refreshCaptionPosition(cue, native, before, element);
          continue;
        }
        const { blockHeight, lineHeight } = measurement.measure(cue);
        let originalBottom = height;
        if (typeof original.line === "number") {
          const lineAlign =
            "lineAlign" in VTTCue.prototype ? original.lineAlign : "start";
          const belowAnchor =
            lineAlign === "end"
              ? 0
              : lineAlign === "center"
                ? blockHeight / 2
                : blockHeight;
          originalBottom = original.snapToLines
            ? original.line < 0
              ? height + (original.line + 1) * lineHeight
              : original.line * lineHeight + belowAnchor
            : (original.line / 100) * height + belowAnchor;
        }
        if (originalBottom > (bottomLine / 100) * height)
          placeCaptionAbove(cue, bottomLine, height, blockHeight);
        else applyCaptionPosition(cue, original);
        refreshCaptionPosition(cue, native, before, element);
      }
      // HLS.js owns cue eviction; don't retain its expired cue objects here.
      for (const [cue, original] of originals) {
        if (!currentCues.has(cue)) {
          applyCaptionPosition(cue, original);
          originals.delete(cue);
        }
      }
    };
    const resize = new ResizeObserver(position);
    resize.observe(element);
    const visibility = new MutationObserver(position);
    if (area)
      visibility.observe(area, {
        attributes: true,
        attributeFilter: ["class"],
      });
    if (element.parentElement)
      visibility.observe(element.parentElement, {
        attributes: true,
        attributeFilter: ["style"],
      });
    native.addEventListener("cuechange", position);
    element.addEventListener("timeupdate", position);
    position();
    return () => {
      resize.disconnect();
      visibility.disconnect();
      native.removeEventListener("cuechange", position);
      element.removeEventListener("timeupdate", position);
      restore();
      measurement.remove();
    };
  }, [video, embedded, selected?.id, enabled]);

  useEffect(() => {
    const element = video.current;
    setStatus("ready");
    if (!element || !enabled || !provider) return;
    const trackElement = document.createElement("track");
    providerElement.current = trackElement;
    trackElement.kind = "subtitles";
    trackElement.label = subtitleLabel(provider);
    trackElement.srclang = provider.language || "und";
    element.appendChild(trackElement);
    const track = trackElement.track;
    track.mode = "showing";
    const cues = new Map<string, VTTCue>();
    const area = element.closest(".playback-area");
    const measurement = captionMeasurer(element);
    const positionCues = () => {
      const bottomLine = captionBottomLine(element, area);
      const height = Math.max(1, element.clientHeight);
      for (const cue of cues.values()) {
        const before = cuePosition(cue);
        placeCaptionAbove(
          cue,
          bottomLine,
          height,
          measurement.measure(cue).blockHeight,
        );
        refreshCaptionPosition(cue, track, before, element);
      }
    };
    const resize = new ResizeObserver(positionCues);
    resize.observe(element);
    const visibility = new MutationObserver(positionCues);
    if (area)
      visibility.observe(area, {
        attributes: true,
        attributeFilter: ["class"],
      });
    if (element.parentElement)
      visibility.observe(element.parentElement, {
        attributes: true,
        attributeFilter: ["style"],
      });
    let controller: AbortController | undefined;
    let loadedBucket = -1;
    let pendingBucket = -1;
    let retryAfter = 0;
    let disposed = false;

    const load = () => {
      if (disposed || element.readyState === 0) return;
      const absolute = Math.max(0, offset + element.currentTime);
      const bucket = Math.floor(absolute / 30) * 30;
      // Retain a small window of cues, including when pausing or seeking locally.
      for (const [key, cue] of cues) {
        if (
          cue.endTime < element.currentTime - 60 ||
          cue.startTime > element.currentTime + 130
        ) {
          track.removeCue(cue);
          cues.delete(key);
        }
      }
      if (
        bucket === loadedBucket ||
        bucket === pendingBucket ||
        Date.now() < retryAfter
      )
        return;
      controller?.abort();
      const current = new AbortController();
      controller = current;
      pendingBucket = bucket;
      setStatus("loading");
      void request<{ cues: Cue[] }>(`${provider.url}?start=${bucket}`, {
        signal: current.signal,
      })
        .then((response) => {
          if (disposed || current.signal.aborted) return;
          for (const cue of response.cues) {
            if (
              !Number.isFinite(cue.start) ||
              !Number.isFinite(cue.end) ||
              cue.end <= offset ||
              cue.end <= cue.start
            )
              continue;
            const key = JSON.stringify([cue.start, cue.end, cue.text]);
            if (cues.has(key)) continue;
            const nativeCue = new VTTCue(
              Math.max(0, cue.start - offset),
              cue.end - offset,
              cue.text,
            );
            track.addCue(nativeCue);
            cues.set(key, nativeCue);
          }
          positionCues();
          loadedBucket = bucket;
          setFailedProvider(undefined);
          setStatus("ready");
        })
        .catch(() => {
          if (!disposed && !current.signal.aborted) {
            retryAfter = Date.now() + 5000;
            setFailedProvider(provider.url);
            setStatus("error");
          }
        })
        .finally(() => {
          if (controller === current) pendingBucket = -1;
        });
    };
    const metadataLoaded = () => {
      track.mode = "showing";
      loadedBucket = -1;
      load();
    };
    element.addEventListener("timeupdate", load);
    element.addEventListener("seeked", load);
    element.addEventListener("loadedmetadata", metadataLoaded);
    const retry = window.setInterval(load, 5000);
    load();
    return () => {
      disposed = true;
      controller?.abort();
      clearInterval(retry);
      resize.disconnect();
      visibility.disconnect();
      element.removeEventListener("timeupdate", load);
      element.removeEventListener("seeked", load);
      element.removeEventListener("loadedmetadata", metadataLoaded);
      track.mode = "disabled";
      trackElement.remove();
      measurement.remove();
      if (providerElement.current === trackElement)
        providerElement.current = null;
    };
  }, [video, provider?.url, session?.url, offset, enabled, attempt]);

  const select = (id: string | null) => {
    const track = tracks.find((value) => value.id === id);
    const next = track
      ? { language: track.language, label: track.label }
      : null;
    setPreference(next);
    setExplicit(
      track && session ? { url: session.url, id: track.id } : undefined,
    );
    setAttempt((value) => value + 1);
    try {
      localStorage.setItem(preferenceKey, JSON.stringify(next));
    } catch {
      /* Storage is optional. */
    }
  };
  return {
    tracks,
    selected: selected?.id || null,
    select,
    status,
    retry: () => setAttempt((value) => value + 1),
  };
}
