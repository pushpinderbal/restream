import { useState } from "react";
import {
  AudioLines,
  Database,
  Radio,
  RefreshCw,
  CalendarClock,
  Wifi,
  TriangleAlert,
} from "lucide-react";
import { Button } from "./ui/button";
import { Spinner } from "./spectrumui/spinner-dependencies";
import type { RefreshState, Status } from "../api";

export type RefreshTarget = "all" | "catalog" | "epg";

function timestamp(value?: string) {
  if (!value) return "Not yet synced";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unavailable"
    : date.toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
      });
}
function duration(seconds?: number) {
  if (!seconds || seconds < 0) return "Unavailable";
  const hours = seconds / 3600;
  if (hours >= 1)
    return `${Number(hours.toFixed(1))} ${hours === 1 ? "hour" : "hours"}`;
  if (seconds >= 60) return `${Number((seconds / 60).toFixed(1))} minutes`;
  return `${seconds} seconds`;
}
function syncLabel(
  state: RefreshState | undefined,
  configured: boolean,
  coolingDown: boolean,
) {
  if (!configured) return "Awaiting setup";
  if (state?.running) return "Syncing";
  if (state?.queued) return "Queued";
  if (coolingDown) return "Waiting for provider";
  if (state?.error) return "Needs attention";
  if (!state?.lastSuccessfulAt) return "Waiting for first sync";
  return "Up to date";
}

