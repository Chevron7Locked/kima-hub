"use client";

import Link from "next/link";
import Image from "next/image";
import { Music } from "lucide-react";
import { api } from "@/lib/api";
import { memo } from "react";

interface MixCardProps {
    mix: {
        id: string;
        name: string;
        description: string;
        coverUrls: string[];
        trackCount: number;
    };
    index?: number;
}

const MixCard = memo(
    function MixCard({ mix, index }: MixCardProps) {
        return (
            <Link
                href={`/mix/${mix.id}`}
                data-tv-card
                data-tv-card-index={index}
                tabIndex={0}
                className="group block"
            >
                <div className="relative bg-[#0a0a0a] border border-white/10 rounded-lg overflow-hidden hover:border-[#fca208]/40 transition-all duration-300 hover:shadow-lg hover:shadow-[#fca208]/10 mx-1">
                    <div className="relative aspect-square">
                        <div className="w-full h-full bg-[#181818] overflow-hidden">
                            {mix.coverUrls.length > 0 ? (
                                <div className="grid grid-cols-2 gap-0 w-full h-full">
                                    {mix.coverUrls.slice(0, 4).map((url, idx) => {
                                        const proxiedUrl = api.getCoverArtUrl(url, 300);
                                        return (
                                            <div key={idx} className="relative bg-[#181818]">
                                                <Image
                                                    src={proxiedUrl}
                                                    alt=""
                                                    fill
                                                    className="object-cover group-hover:scale-105 transition-transform duration-150"
                                                    sizes="180px"
                                                    unoptimized
                                                />
                                            </div>
                                        );
                                    })}
                                    {Array.from({
                                        length: Math.max(0, 4 - mix.coverUrls.length),
                                    }).map((_, idx) => (
                                        <div
                                            key={`empty-${idx}`}
                                            className="relative bg-[#181818] flex items-center justify-center"
                                        >
                                            <Music className="w-6 h-6 text-gray-700" />
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <div className="w-full h-full flex items-center justify-center">
                                    <Music className="w-10 h-10 text-gray-700" />
                                </div>
                            )}
                        </div>
                        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r from-[#fca208] to-[#f97316] transform scale-x-0 group-hover:scale-x-100 transition-transform duration-150" />
                    </div>
                    <div className="p-3 bg-gradient-to-b from-[#0a0a0a] to-[#0f0f0f]">
                        <h3 className="text-sm font-black text-white truncate tracking-tight">
                            {mix.name}
                        </h3>
                        <p className="text-xs font-mono text-gray-500 line-clamp-1 mt-0.5 uppercase tracking-wider">
                            {mix.trackCount} tracks
                        </p>
                    </div>
                </div>
            </Link>
        );
    },
    (prevProps, nextProps) => {
        return (
            prevProps.mix.id === nextProps.mix.id &&
            prevProps.mix.name === nextProps.mix.name &&
            prevProps.mix.description === nextProps.mix.description &&
            prevProps.mix.trackCount === nextProps.mix.trackCount &&
            prevProps.mix.coverUrls.length === nextProps.mix.coverUrls.length &&
            prevProps.mix.coverUrls.every(
                (url, i) => url === nextProps.mix.coverUrls[i]
            )
        );
    }
);

export { MixCard };
