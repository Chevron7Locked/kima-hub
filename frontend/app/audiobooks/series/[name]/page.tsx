"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { api } from "@/lib/api";
import { formatDuration } from "@/utils/formatTime";
import { useAuth } from "@/lib/auth-context";
import { useAudioState, useAudioPlayback, useAudioControls } from "@/lib/audio-context";
import { useToast } from "@/lib/toast-context";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import {
    ArrowLeft,
    Book,
    Play,
    Pause,
    CheckCircle,
} from "lucide-react";

interface Audiobook {
    id: string;
    title: string;
    author: string;
    narrator?: string;
    description?: string;
    coverUrl: string | null;
    duration: number;
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

export default function SeriesDetailPage() {
    const params = useParams();
    const router = useRouter();
    const { isAuthenticated } = useAuth();
    const { toast } = useToast();
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
                    toast.error("Failed to load series");
                }
            } finally {
                if (!cancelled) setIsLoading(false);
            }
        };

        loadSeries();
        return () => { cancelled = true; };
    }, [seriesName, isAuthenticated, toast]);

    const getCoverUrl = (coverUrl: string | null, size = 300) => {
        if (!coverUrl) return null;
        return api.getCoverArtUrl(coverUrl, size);
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center min-h-screen bg-[var(--bg-primary)]">
                <GradientSpinner size="md" />
            </div>
        );
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
    const heroImage = firstBook.coverUrl ? getCoverUrl(firstBook.coverUrl, 500) : null;

    return (
        <div className="min-h-screen bg-gradient-to-b from-[#0a0a0a] to-black section-stack">
            {/* Hero Section */}
            <div className="relative">
                {/* Background */}
                {heroImage && (
                    <div className="absolute inset-0 overflow-hidden">
                        <div className="absolute inset-0 scale-110 blur-md opacity-30">
                            <Image
                                src={heroImage}
                                alt={seriesName}
                                fill
                                sizes="100vw"
                                className="object-cover"
                                priority
                                unoptimized
                            />
                        </div>
                        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-[#0a0a0a]/80 to-[#0a0a0a]" />
                    </div>
                )}

                <div className="relative px-4 md:px-8 pt-8 pb-6">
                    <div className="max-w-[1800px] mx-auto">
                        {/* Back navigation */}
                        <button
                            onClick={() => router.push("/audiobooks")}
                            className="flex items-center gap-2 text-xs tabular-nums text-[var(--text-muted)] hover:text-white transition-colors mb-6"
                        >
                            <ArrowLeft className="w-3.5 h-3.5" />
                            Audiobooks
                        </button>

                        {/* System status */}
                        <div className="flex items-center gap-2 mb-4">
                            <div className="w-1.5 h-1.5 bg-[#f59e0b] rounded-full" />
                            <span className="t-eyebrow">
                                Series
                            </span>
                        </div>

                        <div className="flex items-end gap-6">
                            {/* Cover Art */}
                            <div className="w-[140px] h-[140px] md:w-[192px] md:h-[192px] bg-[var(--bg-primary)] rounded-lg shrink-0 overflow-hidden relative border-2 border-white/10">
                                {heroImage ? (
                                    <Image
                                        src={heroImage}
                                        alt={seriesName}
                                        fill
                                        sizes="(max-width: 768px) 140px, 192px"
                                        className="object-cover"
                                        priority
                                        unoptimized
                                    />
                                ) : (
                                    <div className="w-full h-full flex items-center justify-center">
                                        <Book className="w-16 h-16 text-white/10" />
                                    </div>
                                )}
                            </div>

                            {/* Info */}
                            <div className="flex-1 min-w-0 pb-1">
                                <h1 className="text-2xl md:text-4xl lg:text-5xl font-bold text-white leading-tight line-clamp-2 mb-2 tracking-tight">
                                    {seriesName}
                                </h1>

                                {/* Metadata row */}
                                <div className="flex flex-wrap items-center gap-3 text-xs tabular-nums text-[var(--text-secondary)]">
                                    <span className="font-bold text-white normal-case tracking-tight text-sm">
                                        {author}
                                    </span>
                                    <span className="text-[var(--text-muted)]">|</span>
                                    <span>
                                        {books.length} {books.length === 1 ? "book" : "books"}
                                    </span>
                                    <span className="text-[var(--text-muted)]">|</span>
                                    <span>{formatDuration(totalDuration)}</span>
                                </div>

                                {/* Genre tags */}
                                {genres.length > 0 && (
                                    <div className="hidden md:flex flex-wrap gap-1.5 mt-3">
                                        {genres.slice(0, 5).map((genre) => (
                                            <span
                                                key={genre}
                                                className="px-2.5 py-0.5 bg-white/5 border border-white/10 rounded text-xs tabular-nums text-[var(--text-secondary)]"
                                            >
                                                {genre}
                                            </span>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Books List */}
            <div className="relative px-4 md:px-8 pb-24 animate-rise">
                <div className="max-w-[1800px] mx-auto">
                    <div>
                        <div className="flex items-center gap-3 mb-6">
                            <span className="w-1 h-8 bg-gradient-to-b from-[#f59e0b] to-[#d97706] rounded-full shrink-0" />
                            <h2 className="text-2xl font-bold tracking-tight">Books in Series</h2>
                            <span className="text-xs tabular-nums text-[#f59e0b]">
                                {books.length}
                            </span>
                            <span className="flex-1 border-t border-white/10" />
                        </div>

                        <div className="space-y-0.5">
                            {books.map((book, index) => {
                                const isCurrentBook =
                                    currentAudiobook?.id === book.id &&
                                    playbackType === "audiobook";
                                const isBookPlaying = isCurrentBook && isPlaying;
                                const bookCover = book.coverUrl ? getCoverUrl(book.coverUrl, 100) : null;

                                return (
                                    <div
                                        key={book.id}
                                        className={`group relative rounded-lg transition-all ${
                                            isCurrentBook
                                                ? "bg-white/5 border border-[#f59e0b]/30"
                                                : "border border-transparent hover:bg-white/[0.03] hover:border-white/5"
                                        }`}
                                    >
                                        {/* Progress bar */}
                                        {book.progress && book.progress.progress > 0 && !book.progress.isFinished && (
                                            <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-white/5 rounded-full overflow-hidden">
                                                <div
                                                    className="h-full bg-[#f59e0b]/60 transition-all"
                                                    style={{ width: `${book.progress.progress}%` }}
                                                />
                                            </div>
                                        )}

                                        <div className="flex items-center gap-4 px-3 py-3">
                                            {/* Number / Play */}
                                            <div className="w-8 flex items-center justify-center shrink-0">
                                                {book.progress?.isFinished ? (
                                                    <CheckCircle className="w-4 h-4 text-green-400" />
                                                ) : isBookPlaying ? (
                                                    <Pause
                                                        className="w-4 h-4 text-[#f59e0b] cursor-pointer"
                                                        onClick={() => pause()}
                                                    />
                                                ) : (
                                                    <>
                                                        <span className={`text-xs tabular-nums ${
                                                            isCurrentBook ? "text-[#f59e0b] font-bold hidden" : "text-[var(--text-muted)] group-hover:hidden"
                                                        }`}>
                                                            {book.series?.sequence || index + 1}
                                                        </span>
                                                        <Play
                                                            className={`w-4 h-4 cursor-pointer ${
                                                                isCurrentBook
                                                                    ? "text-[#f59e0b]"
                                                                    : "text-white hidden group-hover:block"
                                                            }`}
                                                            onClick={() => {
                                                                if (isCurrentBook) {
                                                                    resumeWithGesture();
                                                                } else {
                                                                    playAudiobook(book);
                                                                }
                                                            }}
                                                        />
                                                    </>
                                                )}
                                            </div>

                                            {/* Cover thumbnail */}
                                            <Link href={`/audiobooks/${book.id}`}>
                                                <div className="relative w-10 h-10 rounded overflow-hidden bg-[var(--bg-primary)] border border-white/10 shrink-0 cursor-pointer">
                                                    {bookCover ? (
                                                        <Image
                                                            src={bookCover}
                                                            alt={book.title}
                                                            fill
                                                            sizes="40px"
                                                            className="object-cover"
                                                            unoptimized
                                                        />
                                                    ) : (
                                                        <div className="w-full h-full flex items-center justify-center">
                                                            <Book className="w-4 h-4 text-white/10" />
                                                        </div>
                                                    )}
                                                </div>
                                            </Link>

                                            {/* Title & narrator */}
                                            <Link
                                                href={`/audiobooks/${book.id}`}
                                                className="flex-1 min-w-0"
                                            >
                                                <h3 className={`font-bold truncate text-sm tracking-tight ${
                                                    isCurrentBook ? "text-[#f59e0b]" : "text-white"
                                                }`}>
                                                    {book.title}
                                                </h3>
                                                <p className="text-xs tabular-nums text-[var(--text-muted)] truncate mt-0.5">
                                                    {book.narrator || book.author}
                                                </p>
                                            </Link>

                                            {/* Progress */}
                                            {book.progress?.isFinished ? (
                                                <span className="text-xs text-green-400 shrink-0">
                                                    Finished
                                                </span>
                                            ) : book.progress && book.progress.progress > 0 ? (
                                                <span className="text-xs tabular-nums text-[#f59e0b] shrink-0">
                                                    {Math.round(book.progress.progress)}%
                                                </span>
                                            ) : null}

                                            {/* Duration */}
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
