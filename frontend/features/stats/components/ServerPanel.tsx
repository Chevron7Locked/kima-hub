"use client";

/**
 * The server half of the page, admins only (`system` is absent for everyone
 * else). Readings in columns. Each action calls the endpoint that owns it; the
 * two destructive ones confirm in place with a second click.
 */

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { api } from "@/lib/api";
import { bytes, uptime } from "../format";
import type { SystemStats } from "../types";

export function ServerPanel({ system }: { system: SystemStats }) {
    return (
        <div className="flex flex-col gap-7">
            <div className="grid gap-x-10 gap-y-5 grid-cols-2 sm:grid-cols-4">
                <Probe label="database" ms={system.db} />
                <Probe label="redis" ms={system.redis} />
                <Reading label="uptime" value={uptime(system.uptimeSeconds)} />
                <Reading label="version" value={system.version} mono />
            </div>

            <div className="grid gap-x-10 gap-y-5 grid-cols-2 sm:grid-cols-4">
                <Reading label="tracks" value={system.library.tracks.toLocaleString()} />
                <Reading label="library size" value={bytes(system.library.bytes)} />
                <Reading
                    label="cache size"
                    value={bytes(system.cache.transcodedMb * 1048576)}
                />
                <Reading
                    label="failed tracks"
                    value={(system.corruptTracks + system.enrichmentFailures).toLocaleString()}
                    tone={system.corruptTracks + system.enrichmentFailures > 0 ? "brand" : undefined}
                />
            </div>

            {system.jobs.length > 0 && (
                <div className="flex flex-col gap-3">
                    <h3 className="t-label text-[var(--text-secondary)]">download jobs</h3>
                    <div className="flex flex-wrap gap-x-8 gap-y-3">
                        {system.jobs.map((job) => (
                            <p key={job.status} className="flex items-baseline gap-2">
                                <span className="t-figure text-[length:var(--stat-lead)]">
                                    {job.count.toLocaleString()}
                                </span>
                                <span className="t-meta">{job.status.toLowerCase()}</span>
                            </p>
                        ))}
                    </div>
                </div>
            )}

            <div className="flex flex-wrap gap-2 pt-1">
                <Action<ClearCachesResult>
                    label="clear cache"
                    confirmLabel="clear cache?"
                    path="/system-settings/clear-caches"
                    done={(r) => `cleared ${(r.clearedKeys ?? 0).toLocaleString()} cache ${(r.clearedKeys ?? 0) === 1 ? "entry" : "entries"}`}
                />
                <Action<CleanupJobsResult>
                    label="clear finished jobs"
                    confirmLabel="clear jobs?"
                    path="/settings/cleanup-stale-jobs"
                    done={(r) => `cleared ${(r.totalCleaned ?? 0).toLocaleString()} ${(r.totalCleaned ?? 0) === 1 ? "job" : "jobs"}`}
                />
                <Action<RetryFailedResult>
                    label="retry failed analysis"
                    path="/analysis/retry-failed"
                    done={(r) => `requeued ${(r.reset ?? 0).toLocaleString()} ${(r.reset ?? 0) === 1 ? "track" : "tracks"}`}
                />
            </div>
        </div>
    );
}

/** A live check. Amber when it answered, red when it did not. */
function Probe({ label, ms }: { label: string; ms: number | null }) {
    const ok = ms != null;
    return (
        <div className="flex flex-col gap-1.5">
            <span className="t-label">{label}</span>
            <span className="flex items-center gap-2">
                <span
                    aria-hidden
                    className={`w-1.5 h-1.5 rounded-full ${ok ? "bg-brand" : "bg-danger-light"}`}
                />
                <span
                    className={`t-figure text-[length:var(--stat-lead)] ${ok ? "" : "text-danger-light"}`}
                >
                    {ok ? `${ms < 1 ? ms.toFixed(1) : Math.round(ms)}ms` : "down"}
                </span>
            </span>
        </div>
    );
}

function Reading({
    label,
    value,
    mono,
    tone,
}: {
    label: string;
    value: string;
    mono?: boolean;
    tone?: "brand";
}) {
    return (
        <div className="flex flex-col gap-1.5">
            <span className="t-label">{label}</span>
            <span
                className={[
                    mono ? "t-data text-base" : "t-figure text-[length:var(--stat-lead)]",
                    tone === "brand" ? "text-brand" : "text-[var(--text-primary)]",
                ].join(" ")}
            >
                {value}
            </span>
        </div>
    );
}

/** Response shapes of each maintenance endpoint, as its route returns them. */
interface ClearCachesResult { clearedKeys?: number }
interface CleanupJobsResult { totalCleaned?: number }
interface RetryFailedResult { reset?: number; failed?: number; permanentlyFailed?: number }

/** One maintenance action: idle, asking, running, done. `done` keeps its result on screen. */
function Action<TResult extends object>({
    label,
    confirmLabel,
    path,
    done,
}: {
    label: string;
    confirmLabel?: string;
    path: string;
    done: (result: TResult) => string;
}) {
    const [asking, setAsking] = useState(false);
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<string | null>(null);

    const run = async () => {
        if (confirmLabel && !asking) {
            setAsking(true);
            return;
        }
        setAsking(false);
        setBusy(true);
        setResult(null);
        try {
            setResult(done((await api.post<TResult>(path, {})) ?? ({} as TResult)));
        } catch {
            setResult("failed · nothing changed");
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="flex flex-col gap-1.5">
            <Button
                variant={asking ? "primary" : "secondary"}
                onClick={run}
                onBlur={() => setAsking(false)}
                isLoading={busy}
            >
                {asking ? confirmLabel : label}
            </Button>
            {result && <p className="t-meta text-[var(--text-secondary)]">{result}</p>}
        </div>
    );
}
