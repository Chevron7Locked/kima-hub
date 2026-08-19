"use client";

import { useEffect, useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { EmptyState } from "@/components/ui/EmptyState";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { AudiobookCard } from "@/components/ui/AudiobookCard";
import { api } from "@/lib/api";
import { useAudioState, useAudioControls } from "@/lib/audio-context";
import { useAuth } from "@/lib/auth-context";
import { useToast } from "@/lib/toast-context";
import { useAudiobooksQuery, queryKeys } from "@/hooks/useQueries";
import { useQueryClient } from "@tanstack/react-query";
import {
    Book,
    ListTree,
    Shuffle,
    ArrowUpDown,
    RefreshCw,
} from "lucide-react";
import { shuffleArray } from "@/utils/shuffle";
import { Pagination } from "@/components/ui/Pagination";

interface Audiobook {
    id: string;
    title: string;
    author: string;
    narrator?: string;
    description?: string;
    coverUrl: string | null;
    duration: number;
    libraryId: string;
    series?: {
        name: string;
        sequence: string;
    } | null;
    genres?: string[];
    progress: {
        currentTime: number;
        progress: number;
        isFinished: boolean;
        lastPlayedAt: Date;
    } | null;
}

type FilterType = "all" | "listening" | "finished";
type SortType = "title" | "author" | "recent" | "series";

function SectionHeader({ title, count, children }: { title: string; count?: number; children?: React.ReactNode }) {
    return (
        <div className="flex items-center gap-3 mb-6">
            <span className="w-1 h-8 bg-gradient-to-b from-[#f59e0b] to-[#d97706] rounded-full shrink-0" />
            <h2 className="text-2xl font-bold tracking-tight">{title}</h2>
            {count !== undefined && (
                <span className="text-xs tabular-nums text-[#f59e0b]">{count}</span>
            )}
            <span className="flex-1 border-t border-white/10" />
            {children}
        </div>
    );
}

export default function AudiobooksPage() {
    const router = useRouter();
    useAuth();
    const { toast } = useToast();
    const { currentAudiobook } = useAudioState();
    const { pause } = useAudioControls();

    const queryClient = useQueryClient();
    const { data: audiobooksData, isLoading, error } = useAudiobooksQuery();
    const [isSyncing, setIsSyncing] = useState(false);

    const [filter, setFilter] = useState<FilterType>("all");
    const [sortBy, setSortBy] = useState<SortType>("title");
    const [selectedGenre, setSelectedGenre] = useState<string | null>(null);
    const [groupBySeries, setGroupBySeries] = useState(false);
    const [itemsPerPage, setItemsPerPage] = useState<number>(50);
    const [currentPage, setCurrentPage] = useState(1);

    const isConfigured =
        !error &&
        (!audiobooksData ||
            !("configured" in audiobooksData) ||
            audiobooksData.configured !== false);
    const audiobooks: Audiobook[] = useMemo(
        () => (Array.isArray(audiobooksData) ? audiobooksData : []),
        [audiobooksData]
    );

    useEffect(() => {
        if (!isConfigured && currentAudiobook) {
            pause();
            if (typeof window !== "undefined") {
                localStorage.removeItem("kima_current_audiobook");
                localStorage.removeItem("kima_playback_type");
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

    const totalPages = Math.ceil(filteredBooks.length / itemsPerPage);
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

        paginatedBooks.forEach((book) => {
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
    }, [paginatedBooks]);

    const getCoverUrl = (coverUrl: string | null, size = 300) => {
        if (!coverUrl) return null;
        return api.getCoverArtUrl(coverUrl, size);
    };

    const handleShuffleAudiobooks = () => {
        if (audiobooks.length === 0) {
            toast.error("No audiobooks to shuffle");
            return;
        }
        const shuffled = shuffleArray(audiobooks);
        if (shuffled[0]) {
            toast.success(`Playing random audiobook: ${shuffled[0].title}`);
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
                toast.error(res?.error || "Audiobook sync failed");
                return;
            }
            const r = res.result;
            if (r && r.failed > 0) {
                toast.error(
                    `Synced ${r.synced}, failed ${r.failed}${r.errors[0] ? `: ${r.errors[0]}` : ""}`
                );
            } else if (r) {
                toast.success(`Synced ${r.synced} audiobooks`);
            }
            await queryClient.refetchQueries({ queryKey: queryKeys.audiobooks() });
        } catch (error) {
            toast.error((error as Error)?.message || "Audiobook sync failed");
        } finally {
            setIsSyncing(false);
        }
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center min-h-screen bg-[var(--bg-primary)]">
                <GradientSpinner size="md" />
            </div>
        );
    }

    if (!isConfigured) {
        return (
            <div className="min-h-screen bg-gradient-to-b from-[#0a0a0a] to-black relative overflow-hidden">
                {/* Atmospheric overlay */}
                <div className="fixed inset-0 pointer-events-none opacity-30">
                    <div className="absolute inset-0 bg-gradient-to-br from-[#f59e0b]/5 via-transparent to-transparent" />
                </div>

                <div className="relative px-4 md:px-8 py-16 md:py-24 max-w-[1800px] mx-auto">
                    {/* Editorial hero */}
                    <div className="mb-16">
                        <div className="flex items-center gap-2 mb-4">
                            <div className="w-1.5 h-1.5 bg-[#f59e0b] rounded-full" />
                            <span className="t-eyebrow">
                                Not Configured
                            </span>
                        </div>
                        <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight text-white leading-none mb-4">
                            Audio<br />
                            <span className="text-[#f59e0b]">books</span>
                        </h1>
                        <p className="text-sm text-[var(--text-muted)] max-w-xl">
                            Connect Audiobookshelf to unlock your audiobook library
                        </p>
                    </div>

                    {/* Setup Steps */}
                    <div className="grid md:grid-cols-3 gap-4 mb-12">
                        {[
                            { num: "01", title: "Install Audiobookshelf", desc: "Set up your own Audiobookshelf instance via Docker or use an existing installation" },
                            { num: "02", title: "Get API Key", desc: "Settings > Users > Click your user > API Tokens > Generate" },
                            { num: "03", title: "Configure", desc: "Enter your Audiobookshelf URL and API key in Kima settings" },
                        ].map((step) => (
                            <div
                                key={step.num}
                                className="rounded-lg border border-white/10 bg-[var(--bg-primary)] p-6 hover:border-[#f59e0b]/30 transition-all"
                            >
                                {/* 20% opacity put this at 1.4:1, and it is the
                                    only thing on the card saying which step
                                    comes first. 60% clears the 3:1 that text
                                    this size needs. */}
                                <div className="text-3xl font-bold text-[#f59e0b]/60 mb-3 tracking-tight">
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

                    {/* Action Buttons */}
                    <div className="flex flex-col sm:flex-row gap-3 max-w-xl">
                        <button
                            onClick={() => router.push("/settings#audiobookshelf")}
                            className="flex-1 h-12 px-6 rounded-lg bg-[#f59e0b] hover:bg-[#d97706] transition-all font-bold text-sm text-black hover:scale-[1.02] active:scale-[0.98]"
                        >
                            Configure Audiobookshelf
                        </button>
                        <button
                            onClick={() => window.open("https://hub.docker.com/r/advplyr/audiobookshelf", "_blank")}
                            className="flex-1 h-12 px-6 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 hover:border-white/20 transition-all font-bold text-sm text-white"
                        >
                            Install via Docker
                        </button>
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
        <div className="min-h-screen bg-gradient-to-b from-[#0a0a0a] to-black relative">
            {/* Atmospheric overlay */}
            <div className="fixed inset-0 pointer-events-none opacity-30">
                <div className="absolute inset-0 bg-gradient-to-br from-[#f59e0b]/5 via-transparent to-transparent" />
            </div>

            {/* Editorial Hero */}
            <div className="relative px-4 md:px-8 pt-8 pb-2">
                <div className="max-w-[1800px] mx-auto">
                    <div className="flex items-center gap-2 mb-4">
                        <div className="w-1.5 h-1.5 bg-[#f59e0b] rounded-full" />
                        <span className="t-eyebrow">
                            Library
                        </span>
                    </div>
                    <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight text-white leading-none mb-2">
                        Audio<br />
                        <span className="text-[#f59e0b]">books</span>
                    </h1>
                    <p className="text-sm tabular-nums text-[var(--text-muted)]">
                        {audiobooks.length} {audiobooks.length === 1 ? "book" : "books"} in library
                    </p>
                </div>
            </div>

            <div className="relative px-4 md:px-8 pb-24">
                <div className="max-w-[1800px] mx-auto">
                    {/* Filter and Sort Controls */}
                    <div className="mb-8 space-y-3">
                        {/* First Row: Filter Pills and Shuffle */}
                        <div className="flex flex-wrap items-center gap-2">
                            {(["all", "listening", "finished"] as FilterType[]).map((f) => (
                                <button
                                    key={f}
                                    onClick={() => setFilter(f)}
                                    className={`px-4 py-2 rounded-lg text-xs font-semibold transition-all ${
                                        filter === f
                                            ? "bg-[#f59e0b] text-black"
                                            : "bg-white/5 text-[var(--text-secondary)] hover:bg-white/10 hover:text-white border border-white/10 hover:border-white/20"
                                    }`}
                                >
                                    {f === "all" ? "All Books" : f === "listening" ? "In Progress" : "Finished"}
                                </button>
                            ))}

                            <button
                                onClick={handleShuffleAudiobooks}
                                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[#f59e0b] hover:bg-[#d97706] text-black font-semibold text-xs transition-all hover:scale-[1.02] active:scale-[0.98]"
                            >
                                <Shuffle className="w-3.5 h-3.5" />
                                <span className="hidden sm:inline">Random</span>
                            </button>

                            <button
                                onClick={handleSync}
                                disabled={isSyncing}
                                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white/5 text-[var(--text-secondary)] hover:bg-white/10 hover:text-white border border-white/10 hover:border-white/20 font-semibold text-xs transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                                title="Sync audiobooks from Audiobookshelf"
                            >
                                <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? "animate-spin" : ""}`} />
                                <span className="hidden sm:inline">{isSyncing ? "Syncing..." : "Sync"}</span>
                            </button>

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
                                    <option value="title">Title</option>
                                    <option value="author">Author</option>
                                    <option value="recent">Recently Played</option>
                                    <option value="series">Series</option>
                                </select>
                            </div>

                            <button
                                onClick={() => setGroupBySeries(!groupBySeries)}
                                className={`px-4 py-2 rounded-lg text-xs font-semibold transition-all flex items-center gap-2 ${
                                    groupBySeries
                                        ? "bg-[#f59e0b] text-black"
                                        : "bg-white/5 text-[var(--text-secondary)] hover:bg-white/10 hover:text-white border border-white/10 hover:border-white/20"
                                }`}
                                title="Show series as single cards"
                            >
                                <ListTree className="w-3.5 h-3.5" />
                                <span className="hidden sm:inline">Series View</span>
                            </button>

                            {allGenres.length > 0 && (
                                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 border border-white/10">
                                    <select
                                        value={selectedGenre || ""}
                                        onChange={(e) => setSelectedGenre(e.target.value || null)}
                                        className="bg-transparent text-xs text-[var(--text-secondary)] focus:outline-none cursor-pointer min-w-0 max-w-[140px] truncate [&>option]:bg-[var(--bg-primary)] [&>option]:text-white"
                                    >
                                        <option value="">All Genres</option>
                                        {allGenres.map((genre) => (
                                            <option key={genre} value={genre}>
                                                {genre}
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

                        {/* Mobile count */}
                        <div className="md:hidden text-xs tabular-nums text-[var(--text-muted)]">
                            {filteredBooks.length} {filteredBooks.length === 1 ? "book" : "books"}
                        </div>
                    </div>

                    <div className="section-stack">
                        {/* Continue Listening Section */}
                        {continueListening.length > 0 && filter === "all" && !groupBySeries && (
                            <div>
                                <SectionHeader title="Continue Listening" count={continueListening.length} />
                                <div
                                    className="grid-media"
                                    data-tv-section="continue-listening"
                                >
                                    {continueListening.map((book, index) => (
                                        <AudiobookCard
                                            key={book.id}
                                            id={book.id}
                                            title={book.title}
                                            author={book.author}
                                            coverUrl={book.coverUrl}
                                            progress={book.progress}
                                            index={index}
                                            getCoverUrl={getCoverUrl}
                                        />
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Audiobooks Grid */}
                        {filteredBooks.length > 0 ? (
                            groupBySeries ? (
                                <>
                                    {series.length > 0 && (
                                        <div>
                                            <SectionHeader title="Series" count={series.length} />
                                            <div
                                                className="grid-media"
                                                data-tv-section="series"
                                            >
                                                {series.map(([seriesName, books], index) => {
                                                    const firstBook = books[0];
                                                    const bookCount = `${books.length} ${books.length === 1 ? "book" : "books"}`;
                                                    return (
                                                        <AudiobookCard
                                                            key={seriesName}
                                                            id={seriesName}
                                                            title={seriesName}
                                                            author={firstBook.author}
                                                            coverUrl={firstBook.coverUrl}
                                                            seriesBadge={bookCount}
                                                            index={index}
                                                            getCoverUrl={getCoverUrl}
                                                        />
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    )}

                                    {standalone.length > 0 && (
                                        <div>
                                            <SectionHeader title="Standalone" count={standalone.length} />
                                            <div
                                                className="grid-media"
                                                data-tv-section="standalone"
                                            >
                                                {standalone.map((book, index) => (
                                                    <AudiobookCard
                                                        key={book.id}
                                                        id={book.id}
                                                        title={book.title}
                                                        author={book.author}
                                                        coverUrl={book.coverUrl}
                                                        progress={book.progress}
                                                        index={index}
                                                        getCoverUrl={getCoverUrl}
                                                    />
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </>
                            ) : (
                                <div>
                                    <SectionHeader title="All Books" count={filteredBooks.length} />
                                    <div
                                        className="grid-media"
                                        data-tv-section="audiobooks"
                                    >
                                        {paginatedBooks.map((book, index) => (
                                            <AudiobookCard
                                                key={book.id}
                                                id={book.id}
                                                title={book.title}
                                                author={book.author}
                                                coverUrl={book.coverUrl}
                                                progress={book.progress}
                                                index={index}
                                                getCoverUrl={getCoverUrl}
                                            />
                                        ))}
                                    </div>
                                </div>
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
                            onPageChange={setCurrentPage}
                            label="Audiobooks"
                            className="mt-0"
                        />
                    </div>
                </div>
            </div>
        </div>
    );
}
