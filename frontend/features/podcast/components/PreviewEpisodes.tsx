"use client";

import { PodcastPreview } from "../types";
import { formatDuration } from "@/lib/format";
import { formatDate } from "../utils";
import { SectionHeader } from "@/components/ui/SectionHeader";

/**
 * Feed summaries carry markup; the list shows their words only. Read from a parsed document, not sanitised
 * markup, which still holds escapes (&amp;, &nbsp;) that would show as text. Parsed documents run no scripts;
 * script and style contents are dropped so their code never shows as words.
 */
export function plain(html: string | undefined): string {
    if (!html) return "";
    const body = new DOMParser().parseFromString(html, "text/html").body;
    body.querySelectorAll("script, style, noscript, template").forEach((el) => el.remove());
    return (body.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** A show's newest episodes before following: titles, dates, lengths and what each is about. */
export function PreviewEpisodes({ previewData }: { previewData: PodcastPreview }) {
    const episodes = previewData.previewEpisodes ?? [];
    return (
        <section>
            <SectionHeader title="latest episodes" type="podcast" />
            {episodes.length === 0 ? (
                <p className="text-sm text-[var(--text-muted)]">this feed lists no episodes right now</p>
            ) : (
                <>
                    <p className="-mt-2 mb-4 text-xs text-[var(--text-muted)]">follow the show to play these; the first episode plays above.</p>
                    <ol className="flex flex-col divide-y divide-white/5">
                        {episodes.map((ep, index) => {
                            const summary = plain(ep.description);
                            return (
                                <li key={`${ep.title}-${index}`} className="py-3">
                                    <h3 className="text-sm font-semibold text-white">{ep.title}</h3>
                                    <p className="mt-0.5 text-xs tabular-nums text-[var(--text-muted)]">
                                        {formatDate(ep.publishedAt)}
                                        {ep.duration > 0 && ` · ${formatDuration(ep.duration)}`}
                                    </p>
                                    {summary && (
                                        <p className="mt-1.5 line-clamp-2 max-w-[70ch] text-sm leading-relaxed text-[var(--text-secondary)]">{summary}</p>
                                    )}
                                </li>
                            );
                        })}
                    </ol>
                </>
            )}
        </section>
    );
}
