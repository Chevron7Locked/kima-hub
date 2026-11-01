"use client";

import { useEffect, useState, useMemo } from "react";
import { STORAGE_KEYS } from "@/lib/storage-keys";
import { useRouter } from "next/navigation";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { LoadingScreen } from "@/components/ui/LoadingScreen";
import { MediaCard } from "@/components/cards/MediaCard";
import { api } from "@/lib/api";
import { useAudioState, useAudioControls } from "@/lib/audio-context";
import { notify } from "@/lib/notify";
import { useAudiobooksQuery, queryKeys } from "@/hooks/useQueries";
import { useQueryClient } from "@tanstack/react-query";
import {
    Book,
    CheckCircle,
    ListTree,
    Shuffle,
    ArrowUpDown,
    RefreshCw,
} from "lucide-react";
import { shuffleArray } from "@/lib/shuffle";
import { Pagination } from "@/components/ui/Pagination";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Button } from "@/components/ui/Button";
import { scrollMainToTop } from "@/lib/scroll";
import type { Audiobook } from "@/features/audiobook/types";
import { coverArtUrl } from "@/lib/cover-art";

type FilterType = "all" | "listening" | "finished";
type SortType = "title" | "author" | "recent" | "series";

function BookCard({ book, index }: { book: Audiobook; index: number }) {
    return (
        <MediaCard
            href={`/audiobooks/${book.id}`}
            title={book.title}
            subtitle={book.author}
            imageUrl={coverArtUrl(book.coverUrl)}
            fallbackIcon={Book}
            type="audiobook"
            aspect="portrait"
            index={index}
            progress={book.progress?.isFinished ? undefined : book.progress?.progress}
            corner={book.progress?.isFinished && <CheckCircle className="w-5 h-5 text-success" aria-label="Finished" />}
        />
    );
}

function BookSection({
    title,
    books,
    count = books.length,
    section,
}: {
    title: string;
    books: Audiobook[];
    count?: number;
    section: string;
}) {
    return (
        <div>
            <SectionHeader type="audiobook" title={title} count={count} />
            <div className="grid-media" data-tv-section={section}>
                {books.map((book, index) => (
                    <BookCard key={book.id} book={book} index={index} />
                ))}
            </div>
        </div>
    );
}

