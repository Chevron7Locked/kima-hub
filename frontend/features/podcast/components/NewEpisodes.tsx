"use client";

import Link from "next/link";
import { Mic2, Pause, Play } from "lucide-react";
import { cn } from "@/lib/cn";
import { CachedImage } from "@/components/ui/CachedImage";
import { coverArtUrl } from "@/lib/cover-art";
import { formatDuration } from "@/lib/format";
import { formatDate } from "../utils";
import { usePlayEpisode } from "../hooks/usePlayEpisode";
import type { ListeningRow } from "../types";

/** Each followed show's newest episode while unplayed: show, title, date and length, playable in place. */
export function NewEpisodes({ rows }: { rows: ListeningRow[] }) {
    const { toggle, isPlayingRow } = usePlayEpisode();
    return (
        <ul className="flex flex-col gap-1">
            {rows.map((row) => {
                const playing = isPlayingRow(row);
                const cover = coverArtUrl(row.episode.coverUrl || row.podcast.coverUrl, 120);
                return (
                    <li
                        key={row.episode.id}
                        className={cn(
                            "group flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-white/5",
                            playing && "bg-white/5",
                        )}
                    >
                        <Link
                            href={`/podcasts/${row.podcast.id}`}
                            className="relative size-12 shrink-0 overflow-hidden rounded-md bg-[var(--bg-secondary)]"
                            aria-label={`open ${row.podcast.title}`}
                        >
                            {cover ? (
                                <CachedImage src={cover} alt="" fill sizes="48px" className="object-cover" />
                            ) : (
                                <Mic2 className="absolute inset-0 m-auto size-5 text-[var(--text-muted)]" />
                            )}
                        </Link>
                        <div className="min-w-0 flex-1">
                            <p className="truncate text-xs text-[var(--text-muted)]">{row.podcast.title}</p>
                            <p className={cn("truncate text-sm font-semibold", playing ? "text-brand" : "text-white")}>
                                {row.episode.title}
                            </p>
                            <p className="text-xs tabular-nums text-[var(--text-muted)]">
                                {formatDate(String(row.episode.publishedAt))}
                                {row.episode.duration > 0 && ` · ${formatDuration(row.episode.duration)}`}
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={() => toggle(row)}
                            aria-label={playing ? `pause ${row.episode.title}` : `play ${row.episode.title}`}
                            className="flex size-10 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-brand hover:text-[var(--color-on-brand)] focus-visible:bg-brand focus-visible:text-[var(--color-on-brand)]"
                        >
                            {playing ? <Pause className="size-4 fill-current" /> : <Play className="size-4 fill-current ml-0.5" />}
                        </button>
                    </li>
                );
            })}
        </ul>
    );
}
