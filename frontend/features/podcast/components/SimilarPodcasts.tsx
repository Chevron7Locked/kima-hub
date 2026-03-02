"use client";

import { useRouter } from "next/navigation";
import Image from "next/image";
import { Mic2 } from "lucide-react";
import { SimilarPodcast } from "../types";
import { api } from "@/lib/api";
import { cn } from "@/utils/cn";

interface SimilarPodcastsProps {
    podcasts: SimilarPodcast[];
}

const getProxiedImageUrl = (imageUrl: string | undefined): string | null => {
    if (!imageUrl) return null;
    return api.getCoverArtUrl(imageUrl, 300);
};

export function SimilarPodcasts({ podcasts }: SimilarPodcastsProps) {
    const router = useRouter();

    if (!podcasts || podcasts.length === 0) {
        return null;
    }

    return (
        <section>
            <div className="flex items-center gap-3 mb-6">
                <span className="w-1 h-8 bg-gradient-to-b from-[#3b82f6] to-[#2563eb] rounded-full shrink-0" />
                <h2 className="text-2xl font-black tracking-tighter uppercase">Fans Also Like</h2>
                <span className="text-xs font-mono text-[#3b82f6]">
                    {podcasts.length}
                </span>
                <span className="flex-1 border-t border-white/10" />
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
                {podcasts.map((podcast) => {
                    const imageUrl = getProxiedImageUrl(podcast.coverUrl);
                    return (
                        <button
                            key={podcast.id}
                            className="group text-left bg-[#0a0a0a] border border-white/10 rounded-lg overflow-hidden hover:border-[#3b82f6]/40 hover:shadow-lg hover:shadow-[#3b82f6]/10 transition-all duration-300 hover:scale-[1.02] active:scale-[0.98]"
                            onClick={() => router.push(`/podcasts/${podcast.id}`)}
                        >
                            <div className="relative w-full aspect-square bg-[#0f0f0f] overflow-hidden">
                                {imageUrl ? (
                                    <Image
                                        src={imageUrl}
                                        alt={podcast.title}
                                        fill
                                        sizes="(max-width: 640px) 50vw, (max-width: 768px) 33vw, (max-width: 1024px) 25vw, 16vw"
                                        className="object-cover group-hover:scale-105 transition-transform duration-150"
                                        unoptimized
                                    />
                                ) : (
                                    <div className="w-full h-full flex items-center justify-center">
                                        <Mic2 className="w-10 h-10 text-gray-700" />
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
                    );
                })}
            </div>
        </section>
    );
}