export default function AudiobooksPage() {
    const router = useRouter();
    const { currentAudiobook } = useAudioState();
    const { pause } = useAudioControls();

    const queryClient = useQueryClient();
    const { data: audiobooksData, isLoading, error, refetch } = useAudiobooksQuery();
    const [isSyncing, setIsSyncing] = useState(false);

    const [filter, setFilter] = useState<FilterType>("all");
    const [sortBy, setSortBy] = useState<SortType>("title");
    const [selectedGenre, setSelectedGenre] = useState<string | null>(null);
    const [groupBySeries, setGroupBySeries] = useState(false);
    const [itemsPerPage, setItemsPerPage] = useState<number>(50);
    const [currentPage, setCurrentPage] = useState(1);
    const showPage = (page: number) => {
        setCurrentPage(page);
        scrollMainToTop();
    };

    const isConfigured = !(
        audiobooksData &&
        "configured" in audiobooksData &&
        audiobooksData.configured === false
    );
    const audiobooks: Audiobook[] = useMemo(
        () => (Array.isArray(audiobooksData) ? audiobooksData : []),
        [audiobooksData]
    );

    useEffect(() => {
        if (!isConfigured && currentAudiobook) {
            pause();
            if (typeof window !== "undefined") {
                localStorage.removeItem(STORAGE_KEYS.CURRENT_AUDIOBOOK);
                localStorage.removeItem(STORAGE_KEYS.PLAYBACK_TYPE);
            }
        }
    }, [isConfigured, currentAudiobook, pause]);

    const continueListening = useMemo(() => {
        const inProgress = audiobooks.filter(
            (book) =>
                book.progress &&
                book.progress.progress > 0 &&
                !book.progress.isFinished
        );

        if (currentAudiobook && !inProgress.find(b => b.id === currentAudiobook.id)) {
            const currentBook = audiobooks.find(b => b.id === currentAudiobook.id);
            if (currentBook) {
                return [currentBook, ...inProgress];
            }
        }
        return inProgress;
    }, [audiobooks, currentAudiobook]);

    const allGenres = useMemo(() =>
        Array.from(
            new Set(audiobooks.flatMap((book) => book.genres || []))
        ).sort(),
    [audiobooks]);

    const filteredBooks = useMemo(() => {
        let filtered = audiobooks;
        switch (filter) {
            case "listening":
                filtered = continueListening;
                break;
            case "finished":
                filtered = audiobooks.filter(
                    (book) => book.progress?.isFinished
                );
                break;
        }

        if (selectedGenre) {
            filtered = filtered.filter((book) =>
                book.genres?.includes(selectedGenre)
            );
        }

        const sorted = [...filtered];
        switch (sortBy) {
            case "title":
                sorted.sort((a, b) => a.title.localeCompare(b.title));
                break;
            case "author":
                sorted.sort((a, b) => a.author.localeCompare(b.author));
                break;
            case "recent":
                sorted.sort((a, b) => {
                    const aTime = a.progress?.lastPlayedAt
                        ? new Date(a.progress.lastPlayedAt).getTime()
                        : 0;
                    const bTime = b.progress?.lastPlayedAt
                        ? new Date(b.progress.lastPlayedAt).getTime()
                        : 0;
                    return bTime - aTime;
                });
                break;
            case "series":
                sorted.sort((a, b) => {
                    if (a.series && !b.series) return -1;
                    if (!a.series && b.series) return 1;
                    if (a.series && b.series) {
                        if (a.series.name === b.series.name) {
                            const aSeq = parseFloat(a.series.sequence || "0");
                            const bSeq = parseFloat(b.series.sequence || "0");
                            return aSeq - bSeq;
                        }
                        return a.series.name.localeCompare(b.series.name);
                    }
                    return a.title.localeCompare(b.title);
                });
                break;
        }

        return sorted;
    }, [audiobooks, filter, continueListening, selectedGenre, sortBy]);

    const paginatedBooks = useMemo(() => {
        const start = (currentPage - 1) * itemsPerPage;
        return filteredBooks.slice(start, start + itemsPerPage);
    }, [filteredBooks, currentPage, itemsPerPage]);

    const filterKey = `${filter}-${sortBy}-${selectedGenre}-${groupBySeries}`;
    const [prevFilterKey, setPrevFilterKey] = useState(filterKey);
    if (prevFilterKey !== filterKey) {
        setPrevFilterKey(filterKey);
        setCurrentPage(1);
    }

    const { series, standalone } = useMemo(() => {
        const seriesMap = new Map<string, Audiobook[]>();
        const standaloneBooks: Audiobook[] = [];

        filteredBooks.forEach((book) => {
            if (book.series && book.series.name && book.series.name.trim() !== "") {
                const seriesName = book.series.name.trim();
                if (!seriesMap.has(seriesName)) {
                    seriesMap.set(seriesName, []);
                }
                seriesMap.get(seriesName)!.push(book);
            } else {
                standaloneBooks.push(book);
            }
        });

        seriesMap.forEach((books) => {
            books.sort((a, b) => {
                const aSeq = parseFloat(a.series?.sequence || "0");
                const bSeq = parseFloat(b.series?.sequence || "0");
                return aSeq - bSeq;
            });
        });

        return { series: Array.from(seriesMap.entries()), standalone: standaloneBooks };
    }, [filteredBooks]);

    // The series view groups the whole library, then pages over its cards (a series or a
    // standalone book each), so a series is never split across pages.
    const pageStart = (currentPage - 1) * itemsPerPage;
    const pageEnd = pageStart + itemsPerPage;
    const pageSeries = series.slice(pageStart, pageEnd);
    const pageStandalone = standalone.slice(
        Math.max(0, pageStart - series.length),
        Math.max(0, pageEnd - series.length),
    );
    const totalPages = Math.ceil(
        (groupBySeries ? series.length + standalone.length : filteredBooks.length) / itemsPerPage,
    );

    const handleShuffleAudiobooks = () => {
        if (audiobooks.length === 0) {
            notify.error("No audiobooks to shuffle");
            return;
        }
        const shuffled = shuffleArray(audiobooks);
        if (shuffled[0]) {
            router.push(`/audiobooks/${shuffled[0].id}`);
        }
    };

    const handleSync = async () => {
        if (isSyncing) return;
        setIsSyncing(true);
        try {
            const res = await api.post<{
                success: boolean;
                result?: { synced: number; failed: number; skipped: number; errors: string[] };
                error?: string;
            }>("/audiobooks/sync", {});
            if (!res?.success) {
                notify.error("Audiobook sync failed", { message: res?.error });
                return;
            }
            const r = res.result;
            if (r && r.failed > 0) {
                notify.error("Some audiobooks failed to sync", {
                    message: `Synced ${r.synced}, failed ${r.failed}${r.errors[0] ? `: ${r.errors[0]}` : ""}`,
                });
            }
            await queryClient.refetchQueries({ queryKey: queryKeys.audiobooks() });
        } catch (error) {
            notify.error("Audiobook sync failed", { message: (error as Error)?.message });
        } finally {
            setIsSyncing(false);
        }
    };

    if (isLoading) {
        return <LoadingScreen />;
    }

    if (error && isConfigured) {
        return (
            <div className="page-shell pt-8">
                <div role="alert" className="rounded-lg border border-danger/30 bg-danger/10 p-6 max-w-xl">
                    <h1 className="text-lg font-semibold text-[var(--text-primary)]">
                        Couldn&apos;t load audiobooks
                    </h1>
                    <p className="mt-1 text-xs text-[var(--text-muted)]">{(error as Error).message}</p>
                    <Button variant="primary" onClick={() => refetch()} className="mt-4">
                        Try again
                    </Button>
                </div>
            </div>
        );
    }

    if (!isConfigured) {
        return (
            <div className="min-h-screen">
                <PageHeader
                    title="Audiobooks"
                    description="Connect Audiobookshelf to listen to your audiobooks here"
                />

                <div className="relative page-shell page-end">

                    <div className="grid md:grid-cols-3 gap-4 mb-12">
                        {[
                            { num: "01", title: "Install Audiobookshelf", desc: "Set up your own Audiobookshelf instance via Docker or use an existing installation" },
                            { num: "02", title: "Get API Key", desc: "Settings > Users > Click your user > API Tokens > Generate" },
                            { num: "03", title: "Configure", desc: "Enter your Audiobookshelf URL and API key in Kima settings" },
                        ].map((step) => (
                            <div
                                key={step.num}
                                className="rounded-lg border border-white/10 bg-[var(--bg-primary)] p-6 hover:border-type-audiobook/30 transition-all"
                            >
                                {/* 20% opacity put this at 1.4:1, and it is the
                                    only thing on the card saying which step
                                    comes first. 60% clears the 3:1 that text
                                    this size needs. */}
                                <div className="text-3xl font-bold text-brand/60 mb-3 tracking-tight">
                                    {step.num}
                                </div>
                                <h3 className="text-sm font-bold text-white tracking-tight mb-2">
                                    {step.title}
                                </h3>
                                <p className="text-xs tabular-nums text-[var(--text-muted)] leading-relaxed">
                                    {step.desc}
                                </p>
                            </div>
                        ))}
                    </div>

                    <div className="flex flex-col sm:flex-row gap-3 max-w-xl">
                        <Button
                            variant="primary"
                            size="lg"
                            onClick={() => router.push("/settings#audiobookshelf")}
                            className="flex-1"
                        >
                            Configure Audiobookshelf
                        </Button>
                        <Button
                            size="lg"
                            onClick={() => window.open("https://hub.docker.com/r/advplyr/audiobookshelf", "_blank")}
                            className="flex-1"
                        >
                            Install via Docker
                        </Button>
                    </div>

                    <div className="mt-8">
                        <a
                            href="https://github.com/advplyr/audiobookshelf"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-[var(--text-muted)] hover:text-white/60 transition-colors"
                        >
                            View Documentation
                        </a>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen">
            <PageHeader
                title="Audiobooks"
                description={`${audiobooks.length} ${audiobooks.length === 1 ? "book" : "books"}`}
                className="pb-2"
            />

            <div className="relative page-shell page-end animate-rise">
                <div className="mb-8 space-y-3">
                    {/* First Row: Filter Pills and Shuffle */}
                    <div className="flex flex-wrap items-center gap-2">
                        {(["all", "listening", "finished"] as FilterType[]).map((f) => (
                            <Button
                                key={f}
                                variant={filter === f ? "primary" : "secondary"}
                                size="sm"
                                onClick={() => setFilter(f)}
                            >
                                {f === "all" ? "All Books" : f === "listening" ? "In Progress" : "Finished"}
                            </Button>
                        ))}

                        <Button
                            variant="primary"
                            size="sm"
                            onClick={handleShuffleAudiobooks}
                        >
                            <Shuffle className="w-3.5 h-3.5" />
                            <span className="hidden sm:inline">Random</span>
                        </Button>

                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={handleSync}
                            disabled={isSyncing}
                            title="sync audiobooks from audiobookshelf"
                        >
                            <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? "animate-spin" : ""}`} />
                            <span className="hidden sm:inline">{isSyncing ? "Syncing..." : "Sync"}</span>
                        </Button>

                        <span className="hidden md:inline text-xs tabular-nums text-[var(--text-muted)] ml-auto">
                            {filteredBooks.length} {filteredBooks.length === 1 ? "book" : "books"}
                        </span>
                    </div>

                    {/* Second Row: Sort, Series View, Genre */}
                    <div className="flex flex-wrap items-center gap-2">
                        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 border border-white/10">
                            <ArrowUpDown className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                            <select
                                value={sortBy}
                                onChange={(e) => setSortBy(e.target.value as SortType)}
                                className="bg-transparent text-xs text-[var(--text-secondary)] focus:outline-none cursor-pointer [&>option]:bg-[var(--bg-primary)] [&>option]:text-white"
                            >
                                <option value="title">title</option>
                                <option value="author">author</option>
                                <option value="recent">recently played</option>
                                <option value="series">series</option>
                            </select>
                        </div>

                        <Button
                            variant={groupBySeries ? "primary" : "secondary"}
                            size="sm"
                            onClick={() => setGroupBySeries(!groupBySeries)}
                            title="show series as single cards"
                        >
                            <ListTree className="w-3.5 h-3.5" />
                            <span className="hidden sm:inline">Series View</span>
                        </Button>

                        {allGenres.length > 0 && (
                            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 border border-white/10">
                                <select
                                    value={selectedGenre || ""}
                                    onChange={(e) => setSelectedGenre(e.target.value || null)}
                                    className="bg-transparent text-xs text-[var(--text-secondary)] focus:outline-none cursor-pointer min-w-0 max-w-[140px] truncate [&>option]:bg-[var(--bg-primary)] [&>option]:text-white"
                                >
                                    <option value="">all genres</option>
                                    {allGenres.map((genre) => (
                                        <option key={genre} value={genre}>
                                            {genre.toLowerCase()}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        )}

                        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 border border-white/10">
                            <select
                                value={itemsPerPage}
                                onChange={(e) => {
                                    setItemsPerPage(Number(e.target.value));
                                    setCurrentPage(1);
                                }}
                                className="bg-transparent text-xs tabular-nums text-[var(--text-secondary)] focus:outline-none cursor-pointer [&>option]:bg-[var(--bg-primary)] [&>option]:text-white"
                            >
                                <option value={25}>25 per page</option>
                                <option value={50}>50 per page</option>
                                <option value={100}>100 per page</option>
                                <option value={250}>250 per page</option>
                            </select>
                        </div>
                    </div>

                    <div className="md:hidden text-xs tabular-nums text-[var(--text-muted)]">
                        {filteredBooks.length} {filteredBooks.length === 1 ? "book" : "books"}
                    </div>
                </div>

                <div className="section-stack">
                    {continueListening.length > 0 && filter === "all" && !groupBySeries && (
                        <BookSection title="Continue Listening" books={continueListening} section="continue-listening" />
                    )}

                    {filteredBooks.length > 0 ? (
                        groupBySeries ? (
                            <>
                                {pageSeries.length > 0 && (
                                    <div>
                                        <SectionHeader type="audiobook" title="Series" count={series.length} />
                                        <div
                                            className="grid-media"
                                            data-tv-section="series"
                                        >
                                            {pageSeries.map(([seriesName, books], index) => {
                                                const firstBook = books[0];
                                                const bookCount = `${books.length} ${books.length === 1 ? "book" : "books"}`;
                                                return (
                                                    <MediaCard
                                                        key={seriesName}
                                                        href={`/audiobooks/series/${encodeURIComponent(seriesName)}`}
                                                        title={seriesName}
                                                        subtitle={firstBook.author}
                                                        imageUrl={coverArtUrl(firstBook.coverUrl)}
                                                        fallbackIcon={Book}
                                                        type="audiobook"
                                                        aspect="portrait"
                                                        index={index}
                                                        corner={<span className="block bg-brand text-black rounded px-2 py-0.5 text-xs font-semibold">{bookCount}</span>}
                                                    />
                                                );
                                            })}
                                        </div>
                                    </div>
                                )}

                                {pageStandalone.length > 0 && (
                                    <BookSection
                                        title="Standalone"
                                        books={pageStandalone}
                                        count={standalone.length}
                                        section="standalone"
                                    />
                                )}
                            </>
                        ) : (
                            <BookSection
                                title="All Books"
                                books={paginatedBooks}
                                count={filteredBooks.length}
                                section="audiobooks"
                            />
                        )
                    ) : (
                        <EmptyState
                            icon={<Book className="w-12 h-12" />}
                            title={
                                filter === "listening"
                                    ? "No audiobooks in progress"
                                    : filter === "finished"
                                    ? "No finished audiobooks"
                                    : "No audiobooks found"
                            }
                            description={
                                filter === "all"
                                    ? "Add audiobooks to your Audiobookshelf library to get started"
                                    : "Start listening to some audiobooks"
                            }
                        />
                    )}

                    <Pagination
                        currentPage={currentPage}
                        totalPages={totalPages}
                        onPageChange={showPage}
                        label="Audiobooks"
                        className="mt-0"
                    />
                </div>
            </div>
        </div>
    );
}
