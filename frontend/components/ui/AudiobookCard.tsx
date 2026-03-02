"use client";

import Link from "next/link";
import { Book, CheckCircle } from "lucide-react";
import { CachedImage } from "./CachedImage";

interface AudiobookCardProps {
    id: string;
    title: string;
    author: string;
    coverUrl: string | null;
    progress?: {
        progress: number;
        isFinished: boolean;
    } | null;
    seriesBadge?: string;
    index?: number;
    getCoverUrl: (url: string) => string | null;
}

export function AudiobookCard({
    id,
    title,
    author,
    coverUrl,
    progress,
    seriesBadge,
    index = 0,
    getCoverUrl,
}: AudiobookCardProps) {
    const resolvedCoverUrl = coverUrl ? getCoverUrl(coverUrl) : null;

    return (
        <Link
            href={seriesBadge ? `/audiobooks/series/${encodeURIComponent(title)}` : `/audiobooks/${id}`}
            data-tv-card
            data-tv-card-index={index}
            tabIndex={0}
        >
            <div className="cursor-pointer group relative h-full flex flex-col">
                <div className="relative flex-shrink-0">
                    <div className="aspect-[2/3] rounded-lg overflow-hidden bg-[#0a0a0a] border border-white/10 group-hover:border-[#f59e0b]/40 group-hover:shadow-xl group-hover:shadow-[#f59e0b]/10 transition-all duration-300 relative">
                        {resolvedCoverUrl ? (
                            <CachedImage
                                src={resolvedCoverUrl}
                                alt={title}
                                fill
                                sizes="(max-width: 640px) 50vw, (max-width: 768px) 33vw, (max-width: 1024px) 25vw, (max-width: 1280px) 20vw, (max-width: 1536px) 16.6vw, (max-width: 2000px) 12.5vw, 10vw"
                                className="object-cover"
                                loading="lazy"
                                onError={(e) => {
                                    e.currentTarget.style.display = "none";
                                }}
                            />
                        ) : (
                            <div className="w-full h-full flex items-center justify-center">
                                <Book className="w-16 h-16 text-white/10" />
                            </div>
                        )}

                        {/* Book spine shadow */}
                        <div className="absolute left-0 top-0 bottom-0 w-2 bg-gradient-to-r from-black/40 to-transparent pointer-events-none" />

                        {/* Progress bar */}
                        {progress && !progress.isFinished && progress.progress > 0 && (
                            <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/60">
                                <div
                                    className="h-full bg-[#f59e0b]"
                                    style={{ width: `${progress.progress}%` }}
                                />
                            </div>
                        )}

                        {/* Completion badge */}
                        {progress?.isFinished && (
                            <div className="absolute top-2 right-2 bg-green-500 rounded-full p-1 shadow-lg">
                                <CheckCircle className="w-3 h-3 text-white" />
                            </div>
                        )}

                        {/* Series badge */}
                        {seriesBadge && (
                            <div className="absolute top-2 right-2 bg-[#f59e0b] text-black rounded px-2 py-0.5 text-[10px] font-black uppercase tracking-wider shadow-lg">
                                {seriesBadge}
                            </div>
                        )}

                        {/* Hover accent line */}
                        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r from-[#f59e0b] to-[#d97706] transform scale-x-0 group-hover:scale-x-100 transition-transform duration-150 origin-center" />
                    </div>
                </div>

                <div className="mt-2.5 px-0.5 h-14 flex flex-col justify-start">
                    <h3 className="text-sm font-black text-white line-clamp-2 leading-tight tracking-tight">
                        {title}
                    </h3>
                    <p className="text-[11px] font-mono text-white/40 line-clamp-1 mt-0.5 uppercase tracking-wider">
                        {author}
                    </p>
                </div>
            </div>
        </Link>
    );
}
