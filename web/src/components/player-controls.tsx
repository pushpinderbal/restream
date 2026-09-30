import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { motion } from "motion/react";
import { Slider } from "radix-ui";
import {
  Maximize2,
  Minimize2,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Volume2,
  VolumeX,
} from "lucide-react";

type Props = {
  area: RefObject<HTMLDivElement | null>;
  playing: boolean;
  muted: boolean;
  busy: boolean;
  finished: boolean;
  position: number;
  duration: number;
  buffered: { start: number; end: number }[];
  live: boolean;
  liveDelay: number | null;
  onGoLive: () => void;
  onPlay: () => void;
  onSeek: (position: number) => void;
  onMute: () => void;
  onFullscreen: () => void;
};

function time(seconds: number) {
  const value = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${value >= 3600 ? `${Math.floor(value / 3600)}:` : ""}${String(Math.floor(value / 60) % 60).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

export function PlayerControls(props: Props) {
  const {
    area,
    playing,
    busy,
    finished,
    live,
    position,
    duration,
    onPlay,
    onSeek,
    onMute,
    onFullscreen,
  } = props;
  const [visible, setVisible] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [preview, setPreview] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const actions = useRef(props);
  actions.current = props;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scrubbing = useRef(false);
  const canSeek = !live && duration > 0 && !busy && !finished;
  const reveal = useCallback(() => {
    setVisible(true);
    clearTimeout(timer.current);
    if (playing && !busy && !finished) {
      timer.current = setTimeout(() => {
        if (scrubbing.current || area.current?.querySelector(":focus-visible"))
          return;
        setVisible(false);
      }, 2600);
    }
  }, [playing, busy, finished, area]);

  useEffect(() => {
    const element = area.current;
    if (!element) return;
    reveal();
    const leave = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      if (
        playing &&
        !busy &&
        !scrubbing.current &&
        !element.querySelector(":focus-visible")
      ) {
        clearTimeout(timer.current);
        setVisible(false);
      }
    };
    const leaveFocus = () => {
      clearTimeout(timer.current);
      if (playing && !busy && !finished) {
        timer.current = setTimeout(() => {
          if (!scrubbing.current && !element.querySelector(":focus-visible"))
            setVisible(false);
        }, 2600);
      }
    };
    const keyboard = (event: KeyboardEvent) => {
      reveal();
      if (
        (event.target as HTMLElement).closest('[role="slider"], input, select')
      )
        return;
      if (
        (event.target as HTMLElement).closest("button") &&
        (event.key === " " || event.key === "Enter")
      )
        return;
      if (event.key === " " || event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (!busy && !finished) actions.current.onPlay();
      } else if (
        (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
        canSeek
      ) {
        event.preventDefault();
        actions.current.onSeek(
          actions.current.position + (event.key === "ArrowRight" ? 10 : -10),
        );
      } else if (event.key.toLowerCase() === "f")
        actions.current.onFullscreen();
      else if (event.key.toLowerCase() === "m") actions.current.onMute();
    };
    const fullscreenChange = () => {
      setFullscreen(!!document.fullscreenElement);
      reveal();
    };
    element.addEventListener("pointermove", reveal);
    element.addEventListener("pointerdown", reveal);
    element.addEventListener("pointerleave", leave);
    element.addEventListener("focusin", reveal);
    element.addEventListener("focusout", leaveFocus);
    element.addEventListener("keydown", keyboard);
    document.addEventListener("fullscreenchange", fullscreenChange);
    return () => {
      clearTimeout(timer.current);
      element.removeEventListener("pointermove", reveal);
      element.removeEventListener("pointerdown", reveal);
      element.removeEventListener("pointerleave", leave);
      element.removeEventListener("focusin", reveal);
      element.removeEventListener("focusout", leaveFocus);
      element.removeEventListener("keydown", keyboard);
      document.removeEventListener("fullscreenchange", fullscreenChange);
    };
  }, [area, reveal, playing, busy, finished, canSeek]);

  useEffect(() => {
    area.current?.classList.toggle("controls-hidden", !visible);
    return () => {
      area.current?.classList.remove("controls-hidden");
    };
  }, [area, visible]);

  // Keep listeners and the inactivity deadline stable while the clock advances.
  const value = preview ?? position;
  return (
    <motion.div
      className="video-controls"
      data-visible={visible}
      inert={!visible}
      initial={false}
      animate={{ opacity: visible ? 1 : 0, y: visible ? 0 : 12 }}
      transition={{ duration: 0.24, ease: "easeOut" }}
      style={{ pointerEvents: visible ? "auto" : "none" }}
    >
      {!live && (
        <div
          className="timeline-shell"
          onPointerMove={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            setHover(
              Math.max(
                0,
                Math.min(
                  duration,
                  ((event.clientX - bounds.left) / bounds.width) * duration,
                ),
              ),
            );
          }}
          onPointerLeave={() => setHover(null)}
        >
          {(hover !== null || preview !== null) && canSeek && (
            <span
              className="scrub-preview"
              style={{
                left: `${Math.max(4, Math.min(96, ((preview ?? hover ?? 0) / duration) * 100))}%`,
              }}
            >
              {time(preview ?? hover ?? 0)}
            </span>
          )}
          <Slider.Root
            className="timeline"
            min={0}
            max={Math.max(1, duration)}
            step={1}
            value={[Math.min(value, Math.max(1, duration))]}
            disabled={!canSeek}
            onValueChange={([next]) => {
              scrubbing.current = true;
              setPreview(next);
              reveal();
            }}
            onValueCommit={([next]) => {
              scrubbing.current = false;
              setPreview(null);
              onSeek(next);
              reveal();
            }}
            onPointerCancel={() => {
              scrubbing.current = false;
              setPreview(null);
              reveal();
            }}
          >
            <Slider.Track className="timeline-track">
              {props.buffered.map((range, i) => (
                <span
                  key={i}
                  className="timeline-buffer"
                  style={{
                    left: `${(range.start / Math.max(1, duration)) * 100}%`,
                    width: `${(Math.max(0, Math.min(duration, range.end) - range.start) / Math.max(1, duration)) * 100}%`,
                  }}
                />
              ))}
              <Slider.Range className="timeline-progress" />
            </Slider.Track>
            <Slider.Thumb
              className="timeline-thumb"
              aria-label="Seek position"
              aria-valuetext={time(value)}
            />
          </Slider.Root>
        </div>
      )}
      <div className="controls-row">
        <button
          className="control-button primary-control"
          onClick={onPlay}
          aria-label={playing ? "Pause" : "Play"}
          title={playing ? "Pause (Space)" : "Play (Space)"}
          disabled={busy || finished}
        >
          {playing ? (
            <Pause size={25} strokeWidth={1.5} />
          ) : (
            <Play size={25} strokeWidth={1.5} />
          )}
        </button>
        {!live && (
          <>
            <button
              className="control-button seek-control"
              aria-label="Back 10 seconds"
              title="Back 10 seconds (←)"
              disabled={!canSeek}
              onClick={() => onSeek(position - 10)}
            >
              <RotateCcw size={29} strokeWidth={1.5} />
              <span>10</span>
            </button>
            <button
              className="control-button seek-control"
              aria-label="Forward 10 seconds"
              title="Forward 10 seconds (→)"
              disabled={!canSeek}
              onClick={() => onSeek(position + 10)}
            >
              <RotateCw size={29} strokeWidth={1.5} />
              <span>10</span>
            </button>
          </>
        )}
        <button
          className="control-button"
          onClick={onMute}
          aria-label={props.muted ? "Unmute" : "Mute"}
          title="Mute (M)"
        >
          {props.muted ? (
            <VolumeX size={23} strokeWidth={1.5} />
          ) : (
            <Volume2 size={23} strokeWidth={1.5} />
          )}
        </button>
        {live ? (
          <button
            type="button"
            className="live-badge"
            data-behind={props.liveDelay !== null && props.liveDelay > 15}
            disabled={busy || finished || props.liveDelay === null}
            onClick={props.onGoLive}
            aria-label="Go to live"
            title={
              props.liveDelay !== null && props.liveDelay > 15
                ? `${time(props.liveDelay)} behind · Go to live`
                : "Go to live"
            }
          >
            <span aria-hidden="true">●</span> LIVE
          </button>
        ) : (
          <span className="time-readout">
            {time(value)} <span>/ {time(duration)}</span>
          </span>
        )}
        <button
          className="control-button fullscreen"
          onClick={onFullscreen}
          aria-label={fullscreen ? "Exit full screen" : "Full screen"}
          title="Full screen (F)"
        >
          {fullscreen ? (
            <Minimize2 size={23} strokeWidth={1.5} />
          ) : (
            <Maximize2 size={23} strokeWidth={1.5} />
          )}
        </button>
      </div>
    </motion.div>
  );
}
