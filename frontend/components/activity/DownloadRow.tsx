"use client";

import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Disc3, Music } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { isMbid } from "@/lib/mbid";
import { timeAgo } from "@/lib/relative-time";
import { CachedImage } from "@/components/ui/CachedImage";

export interface DownloadRowItem {
    id: string;
    subject: string;
    type: string;
    status: string;
    targetMbid?: string | null;
    error?: string;
    createdAt: string;
    completedAt?: string;
    metadata?: { [key: string]: unknown };
}

type Tone = "active" | "completed" | "failed";

const STATUS_LABEL: Record<string, string> = {
    pending: "Queued",
    processing: "Downloading",
};

function text(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value : undefined;
}

function useAlbumCover(mbid: string | null | undefined, enabled: boolean) {
    const { data } = useQuery({
        queryKey: ["album-cover", mbid],
        queryFn: async () => {
            const res = await api.request<{ coverUrl?: string }>(`/library/album-cover/${encodeURIComponent(String(mbid))}`, { expectedStatuses: [404] });
            return res.coverUrl ? api.getCoverArtUrl(res.coverUrl, 112) : null;
        },
        enabled: enabled && isMbid(mbid),
        staleTime: Infinity,
        retry: false,
    });
    return data ?? null;
}

export function DownloadRow({
    item,
    tone,
    actions,
    notice,
}: {
    item: DownloadRowItem;
    tone: Tone;
    actions: ReactNode;
    /** The outcome of an action taken on the row, shown on it. */
    notice?: string;
}) {
    const album = text(item.metadata?.albumTitle);
    const artist = text(item.metadata?.artistName);
    const title = album && artist ? album : item.subject;
    const source = text(item.metadata?.statusText);
    const progress = typeof item.metadata?.progress === "number" ? item.metadata.progress : undefined;
    const lastError = tone === "active" ? text(item.metadata?.lastError) : item.error;
    const cover = useAlbumCover(item.targetMbid, item.type === "album");
    const FallbackIcon = item.type === "album" ? Disc3 : Music;
    const when = timeAgo(tone === "active" ? item.createdAt : item.completedAt || item.createdAt);

    return (
        <li className="group rounded-xl transition-colors hover:bg-white/[0.03]">
            <div className="grid grid-cols-[48px_minmax(0,1fr)_auto] items-center gap-3 px-2 py-2">
                <div
                    className={cn(
                        "relative size-12 overflow-hidden rounded-lg border border-white/10 bg-[var(--color-type-album)]/15",
                        tone === "failed" && "grayscale"
                    )}
                >
                    {cover ? (
                        <CachedImage src={cover} alt="" sizes="48px" fill className="object-cover" />
                    ) : (
                        <FallbackIcon className="absolute inset-0 m-auto size-5 text-white/35" aria-hidden />
                    )}
                    {tone === "active" && (
                        <span className="absolute inset-x-0 bottom-0 h-[3px] overflow-hidden bg-black/60" aria-hidden>
                            {progress === undefined ? (
                                <span className="block h-full w-1/3 animate-sweep bg-brand" />
                            ) : (
                                <span className="block h-full bg-brand transition-[width]" style={{ width: `${progress}%` }} />
                            )}
                        </span>
                    )}
                    {tone === "completed" && (
                        <span className="absolute bottom-1 right-1 flex size-4 items-center justify-center rounded-full bg-black/70" aria-hidden>
                            <Check className="size-2.5 text-[var(--color-success)]" strokeWidth={3} />
                        </span>
                    )}
                </div>

                <div className="min-w-0">
                    <p
                        className={cn(
                            "truncate text-sm font-medium leading-5",
                            tone === "failed" ? "text-white/70" : "text-white"
                        )}
                        title={item.subject?.toLowerCase()}
                    >
                        {title}
                    </p>
                    <p className="truncate text-xs leading-4 text-[var(--text-muted)] tabular-nums">
                        {[
                            album && artist ? artist : undefined,
                            tone === "active" ? source ?? STATUS_LABEL[item.status] ?? item.status : undefined,
                            tone === "failed" ? "Failed" : undefined,
                            when,
                        ]
                            .filter(Boolean)
                            .join(" · ")}
                    </p>
                    {lastError && (
                        <p className="mt-0.5 truncate text-xs leading-4 text-danger-light/80" title={lastError?.toLowerCase()}>
                            {lastError}
                        </p>
                    )}
                    {notice && (
                        <p role="status" className="mt-0.5 truncate text-xs leading-4 text-danger-light" title={notice.toLowerCase()}>
                            {notice}
                        </p>
                    )}
                </div>

                <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 touch-reveal">
                    {actions}
                </div>
            </div>
        </li>
    );
}

export function RowAction({
    label,
    onClick,
    disabled,
    danger,
    children,
}: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
    danger?: boolean;
    children: ReactNode;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            aria-label={label}
            title={label.toLowerCase()}
            className={cn(
                "flex size-8 items-center justify-center rounded-lg text-[var(--text-muted)] transition-colors",
                "hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-50",
                danger ? "hover:text-danger-light" : "hover:text-white"
            )}
        >
            {children}
        </button>
    );
}
