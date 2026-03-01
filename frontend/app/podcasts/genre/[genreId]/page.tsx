"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Image from "next/image";
import { Mic2, ArrowLeft } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/utils/cn";
import { GradientSpinner } from "@/components/ui/GradientSpinner";

interface Podcast {
    id: string;
    title: string;
    author: string;
    coverUrl: string;
    feedUrl: string;
    itunesId?: number;
}

const GENRE_MAP: { [key: string]: { name: string; searchTerm: string } } = {
    "1303": { name: "Comedy", searchTerm: "comedy podcast" },
    "1324": { name: "Society & Culture", searchTerm: "society culture podcast" },
    "1489": { name: "News", searchTerm: "news podcast" },
    "1488": { name: "True Crime", searchTerm: "true crime podcast" },
    "1321": { name: "Business", searchTerm: "business podcast" },
    "1545": { name: "Sports", searchTerm: "sports podcast" },
    "1502": { name: "Leisure", searchTerm: "gaming hobbies podcast" },
};

export default function GenrePage() {
    const params = useParams();
    const router = useRouter();
    const genreId = params.genreId as string;
    const genre = GENRE_MAP[genreId];

    const [podcasts, setPodcasts] = useState<Podcast[]>([]);
    const [loading, setLoading] = useState(false);
    const [hasMore, setHasMore] = useState(true);
    const [offset, setOffset] = useState(0);
    const observerRef = useRef<IntersectionObserver | null>(null);
    const loadMoreRef = useRef<HTMLDivElement>(null);

    const LIMIT = 20;

    const loadMorePodcasts = useCallback(async () => {
        if (loading || !hasMore) return;

        setLoading(true);
        try {
            const data = await api.getPodcastsByGenrePaginated(
                parseInt(genreId),
                LIMIT,
                offset
            );

            if (data.length < LIMIT) {
                setHasMore(false);
            }

            setPodcasts((prev) => [...prev, ...data]);
            setOffset((prev) => prev + data.length);
        } catch (error) {
            console.error("Failed to load podcasts:", error);
            setHasMore(false);
        } finally {
            setLoading(false);
        }
    }, [genreId, offset, loading, hasMore]);

    useEffect(() => {
        if (observerRef.current) observerRef.current.disconnect();

        observerRef.current = new IntersectionObserver(
            (entries) => {
                if (entries[0].isIntersecting && hasMore && !loading) {
                    loadMorePodcasts();
                }
            },
            { threshold: 0.1 }
        );

        if (loadMoreRef.current) {
            observerRef.current.observe(loadMoreRef.current);
        }

        return () => {
            if (observerRef.current) {
                observerRef.current.disconnect();
            }
        };
    }, [loadMorePodcasts, hasMore, loading]);

    useEffect(() => {
        loadMorePodcasts();
        // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only: initial load should not re-trigger when loadMorePodcasts identity changes
    }, []);

    const handlePodcastClick = (podcast: Podcast) => {
        router.push(`/podcasts/${podcast.id || podcast.itunesId}`);
    };

    if (!genre) {
        return (
            <div className="flex items-center justify-center h-screen bg-[#0a0a0a]">
                <p className="text-xs font-mono text-gray-500 uppercase tracking-wider">Genre not found</p>
            </div>
        );
    }

    return (
        <div className="min-h-screen relative bg-gradient-to-b from-[#0a0a0a] to-black">
            {/* Atmospheric overlay */}
            <div className="fixed inset-0 pointer-events-none opacity-50">
                <div className="absolute inset-0 bg-gradient-to-br from-white/5 via-transparent to-transparent" />
            </div>

            <div className="relative">
                {/* Hero */}
                <div className="relative bg-gradient-to-b from-[#0a0a0a] via-[#0f0f0f] to-transparent pt-6 pb-8 px-4 sm:px-6 md:px-8 border-b border-white/5">
                    <div className="max-w-[1800px] mx-auto">
                        <button
                            onClick={() => router.push("/podcasts")}
                            className="flex items-center gap-2 text-xs font-mono text-gray-500 hover:text-white transition-colors mb-6 uppercase tracking-wider"
                        >
                            <ArrowLeft className="w-4 h-4" />
                            Back to Podcasts
                        </button>

                        <div className="flex items-center gap-2 mb-4">
                            <div className="w-1.5 h-1.5 bg-[#3b82f6] rounded-full" />
                            <span className="text-xs font-mono text-gray-500 uppercase tracking-wider">
                                Genre
                            </span>
                        </div>

                        <h1 className="text-5xl md:text-6xl lg:text-7xl font-black tracking-tighter text-white leading-none mb-3 uppercase">
                            {genre.name}
                        </h1>
                        <p className="text-sm font-mono text-gray-500">
                            {podcasts.length} podcast{podcasts.length !== 1 ? "s" : ""} found
                        </p>
                    </div>
                </div>

                {/* Content */}
                <div className="relative max-w-[1800px] mx-auto px-4 sm:px-6 md:px-8 pb-32 pt-8">
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
                        {podcasts.map((podcast) => (
                            <button
                                key={podcast.id}
                                onClick={() => handlePodcastClick(podcast)}
                                className="group text-left bg-[#0a0a0a] border border-white/10 rounded-lg overflow-hidden hover:border-[#3b82f6]/40 hover:shadow-lg hover:shadow-[#3b82f6]/10 transition-all duration-300 hover:scale-[1.02] active:scale-[0.98]"
                            >
                                <div className="relative w-full aspect-square bg-[#0f0f0f] overflow-hidden">
                                    {podcast.coverUrl ? (
                                        <Image
                                            src={podcast.coverUrl}
                                            alt={podcast.title}
                                            fill
                                            sizes="(max-width: 640px) 50vw, (max-width: 768px) 33vw, (max-width: 1024px) 25vw, 16vw"
                                            className="object-cover group-hover:scale-105 transition-transform duration-150"
                                            unoptimized
                                        />
                                    ) : (
                                        <div className="w-full h-full flex items-center justify-center">
                                            <Mic2 className="w-12 h-12 text-gray-700" />
                                        </div>
                                    )}
                                </div>
                                <div className="p-3">
                                    <h3 className="text-sm font-black text-white truncate tracking-tight">
                                        {podcast.title}
                                    </h3>
                                    <p className="text-[10px] font-mono text-gray-500 uppercase tracking-wider truncate mt-0.5">
                                        {podcast.author}
                                    </p>
                                </div>
                                <div className={cn(
                                    "h-0.5 bg-gradient-to-r from-[#3b82f6] to-[#2563eb]",
                                    "transform scale-x-0 group-hover:scale-x-100 transition-transform duration-150 origin-center"
                                )} />
                            </button>
                        ))}
                    </div>

                    {/* Loading */}
                    {loading && (
                        <div className="flex justify-center items-center py-8">
                            <GradientSpinner size="md" />
                        </div>
                    )}

                    {/* Intersection observer target */}
                    <div ref={loadMoreRef} className="h-20" />

                    {/* End of results */}
                    {!hasMore && podcasts.length > 0 && (
                        <div className="text-center py-8">
                            <span className="text-xs font-mono text-gray-600 uppercase tracking-wider">
                                End of results
                            </span>
                        </div>
                    )}

                    {/* No results */}
                    {!loading && podcasts.length === 0 && (
                        <div className="text-center py-20">
                            <Mic2 className="w-16 h-16 text-gray-700 mx-auto mb-4" />
                            <p className="text-xs font-mono text-gray-500 uppercase tracking-wider">
                                No podcasts found
                            </p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
