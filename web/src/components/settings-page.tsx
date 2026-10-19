import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type FormEvent,
} from "react";
import { Fingerprint, RefreshCw, SlidersHorizontal } from "lucide-react";
import { useAuth } from "../auth";
import {
  getSettings,
  updateSettings,
  request,
  type AppSettings,
  type SettingsUpdate,
  type Category,
  type Status,
  type RefreshState,
} from "../api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "./ui/accordion";
import { CategorySelector } from "./spectrumui/category-selector";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { LoadingButton } from "./spectrumui/loading-button";
import { Skeleton } from "./ui/skeleton";
import { Spinner } from "./spectrumui/spinner-dependencies";
import { MorphButton } from "./spectrumui/morph-button";
import { AnimatedAlert } from "./spectrumui/animated-alert";
import { TextStates } from "./spectrumui/text-states";
import { SubtitleAppearanceSettings } from "./subtitle-appearance-settings";
import "./settings-preferences.css";

export type RefreshTarget = "all" | "catalog" | "epg";

const settingsSections = [
  { id: "settings-provider", label: "Provider" },
  { id: "settings-library", label: "Library & guide" },
  { id: "settings-discovery", label: "Discovery" },
  { id: "settings-playback", label: "Playback" },
  { id: "settings-subtitles", label: "Subtitles" },
  { id: "settings-status", label: "Status" },
  { id: "settings-about", label: "About" },
];
const readOnlySections = settingsSections.slice(-3);
const processingLabels: Record<string, string> = {
  auto: "Automatic",
  copy: "Copy",
  transcode: "Transcode",
};

function timestamp(value?: string) {
  if (!value) return "Not yet refreshed";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unavailable"
    : date.toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}

function interval(seconds?: number) {
  if (!seconds || seconds < 0) return "—";
  const unit =
    seconds % 86400 === 0
      ? ([86400, "day"] as const)
      : seconds % 3600 === 0
        ? ([3600, "hour"] as const)
        : seconds % 60 === 0
          ? ([60, "minute"] as const)
          : ([1, "second"] as const);
  const count = seconds / unit[0];
  return `${count} ${unit[1]}${count === 1 ? "" : "s"}`;
}

function refreshState(state?: RefreshState) {
  if (!state) return "—";
  if (state.running) return "Running";
  if (state.queued) return "Queued";
  if (state.paused) return "Paused";
  if (state.error) return "Failed";
  return "Idle";
}

