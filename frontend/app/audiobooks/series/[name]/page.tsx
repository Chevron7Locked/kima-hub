"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { formatDuration, plural } from "@/lib/format";
import { useAuth } from "@/lib/auth-context";
import { useAudioState, useAudioPlayback, useAudioControls } from "@/lib/audio-context";
import { notify } from "@/lib/notify";
import { LoadingScreen } from "@/components/ui/LoadingScreen";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { SpokenHero } from "@/features/spoken/SpokenHero";
import {
    Book,
    Play,
    Pause,
    CheckCircle,
} from "lucide-react";
import { CachedImage } from "@/components/ui/CachedImage";
import type { Audiobook } from "@/features/audiobook/types";
import { coverArtUrl } from "@/lib/cover-art";

export default function SeriesDetailPage() {
    const params = useParams();
    const { isAuthenticated } = useAuth();
    const { currentAudiobook, playbackType } = useAudioState();
    const { isPlaying } = useAudioPlayback();
    const { playAudiobook, pause, resumeWithGesture } = useAudioControls();

    const seriesName = decodeURIComponent(params.name as string);
    const [books, setBooks] = useState<Audiobook[]>([]);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        if (!isAuthenticated) return;

        let cancelled = false;

        const loadSeries = async () => {
            setIsLoading(true);
            try {
                const data = await api.getAudiobookSeries(seriesName);
                if (!cancelled) setBooks(Array.isArray(data) ? data : []);
            } catch (error: unknown) {
                if (!cancelled) {
                    console.error("Failed to load series:", error);
                    notify.error("Failed to load series");
                }
            } finally {
                if (!cancelled) setIsLoading(false);
            }
        };

        loadSeries();
        return () => { cancelled = true; };
    }, [seriesName, isAuthenticated]);

    if (isLoading) {
        return <LoadingScreen />;
    }

    if (books.length === 0) {
        return (
            <div className="flex items-center justify-center min-h-screen bg-[var(--bg-primary)]">
                <p className="text-xs text-[var(--text-muted)]">
                    No books found in this series
                </p>
            </div>
        );
    }

    const firstBook = books[0];
    const author = firstBook.author;
    const genres = firstBook.genres || [];
    const totalDuration = books.reduce((sum, book) => sum + book.duration, 0);
    const heroImage = coverArtUrl(firstBook.coverUrl, 500);

    return (
        <div className="min-h-screen bg-gradient-to-b from-[#0a0a0a] to-black section-stack">
            <SpokenHero
                kind="series"
                title={seriesName}
                author={author}
                details={[
                    { text: plural(books.length, "book") },
                    { text: formatDuration(totalDuration) },
                ]}
                tags={genres.slice(0, 5).map((label) => ({ label }))}
                heroImage={heroImage}
                colors={null}
            />

            <div className="relative page-shell page-end animate-rise">
                <div>
                    <div>
                        <SectionHeader type="audiobook" title="Books in Series" count={books.length} />

                        <div className="space-y-0.5">
                            {books.map((book, index) => {
                                const isCurrentBook =
                                    currentAudiobook?.id === book.id &&
                                    playbackType === "audiobook";
                                const isBookPlaying = isCurrentBook && isPlaying;
                                const bookCover = coverArtUrl(book.coverUrl, 100);

                                return (
                                    <div
                                        key={book.id}
                                        className={`group relative rounded-lg transition-all ${
                                            isCurrentBook
                                                ? "bg-white/5 border border-type-audiobook/30"
                                                : "border border-transparent hover:bg-white/[0.03] hover:border-white/5"
                                        }`}
                                    >
                                        {book.progress && book.progress.progress > 0 && !book.progress.isFinished && (
                                            <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-white/5 rounded-full overflow-hidden">
                                                <div
                                                    className="h-full bg-brand transition-all"
                                                    style={{ width: `${book.progress.progress}%` }}
                                                />
                                            </div>
                                        )}

                                        <div className="flex items-center gap-4 px-3 py-3">
                                            <div className="w-8 flex items-center justify-center shrink-0">
                                                {book.progress?.isFinished ? (
                                                    <CheckCircle className="w-4 h-4 text-success" aria-label="finished" />
                                                ) : (
                                                    <button
                                                        type="button"
                                                        aria-label={isBookPlaying ? `pause ${book.title}` : `play ${book.title}`}
                                                        onClick={() => {
                                                            if (isBookPlaying) pause();
                                                            else if (isCurrentBook) resumeWithGesture();
                                                            else playAudiobook(book);
                                                        }}
                                                        className="group/play w-8 h-8 flex items-center justify-center rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                                                    >
                                                        {isBookPlaying ? (
                                                            <Pause className="w-4 h-4 text-brand" />
                                                        ) : (
                                                            <>
                                                                {/* The number until the row is hovered or the button focused; on touch screens, the play icon. */}
                                                                <span className={`text-xs tabular-nums ${
                                                                    isCurrentBook ? "hidden" : "text-[var(--text-muted)] group-hover:hidden group-focus-visible/play:hidden [@media(hover:none)]:hidden"
                                                                }`}>
                                                                    {book.series?.sequence || index + 1}
                                                                </span>
                                                                <Play className={`w-4 h-4 ${
                                                                    isCurrentBook
                                                                        ? "text-brand"
                                                                        : "text-white hidden group-hover:block group-focus-visible/play:block [@media(hover:none)]:block"
                                                                }`} />
                                                            </>
                                                        )}
                                                    </button>
                                                )}
                                            </div>

                                            <Link href={`/audiobooks/${book.id}`}>
                                                <div className="relative w-10 h-10 rounded overflow-hidden bg-[var(--bg-primary)] border border-white/10 shrink-0 cursor-pointer">
                                                    {bookCover ? (
                                                        <CachedImage
                                                            src={bookCover}
                                                            alt={book.title}
                                                            fill
                                                            sizes="40px"
                                                            className="object-cover"
                                                        />
                                                    ) : (
                                                        <div className="w-full h-full flex items-center justify-center">
                                                            <Book className="w-4 h-4 text-white/10" />
                                                        </div>
                                                    )}
                                                </div>
                                            </Link>

                                            <Link
                                                href={`/audiobooks/${book.id}`}
                                                className="flex-1 min-w-0"
                                            >
                                                <h3 className={`font-bold truncate text-sm tracking-tight ${
                                                    isCurrentBook ? "text-brand" : "text-white"
                                                }`}>
                                                    {book.title}
                                                </h3>
                                                <p className="text-xs tabular-nums text-[var(--text-muted)] truncate mt-0.5">
                                                    {book.narrator || book.author}
                                                </p>
                                            </Link>

                                            {book.progress?.isFinished ? (
                                                <span className="text-xs text-success shrink-0">
                                                    Finished
                                                </span>
                                            ) : book.progress && book.progress.progress > 0 ? (
                                                <span className="text-xs tabular-nums text-brand shrink-0">
                                                    {Math.round(book.progress.progress)}%
                                                </span>
                                            ) : null}

                                            <span className="text-xs tabular-nums text-[var(--text-muted)] shrink-0">
                                                {formatDuration(book.duration)}
                                            </span>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