export function SettingsPage({
  status,
  statusError,
  checkedAt,
  onRefresh,
}: {
  status: Status | null;
  statusError: string;
  checkedAt: number | null;
  onRefresh: (target: RefreshTarget) => Promise<void>;
}) {
  const [pending, setPending] = useState<RefreshTarget | null>(null);
  const [actionError, setActionError] = useState("");
  const configured = status?.configured ?? false;
  const cooldown =
    !!status?.portalCooldownUntil &&
    Date.parse(status.portalCooldownUntil) > Date.now();
  const unavailable =
    !configured || cooldown || !!statusError || pending !== null;

  const refresh = async (target: RefreshTarget) => {
    if (pending) return;
    setPending(target);
    setActionError("");
    try {
      await onRefresh(target);
    } catch (cause) {
      setActionError(
        cause instanceof Error
          ? cause.message
          : "Couldn’t request a refresh. Try again.",
      );
    } finally {
      setPending(null);
    }
  };

  return (
    <section className="settings-page" aria-labelledby="settings-title">
      <div className="settings-heading">
        <div>
          <h1 id="settings-title">Settings</h1>
          <p>Keep your library and guide up to date.</p>
        </div>
      </div>
      {statusError && (
        <div className="settings-notice" role="alert">
          <TriangleAlert size={18} aria-hidden="true" />
          <span>
            Couldn’t check the server. {statusError} The values below are from
            the last successful check.
          </span>
        </div>
      )}
      {actionError && (
        <p className="settings-action-error" role="alert">
          {actionError}
        </p>
      )}
      {!status ? (
        <div className="inline-loading" role="status">
          <Spinner size="small" className="app-spinner" />
          Checking server status…
        </div>
      ) : (
        <>
          <div className="settings-connection">
            <Wifi size={19} aria-hidden="true" />
            <span>
              {configured ? "Provider configured" : "Provider setup required"}
            </span>
            <span className="settings-connection-detail">
              {!configured
                ? "Waiting for configuration"
                : status.refreshing
                  ? "Sync in progress"
                  : "Automatic refresh enabled"}
            </span>
          </div>
          {cooldown && (
            <div className="settings-notice">
              <CalendarClock size={18} aria-hidden="true" />
              <span>
                The provider requested a pause. Automatic refresh resumes after{" "}
                {timestamp(status.portalCooldownUntil)}.
              </span>
            </div>
          )}
          <div className="settings-sync-list">
            {[
              {
                target: "catalog" as const,
                title: "Library metadata",
                description:
                  "Update live channels and categories, and check movie, series, and episode lists for changes.",
                icon: Database,
              },
              {
                target: "epg" as const,
                title: "Programme guide",
                description: "Schedules and what’s currently on each channel.",
                icon: CalendarClock,
              },
            ].map(({ target, title, description, icon: Icon }) => {
              const state = status.sync?.[target];
              const busy =
                !!state?.running ||
                !!state?.queued ||
                pending === target ||
                pending === "all";
              return (
                <section
                  className="settings-sync-section"
                  key={target}
                  aria-label={title}
                >
                  <div className="settings-sync-heading">
                    <Icon size={22} aria-hidden="true" />
                    <div>
                      <h2>{title}</h2>
                      <p>{description}</p>
                    </div>
                    <span
                      className={`settings-sync-state ${busy ? "syncing" : state?.error ? "sync-error" : ""}`}
                    >
                      <Button
                        variant="ghost"
                        size="icon"
                        className="settings-sync-refresh"
                        aria-label={
                          target === "catalog"
                            ? "Refresh library"
                            : "Refresh guide"
                        }
                        title={
                          busy
                            ? "Syncing"
                            : target === "catalog"
                              ? "Refresh library"
                              : "Refresh guide"
                        }
                        aria-busy={busy || undefined}
                        disabled={unavailable || busy}
                        onClick={() => void refresh(target)}
                      >
                        <RefreshCw
                          size={16}
                          className={busy ? "animate-spin" : undefined}
                          aria-hidden="true"
                        />
                      </Button>
                      <span role="status">
                        {busy
                          ? "Syncing"
                          : syncLabel(state, configured, cooldown)}
                      </span>
                    </span>
                  </div>
                  <div className="settings-sync-body">
                    <dl>
                      <div>
                        <dt>Last successful sync</dt>
                        <dd>
                          <time dateTime={state?.lastSuccessfulAt}>
                            {timestamp(state?.lastSuccessfulAt)}
                          </time>
                        </dd>
                      </div>
                      <div>
                        <dt>{busy ? "Started" : "Next refresh"}</dt>
                        <dd>
                          {busy
                            ? state?.queued
                              ? "Queued to start"
                              : state?.startedAt
                                ? timestamp(state.startedAt)
                                : "Starting…"
                            : !configured
                              ? "After setup"
                              : state?.nextRefreshAt
                                ? timestamp(state.nextRefreshAt)
                                : "Due now"}
                        </dd>
                      </div>
                      <div>
                        <dt>Refresh interval</dt>
                        <dd>Every {duration(state?.intervalSeconds)}</dd>
                      </div>
                    </dl>
                  </div>
                  {state?.error && (
                    <p className="settings-sync-error" role="alert">
                      {state.error}
                    </p>
                  )}
                </section>
              );
            })}
          </div>
          <div className="settings-details">
            <section aria-labelledby="settings-library-title">
              <h2 id="settings-library-title">
                <Radio size={19} aria-hidden="true" />
                Library &amp; guide
              </h2>
              <dl>
                <div>
                  <dt>Live channels</dt>
                  <dd>
                    {status.library?.liveChannels.toLocaleString() ?? "—"}
                  </dd>
                </div>
                <div>
                  <dt>Categories</dt>
                  <dd>{status.library?.categories.toLocaleString() ?? "—"}</dd>
                </div>
                <div>
                  <dt>Cached movies / series</dt>
                  <dd>
                    {status.library
                      ? `${status.library.cachedMovies.toLocaleString()} / ${status.library.cachedSeries.toLocaleString()}`
                      : "—"}
                  </dd>
                </div>
                <div>
                  <dt>Guide programmes</dt>
                  <dd>{status.library?.programmes.toLocaleString() ?? "—"}</dd>
                </div>
                <div>
                  <dt>Guide available through</dt>
                  <dd>
                    {status.library?.guideEndsAt
                      ? timestamp(status.library.guideEndsAt)
                      : "No guide data yet"}
                  </dd>
                </div>
                <div>
                  <dt>Guide request window</dt>
                  <dd>
                    {status.guideHours ? `${status.guideHours} hours` : "—"}
                  </dd>
                </div>
                <div>
                  <dt>Provider timezone</dt>
                  <dd>{status.timezone || "—"}</dd>
                </div>
              </dl>
              <p className="settings-footnote">
                Cached title counts grow as you browse. Guide coverage depends
                on the provider. Times are shown in your device’s timezone.
              </p>
            </section>
            <section aria-labelledby="settings-playback-title">
              <h2 id="settings-playback-title">
                <AudioLines size={19} aria-hidden="true" />
                Playback
              </h2>
              <dl>
                <div>
                  <dt>Streams in use</dt>
                  <dd>
                    {status.activeStreams} / {status.maxStreams}
                  </dd>
                </div>
                <div>
                  <dt>Available slots</dt>
                  <dd>
                    {Math.max(0, status.maxStreams - status.activeStreams)}
                  </dd>
                </div>
                <div>
                  <dt>Playback mode</dt>
                  <dd>
                    {status.playback?.transcodeMode === "auto"
                      ? "Automatic"
                      : status.playback?.transcodeMode === "copy"
                        ? "Direct stream"
                        : status.playback?.transcodeMode === "transcode"
                          ? "Transcode"
                          : "—"}
                  </dd>
                </div>
                <div>
                  <dt>Idle session timeout</dt>
                  <dd>{duration(status.playback?.sessionTimeoutSeconds)}</dd>
                </div>
              </dl>
              <p className="settings-footnote">
                Refreshes run in the background while you watch. Refresh
                intervals and playback limits are configured on the server.
              </p>
            </section>
          </div>
        </>
      )}
      <div className="settings-check">
        <span>
          {checkedAt
            ? `Status checked ${timestamp(new Date(checkedAt).toISOString())}`
            : "Waiting for server status"}{" "}
          · Updates automatically
        </span>
      </div>
    </section>
  );
}
