import { useEffect, useState } from "react";
import { CalendarClock, RefreshCw, TriangleAlert } from "lucide-react";
import { getPreferences, type Preferences, type Status } from "../api";
import { Button } from "./ui/button";
import { Spinner } from "./spectrumui/spinner-dependencies";
import "./settings-preferences.css";

export type RefreshTarget = "all" | "catalog" | "epg";

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

function RuleList({
  values,
  fallback,
  loaded,
}: {
  values?: string[];
  fallback: string;
  loaded: boolean;
}) {
  if (!loaded) return <>—</>;
  if (!values?.length) return <>{fallback}</>;
  return (
    <ul className="settings-rule-values">
      {values.map((value, index) => (
        <li key={`${index}:${value}`}>{value}</li>
      ))}
    </ul>
  );
}

export function SettingsPage({
  status,
  statusError,
  onRefresh,
}: {
  status: Status | null;
  statusError: string;
  onRefresh: (target: RefreshTarget) => Promise<void>;
}) {
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [retry, setRetry] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError("");
    void getPreferences(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setPreferences(value);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setLoadError("Configuration unavailable.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [retry, status?.preferencesUpdatedAt]);

  const configured = status?.configured ?? false;
  const cooldown =
    !!status?.portalCooldownUntil &&
    Date.parse(status.portalCooldownUntil) > Date.now();
  const syncStates = [status?.sync?.catalog, status?.sync?.epg];
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
      .at(-1) || status?.libraryUpdatedAt;
  const configuration = preferences?.configuration;
  const refresh = async () => {
    if (busy || !configured || cooldown || statusError) return;
    setRefreshing(true);
    setRefreshError("");
    try {
      await onRefresh("all");
    } catch (cause) {
      setRefreshError(
        cause instanceof Error ? cause.message : "Couldn’t refresh. Try again.",
      );
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <section
      className="settings-page settings-readonly"
      aria-labelledby="settings-title"
    >
      <div className="settings-heading">
        <h1 id="settings-title">Settings</h1>
        <Button
          variant="outline"
          disabled={!configured || cooldown || busy || !!statusError}
          aria-busy={busy || undefined}
          onClick={() => void refresh()}
        >
          <RefreshCw
            size={16}
            className={busy ? "animate-spin" : undefined}
            aria-hidden="true"
          />
          Refresh now
        </Button>
      </div>
      {busy && (
        <p className="settings-current-state" role="status">
          <Spinner size="small" className="app-spinner" />
          Refreshing…
        </p>
      )}
      {!status && !statusError && (
        <p className="settings-current-state" role="status">
          Checking server…
        </p>
      )}
      {status && !configured && (
        <p className="settings-current-state" role="status">
          Provider setup required.
        </p>
      )}
      {statusError && (
        <p className="settings-notice" role="alert">
          <TriangleAlert size={17} aria-hidden="true" />
          Server unavailable. {statusError}
        </p>
      )}
      {cooldown && (
        <p className="settings-notice" role="status">
          <CalendarClock size={17} aria-hidden="true" />
          Refresh resumes after {timestamp(status?.portalCooldownUntil)}.
        </p>
      )}
      {refreshError && (
        <p className="settings-action-error" role="alert">
          {refreshError}
        </p>
      )}
      {syncErrors.map((error) => (
        <p key={error} className="settings-action-error" role="alert">
          {error}
        </p>
      ))}
      {loadError && (
        <div className="settings-config-error" role="alert">
          <span>{loadError}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setRetry((value) => value + 1)}
          >
            Retry configuration
          </Button>
        </div>
      )}
      {loading && !preferences && (
        <p className="settings-current-state" role="status">
          Loading configuration…
        </p>
      )}
      <div className="settings-summary">
        <dl aria-label="Server status">
          <div>
            <dt>Provider</dt>
            <dd>
              {status ? (configured ? "Configured" : "Not configured") : "—"}
            </dd>
          </div>
          <div>
            <dt title="REFRESH_INTERVAL">Refresh interval</dt>
            <dd>
              {interval(
                preferences?.refreshIntervalSeconds ??
                  status?.sync?.catalog?.intervalSeconds,
              )}
            </dd>
          </div>
          <div>
            <dt>Last refreshed</dt>
            <dd>
              <time dateTime={lastUpdated}>{timestamp(lastUpdated)}</time>
            </dd>
          </div>
          <div>
            <dt>Live channels</dt>
            <dd>{status?.library?.liveChannels.toLocaleString() ?? "—"}</dd>
          </div>
          <div>
            <dt>Categories</dt>
            <dd>{status?.library?.categories.toLocaleString() ?? "—"}</dd>
          </div>
          <div>
            <dt>Streams</dt>
            <dd>
              {status ? `${status.activeStreams} / ${status.maxStreams}` : "—"}
            </dd>
          </div>
        </dl>
        <dl className="settings-category-rules" aria-label="Category rules">
          <div>
            <dt title="DASHBOARD_CATEGORIES">Dashboard</dt>
            <dd>
              <RuleList
                values={configuration?.dashboardCategories}
                fallback="All"
                loaded={!!preferences}
              />
            </dd>
          </div>
          <div>
            <dt title="BLOCKED_CATEGORIES">Blocked</dt>
            <dd>
              <RuleList
                values={configuration?.blockedCategories}
                fallback="None"
                loaded={!!preferences}
              />
            </dd>
          </div>
        </dl>
      </div>
    </section>
  );
}