export function SettingsPage({
  status,
  statusError,
  onRefresh,
  onSaved,
}: {
  status: Status | null;
  statusError: string;
  onRefresh: (target: RefreshTarget) => Promise<void>;
  onSaved?: () => void;
}) {
  const { canAdmin } = useAuth();
  const sections = canAdmin ? settingsSections : readOnlySections;
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const pageRef = useRef<HTMLElement>(null);
  const jumpTarget = useRef<string | null>(null);
  const [activeSection, setActiveSection] = useState(sections[0].id);
  const jumpToSection = (id: string) => {
    const section = document.getElementById(id);
    if (!section) return;
    jumpTarget.current = id;
    setActiveSection(id);
    section.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
      block: "start",
    });
    section.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (canAdmin && !settings) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      // A section jump owns selection until the user scrolls again. Otherwise
      // scroll tracking selects every section crossed by the smooth scroll.
      if (jumpTarget.current) {
        setActiveSection(jumpTarget.current);
        return;
      }
      const offset = window.matchMedia("(max-width: 820px)").matches ? 100 : 36;
      let current = sections[0].id;
      for (const section of sections) {
        const element = document.getElementById(section.id);
        if (element && element.getBoundingClientRect().top <= offset)
          current = section.id;
      }
      if (
        window.scrollY > 0 &&
        Math.ceil(window.scrollY + window.innerHeight) >=
          document.documentElement.scrollHeight - 2
      )
        // Short final sections share a clamped scroll position.
        current = sections.at(-1)!.id;
      setActiveSection(current);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const clearJump = () => {
      jumpTarget.current = null;
      schedule();
    };
    const clearScrollbarJump = (event: PointerEvent) => {
      if (
        event.target === document.documentElement ||
        event.target === document.body
      )
        clearJump();
    };
    const scrollKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (
        event.target instanceof Element &&
        event.target.closest(
          "input, textarea, select, [contenteditable], [role='combobox'], [role='option']",
        )
      )
        return;
      if (
        event.key === " " &&
        event.target instanceof Element &&
        event.target.closest("button")
      )
        return;
      if (
        [
          "ArrowUp",
          "ArrowDown",
          "PageUp",
          "PageDown",
          "Home",
          "End",
          " ",
        ].includes(event.key)
      )
        clearJump();
    };
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", clearJump);
    window.addEventListener("wheel", clearJump, { passive: true });
    window.addEventListener("touchmove", clearJump, { passive: true });
    window.addEventListener("pointerdown", clearScrollbarJump, {
      passive: true,
    });
    window.addEventListener("keydown", scrollKey);
    const observer = new ResizeObserver(schedule);
    if (pageRef.current) observer.observe(pageRef.current);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", clearJump);
      window.removeEventListener("wheel", clearJump);
      window.removeEventListener("touchmove", clearJump);
      window.removeEventListener("pointerdown", clearScrollbarJump);
      window.removeEventListener("keydown", scrollKey);
      observer.disconnect();
    };
  }, [!!settings, canAdmin, sections]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [categoryError, setCategoryError] = useState("");
  const [loading, setLoading] = useState(canAdmin);
  const [loadError, setLoadError] = useState("");
  const [retry, setRetry] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const [refreshPhase, setRefreshPhase] = useState<
    "idle" | "requested" | "complete" | "failed"
  >("idle");

  useEffect(() => {
    if (!canAdmin) return;
    const controller = new AbortController();
    setLoading(true);
    void getSettings(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          setSettings(value);
          setLoadError("");
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoadError("Settings unavailable.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [retry, canAdmin]);

  useEffect(() => {
    if (!canAdmin) return;
    const controller = new AbortController();
    void request<{ categories: Category[] }>("/api/categories?manage=1", {
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) {
          setCategories(value.categories || []);
          setCategoryError("");
        }
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setCategoryError(
            "Category choices are unavailable. Your saved selections are kept.",
          );
      });
    return () => controller.abort();
  }, [retry, status?.catalogUpdatedAt, canAdmin]);

  const configured = status?.configured ?? false;
  const cooldown =
    canAdmin &&
    !!status?.portalCooldownUntil &&
    Date.parse(status.portalCooldownUntil) > Date.now();
  const syncStates = canAdmin
    ? [status?.sync?.catalog, status?.sync?.epg, status?.sync?.discovery]
    : [];
  const busy =
    refreshing ||
    !!status?.refreshing ||
    syncStates.some((state) => state?.running || state?.queued);
  const syncErrors = [
    ...new Set(
      [status?.error, ...syncStates.map((state) => state?.error)].filter(
        (value): value is string => !!value,
      ),
    ),
  ];
  const lastUpdated =
    syncStates
      .map((state) => state?.lastSuccessfulAt)
      .filter((value): value is string => !!value)
      .sort()
      .at(-1) ||
    status?.catalogRefreshCompletedAt ||
    status?.libraryUpdatedAt;
  useEffect(() => {
    if (refreshPhase !== "requested" || busy) return;
    setRefreshPhase(
      syncErrors.length || cooldown || statusError ? "failed" : "complete",
    );
  }, [refreshPhase, busy, syncErrors.length, cooldown, statusError]);

  useEffect(() => {
    if (refreshPhase !== "complete" && refreshPhase !== "failed") return;
    const timer = window.setTimeout(() => setRefreshPhase("idle"), 2000);
    return () => window.clearTimeout(timer);
  }, [refreshPhase]);

  const refresh = async () => {
    if (!canAdmin || busy || !configured || cooldown || statusError) return;
    setRefreshing(true);
    setRefreshError("");
    setRefreshPhase("idle");
    try {
      await onRefresh("all");
      setRefreshPhase("requested");
    } catch (cause) {
      setRefreshPhase("failed");
      setRefreshError(
        cause instanceof Error ? cause.message : "Couldn’t refresh. Try again.",
      );
    } finally {
      setRefreshing(false);
    }
  };

  const details = (
    <>
      <SubtitleAppearanceSettings />
      <section
        id="settings-status"
        tabIndex={-1}
        className="settings-status"
        aria-labelledby="settings-status-title"
      >
        <div className="settings-status-heading">
          <div>
            <h2 id="settings-status-title">Status</h2>
            <p>Library availability and update information.</p>
          </div>
          {canAdmin && (
            <MorphButton
              className="settings-refresh"
              disabled={!configured || cooldown || !!statusError}
              state={
                busy
                  ? "loading"
                  : refreshPhase === "complete"
                    ? "success"
                    : refreshPhase === "failed"
                      ? "error"
                      : "idle"
              }
              loadingLabel="Refreshing…"
              successLabel="Refreshed"
              errorLabel="Try again"
              onClick={() => void refresh()}
            >
              <RefreshCw size={16} aria-hidden="true" />
              Refresh now
            </MorphButton>
          )}
        </div>
        {cooldown && (
          <AnimatedAlert variant="warning" role="group" className="mt-5">
            <TextStates
              text={`Refresh resumes after ${timestamp(status?.portalCooldownUntil)}.`}
            />
          </AnimatedAlert>
        )}
        {refreshError && (
          <AnimatedAlert className="mt-5">{refreshError}</AnimatedAlert>
        )}
        {syncErrors.map((error) => (
          <AnimatedAlert key={error} className="mt-5">
            {error}
          </AnimatedAlert>
        ))}

        <dl aria-label="Server status">
          <div>
            <dt>Provider</dt>
            <dd>
              {status ? (configured ? "Configured" : "Not configured") : "—"}
            </dd>
          </div>
          <div>
            <dt>Last refreshed</dt>
            <dd>
              <time dateTime={lastUpdated}>{timestamp(lastUpdated)}</time>
            </dd>
          </div>
          <div>
            <dt>Update activity</dt>
            <dd>{status ? (busy ? "Updating" : "Idle") : "—"}</dd>
          </div>
          <div>
            <dt>Guide updated</dt>
            <dd>{timestamp(status?.epgUpdatedAt)}</dd>
          </div>
          <div>
            <dt>Live channels</dt>
            <dd>{status?.library?.liveChannels.toLocaleString() ?? "—"}</dd>
          </div>
          <div>
            <dt>Categories</dt>
            <dd>{status?.library?.categories.toLocaleString() ?? "—"}</dd>
          </div>
        </dl>
        {canAdmin && (
          <>
            <h3 className="settings-diagnostics-title">Diagnostics</h3>
            <dl aria-label="Admin diagnostics">
              {[
                [
                  "Refresh interval",
                  interval(
                    settings?.library.refreshIntervalSeconds ??
                      status?.sync?.catalog?.intervalSeconds,
                  ),
                ],
                ["Catalog refresh", refreshState(status?.sync?.catalog)],
                [
                  "Next catalog refresh",
                  status?.sync?.catalog?.nextRefreshAt
                    ? timestamp(status.sync.catalog.nextRefreshAt)
                    : "Not scheduled",
                ],
                ["Guide refresh", refreshState(status?.sync?.epg)],
                [
                  "Next guide refresh",
                  status?.sync?.epg?.nextRefreshAt
                    ? timestamp(status.sync.epg.nextRefreshAt)
                    : "Not scheduled",
                ],
                ["Trending refresh", refreshState(status?.sync?.discovery)],
                [
                  "Next Trending refresh",
                  status?.sync?.discovery?.nextRefreshAt
                    ? timestamp(status.sync.discovery.nextRefreshAt)
                    : "Not scheduled",
                ],
                [
                  "Guide coverage",
                  status?.library?.guideStartsAt && status.library.guideEndsAt
                    ? `${timestamp(status.library.guideStartsAt)} – ${timestamp(status.library.guideEndsAt)}`
                    : "Not available",
                ],
                [
                  "Cached movies",
                  status?.library?.cachedMovies.toLocaleString() ?? "—",
                ],
                [
                  "Cached shows",
                  status?.library?.cachedSeries.toLocaleString() ?? "—",
                ],
                [
                  "Guide programmes",
                  status?.library?.programmes.toLocaleString() ?? "—",
                ],
                [
                  "Streams",
                  status?.activeStreams !== undefined &&
                  status.maxStreams !== undefined
                    ? `${status.activeStreams} / ${status.maxStreams}`
                    : "—",
                ],
                [
                  "Playback processing",
                  processingLabels[status?.playback?.transcodeMode ?? ""] ??
                    "—",
                ],
                [
                  "Playback idle timeout",
                  interval(status?.playback?.sessionTimeoutSeconds),
                ],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </>
        )}
      </section>
      <section
        id="settings-about"
        tabIndex={-1}
        className="settings-about"
        aria-labelledby="settings-about-title"
      >
        <h2 id="settings-about-title">About</h2>
        <a href="https://www.themoviedb.org/" target="_blank" rel="noreferrer">
          <img src="/tmdb-logo.svg" alt="TMDB" width={55} height={24} />
          <span>Metadata and artwork by TMDB</span>
        </a>
        <p>
          This product uses the TMDB API but is not endorsed or certified by
          TMDB.
        </p>
      </section>
    </>
  );

  return (
    <section
      ref={pageRef}
      className={`settings-page${canAdmin ? " settings-editable" : ""}`}
      aria-labelledby="settings-title"
    >
      <div className="settings-heading">
        <h1 id="settings-title">Settings</h1>
      </div>
      {(!status && !statusError) || (status && !configured) ? (
        <div className="settings-current-state">
          {!status && <Spinner size="small" className="app-spinner" />}
          <TextStates
            text={
              !status
                ? "Checking server…"
                : canAdmin
                  ? "Provider setup required."
                  : "Provider setup required. Contact an administrator."
            }
          />
        </div>
      ) : null}
      {statusError && (
        <AnimatedAlert className="mt-5">
          Server unavailable. {statusError}
        </AnimatedAlert>
      )}
      {canAdmin && loadError && (
        <AnimatedAlert className="mt-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{loadError}</span>
            <LoadingButton
              loading={loading}
              loadingLabel="Retrying…"
              variant="ghost"
              size="sm"
              onClick={() => setRetry((value) => value + 1)}
            >
              Retry settings
            </LoadingButton>
          </div>
        </AnimatedAlert>
      )}
      {canAdmin && loading && !settings && !loadError && (
        <div className="mt-8" role="status" aria-label="Loading settings">
          <Skeleton className="h-48 w-full" />
        </div>
      )}
      <div className="settings-layout">
        <nav className="settings-section-nav" aria-label="Settings sections">
          <ul
            className="settings-section-links"
            style={
              {
                "--settings-active-index": sections.findIndex(
                  (section) => section.id === activeSection,
                ),
              } as CSSProperties
            }
          >
            {sections.map((section) => (
              <li key={section.id}>
                <Button
                  asChild
                  variant="ghost"
                  className="settings-section-link"
                >
                  <a
                    href={`#${section.id}`}
                    aria-current={
                      activeSection === section.id ? "location" : undefined
                    }
                    onClick={(event) => {
                      event.preventDefault();
                      jumpToSection(section.id);
                    }}
                  >
                    {section.label}
                  </a>
                </Button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="settings-mobile-nav">
          <Select value={activeSection} onValueChange={jumpToSection}>
            <SelectTrigger size="form" aria-label="Jump to section">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sections.map((section) => (
                <SelectItem key={section.id} value={section.id}>
                  {section.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="settings-main">
          {canAdmin && settings ? (
            <SettingsForms
              settings={settings}
              categories={categories}
              categoryError={categoryError}
              onSave={async (patch) => {
                const next = await updateSettings(patch);
                setSettings(next);
                onSaved?.();
                return next;
              }}
            >
              {details}
            </SettingsForms>
          ) : (
            details
          )}
        </div>
      </div>
    </section>
  );
}

function SettingsSection({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      tabIndex={-1}
      className="settings-section"
      aria-labelledby={`${id}-title`}
    >
      <div className="settings-section-intro">
        <h2 id={`${id}-title`}>{title}</h2>
        <p>{description}</p>
      </div>
      <div className="settings-section-content">{children}</div>
    </section>
  );
}

function SettingsSelect({
  id,
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
}) {
  return (
    <div className="settings-select-field">
      <Label id={`${id}-label`} htmlFor={id}>
        {label}
      </Label>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger size="form" id={id} aria-labelledby={`${id}-label`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function SettingsForms({
  settings,
  categories,
  categoryError,
  onSave,
  children,
}: {
  settings: AppSettings;
  categories: Category[];
  categoryError: string;
  onSave: (patch: SettingsUpdate) => Promise<AppSettings>;
  children: ReactNode;
}) {
  const [provider, setProvider] = useState(settings.provider);
  const [library, setLibrary] = useState(settings.library);
  const [playback, setPlayback] = useState(settings.playback);
  const [token, setToken] = useState("");
  const [removeToken, setRemoveToken] = useState(false);
  const managedProvider = settings.providerEnvironment || [];
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{
    draft: string;
    error: string;
  } | null>(null);
  const patch: SettingsUpdate = {};
  const providerChanges = Object.fromEntries(
    Object.entries(provider).filter(
      ([key, value]) =>
        !managedProvider.includes(key as keyof AppSettings["provider"]) &&
        value !== settings.provider[key as keyof AppSettings["provider"]],
    ),
  );
  if (Object.keys(providerChanges).length) patch.provider = providerChanges;
  if (JSON.stringify(library) !== JSON.stringify(settings.library))
    patch.library = library;
  if (JSON.stringify(playback) !== JSON.stringify(settings.playback))
    patch.playback = playback;
  if (token.trim() || removeToken)
    patch.discovery = { tmdbReadAccessToken: removeToken ? "" : token.trim() };
  const dirty = Object.keys(patch).length > 0;
  const draftKey = JSON.stringify({
    provider,
    library,
    playback,
    token,
    removeToken,
  });
  const currentFeedback = feedback?.draft === draftKey ? feedback : null;
  const resetDrafts = (value: AppSettings) => {
    setProvider(value.provider);
    setLibrary(value.library);
    setPlayback(value.playback);
    setToken("");
    setRemoveToken(false);
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || !dirty) return;
    setSaving(true);
    setFeedback(null);
    try {
      const next = await onSave(patch);
      resetDrafts(next);
    } catch (cause) {
      setFeedback({
        draft: draftKey,
        error:
          cause instanceof Error ? cause.message : "Couldn’t save. Try again.",
      });
    } finally {
      setSaving(false);
    }
  };
  const providerInput = (
    key: keyof AppSettings["provider"],
    label: string,
    type = "text",
  ) => {
    const managed = managedProvider.includes(key);
    return (
      <div key={key}>
        <Label htmlFor={`provider-${key}`}>{label}</Label>
        <Input
          id={`provider-${key}`}
          type={type}
          value={managed ? "" : provider[key]}
          placeholder={managed ? "Managed by environment" : undefined}
          variant={managed ? "status" : "default"}
          disabled={managed}
          readOnly={managed}
          aria-describedby={managed ? `provider-${key}-source` : undefined}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) =>
            setProvider({ ...provider, [key]: event.target.value })
          }
        />
        {managed && (
          <span id={`provider-${key}-source`} className="sr-only">
            Managed by environment
          </span>
        )}
      </div>
    );
  };
  const refreshOptions = [3600, 21600, 43200, 86400, 172800, 604800];
  if (!refreshOptions.includes(library.refreshIntervalSeconds))
    refreshOptions.push(library.refreshIntervalSeconds);
  return (
    <form
      id="settings-form"
      className="settings-forms"
      aria-label="App settings"
      onSubmit={(event) => void submit(event)}
    >
      <fieldset
        disabled={saving}
        inert={saving}
        className="settings-editable-fields"
      >
        <SettingsSection
          id="settings-provider"
          title="Provider connection"
          description="Connect your provider to bring your channels, movies and shows into Restream. Changes apply to everyone using this server."
        >
          {managedProvider.length > 0 && (
            <p className="settings-source-note">
              Fields managed by environment are read-only here.
            </p>
          )}
          <div className="settings-fields">
            <div className="settings-field-wide">
              {providerInput("portalUrl", "Portal URL", "url")}
            </div>
            {providerInput("mac", "MAC address")}
            {providerInput("timezone", "Timezone")}
          </div>
          <p className="settings-field-help">
            Use the MAC address registered with your provider and a timezone
            such as America/Toronto. Stop active playback before changing your
            connection.
          </p>
          <Accordion type="single" collapsible className="settings-advanced">
            <AccordionItem value="device-identity" variant="panel">
              <AccordionTrigger
                icon={<Fingerprint />}
                description="Serial number and device IDs"
              >
                Device identity
              </AccordionTrigger>
              <AccordionContent>
                <p className="settings-field-help">
                  Only fill these in if your provider requires a registered
                  device identity.
                </p>
                <div className="settings-fields">
                  {providerInput("serialNumber", "Serial number")}
                  {providerInput("deviceId", "Device ID")}
                  {providerInput("deviceId2", "Secondary device ID")}
                </div>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </SettingsSection>
        <SettingsSection
          id="settings-library"
          title="Library & guide"
          description="Choose how your library stays fresh and what appears around the app."
        >
          <div className="settings-fields">
            <SettingsSelect
              id="refresh-interval"
              disabled={saving}
              label="Refresh every"
              value={String(library.refreshIntervalSeconds)}
              options={refreshOptions
                .sort((a, b) => a - b)
                .map((value) => ({
                  value: String(value),
                  label: interval(value),
                }))}
              onChange={(value) =>
                setLibrary({
                  ...library,
                  refreshIntervalSeconds: Number(value),
                })
              }
            />
            <div>
              <Label htmlFor="guide-hours">Guide coverage in hours</Label>
              <Input
                id="guide-hours"
                type="number"
                min={1}
                max={168}
                required
                value={library.guideHours}
                onChange={(event) =>
                  setLibrary({
                    ...library,
                    guideHours: Number(event.target.value),
                  })
                }
              />
            </div>
          </div>
          <p className="settings-field-help">
            Cached titles stay visible while updates arrive. The library and
            guide use the selected refresh interval. Stop active playback before
            changing guide coverage.
          </p>
          {categoryError && (
            <AnimatedAlert variant="warning">{categoryError}</AnimatedAlert>
          )}
          <CategorySelector
            id="home-categories"
            label="Home categories"
            categories={categories}
            disabled={saving}
            values={library.dashboardCategories}
            onChange={(values) =>
              setLibrary({ ...library, dashboardCategories: values })
            }
          />
          <p className="settings-field-help">
            Filters Home recommendations, including Trending and Explore. Leave
            empty for all categories. Watch history uses all unblocked
            categories.
          </p>
          <CategorySelector
            id="blocked-categories"
            label="Blocked categories"
            categories={categories}
            disabled={saving}
            values={library.blockedCategories}
            onChange={(values) =>
              setLibrary({ ...library, blockedCategories: values })
            }
          />
          <p className="settings-field-help">
            Blocked categories are hidden throughout the app and cannot be
            played. Leave empty to allow all categories.
          </p>
        </SettingsSection>
        <SettingsSection
          id="settings-discovery"
          title="Discovery"
          description="Add TMDB to discover Trending titles available from your provider, with richer artwork."
        >
          <Label htmlFor="tmdb-token">TMDB read access token</Label>
          <Input
            id="tmdb-token"
            type="password"
            value={token}
            placeholder={
              removeToken
                ? "Token will be removed"
                : settings.discovery.tmdbTokenConfigured
                  ? "•••••••• — Token saved"
                  : "Enter a TMDB read access token"
            }
            variant={
              !token && settings.discovery.tmdbTokenConfigured
                ? "status"
                : "default"
            }
            aria-describedby="tmdb-token-help"
            autoComplete="new-password"
            spellCheck={false}
            onChange={(event) => {
              setToken(event.target.value);
              setRemoveToken(false);
            }}
          />
          <div className="settings-token-state">
            <span id="tmdb-token-help">
              {removeToken
                ? "Token will be removed when you save."
                : settings.discovery.tmdbTokenConfigured
                  ? "Enter a new token to replace the saved one."
                  : "Optional. Add a read access token to enable Trending."}
            </span>
            {settings.discovery.tmdbTokenConfigured && (
              <Button
                type="button"
                variant="link"
                size="sm"
                onClick={() => {
                  setRemoveToken(!removeToken);
                  setToken("");
                }}
              >
                {removeToken ? "Keep token" : "Remove token"}
              </Button>
            )}
          </div>
          <a
            className="settings-inline-link"
            href="https://www.themoviedb.org/settings/api"
            target="_blank"
            rel="noreferrer"
          >
            Get a TMDB read access token ↗
          </a>
        </SettingsSection>
        <SettingsSection
          id="settings-playback"
          title="Playback"
          description="Set the number of streams your provider allows at the same time."
        >
          <div className="settings-fields">
            <div>
              <Label htmlFor="maximum-streams">
                Maximum simultaneous streams
              </Label>
              <Input
                id="maximum-streams"
                type="number"
                min={1}
                required
                value={playback.maxStreams}
                onChange={(event) =>
                  setPlayback({
                    ...playback,
                    maxStreams: Number(event.target.value),
                  })
                }
              />
            </div>
          </div>
          <Accordion type="single" collapsible className="settings-advanced">
            <AccordionItem value="advanced-playback" variant="panel">
              <AccordionTrigger
                icon={<SlidersHorizontal />}
                description="Video conversion settings"
              >
                Advanced playback
              </AccordionTrigger>
              <AccordionContent>
                <SettingsSelect
                  id="transcode-mode"
                  disabled={saving}
                  label="Playback processing"
                  value={playback.transcodeMode}
                  onChange={(value) =>
                    setPlayback({
                      ...playback,
                      transcodeMode:
                        value as AppSettings["playback"]["transcodeMode"],
                    })
                  }
                  options={[
                    { value: "auto", label: "Automatic" },
                    { value: "copy", label: "Copy" },
                    { value: "transcode", label: "Transcode" },
                  ]}
                />
                <p className="settings-field-help">
                  Automatic adapts playback for your browser. Copy avoids video
                  encoding; Transcode always converts it.
                </p>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </SettingsSection>
      </fieldset>
      {children}
      {(dirty || saving) && (
        <div className="settings-save-bar">
          {currentFeedback?.error && (
            <AnimatedAlert>{currentFeedback.error}</AnimatedAlert>
          )}
          <div className="settings-save-actions">
            <span
              className="settings-save-state"
              role="status"
              aria-live="polite"
            >
              {saving ? "Saving changes…" : "Unsaved changes"}
            </span>
            <div className="settings-save-buttons">
              <Button
                type="button"
                variant="outline"
                aria-label="Discard changes"
                disabled={!dirty || saving}
                onClick={() => {
                  resetDrafts(settings);
                  setFeedback(null);
                }}
              >
                Discard
              </Button>
              <LoadingButton
                type="submit"
                loading={saving}
                loadingLabel="Saving…"
                disabled={!dirty}
              >
                Save changes
              </LoadingButton>
            </div>
          </div>
        </div>
      )}
    </form>
  );
}
