import { format } from "date-fns";
import Image from "next/image";
import { Settings } from "lucide-react";
import { DiscoverPlaylist, DiscoverConfig } from "../types";
import { api } from "@/lib/api";

interface DiscoverHeroProps {
    playlist: DiscoverPlaylist | null;
    config: DiscoverConfig | null;
    onOpenSettings: () => void;
}

export function DiscoverHero({ playlist, config, onOpenSettings }: DiscoverHeroProps) {
    // Calculate total duration
    const totalDuration =
        playlist?.tracks?.reduce((sum, t) => sum + (t.duration || 0), 0) || 0;

    const formatTotalDuration = (seconds: number) => {
        const hours = Math.floor(seconds / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        if (hours > 0) {
            return `about ${hours} hr ${mins} min`;
        }
        return `${mins} min`;
    };

    // Get unique album covers from playlist (up to 4)
    const albumCovers = playlist?.tracks
        ? Array.from(
              new Map(
                  playlist.tracks
                      .filter((t) => t.coverUrl)
                      .map((t) => [t.coverUrl, t])
              ).values()
          )
              .slice(0, 4)
              .map((t) => t.coverUrl!)
        : [];

    return (
        <div className="relative bg-gradient-to-b from-[#0f0f0f] to-[#0a0a0a] pt-20 pb-8 px-6 md:px-8 border-b border-white/10">
            <div className="max-w-[1600px] mx-auto">
                {/* Settings button - top right */}
                <button
                    onClick={onOpenSettings}
                    className="absolute top-6 right-8 p-2 border border-white/10 rounded-lg hover:border-[#a855f7] hover:bg-white/5 transition-all duration-300"
                    title="Settings"
                >
                    <Settings className="w-5 h-5 text-white/60" />
                </button>

                <div className="flex items-end gap-8">
                    {/* Album Cover Grid */}
                    <div className="w-[180px] h-[180px] md:w-[232px] md:h-[232px] shrink-0 relative">
                        {albumCovers.length > 0 ? (
                            <div className="w-full h-full grid grid-cols-2 gap-1 border-2 border-white/20 shadow-2xl shadow-black/40 group">
                                {albumCovers.map((cover, i) => (
                                    <div
                                        key={i}
                                        className="relative bg-[#0a0a0a]"
                                    >
                                        <Image
                                            src={api.getCoverArtUrl(cover, 200)}
                                            alt=""
                                            fill
                                            className="object-cover"
                                            unoptimized
                                        />
                                    </div>
                                ))}
                                {/* Fill empty slots */}
                                {Array.from({ length: 4 - albumCovers.length }).map(
                                    (_, i) => (
                                        <div
                                            key={`empty-${i}`}
                                            className="bg-[#0a0a0a] border border-white/10"
                                        />
                                    )
                                )}
                            </div>
                        ) : (
                            // Empty grid
                            <div className="w-full h-full grid grid-cols-2 gap-1 border-2 border-white/20">
                                {Array.from({ length: 4 }).map((_, i) => (
                                    <div
                                        key={i}
                                        className="bg-[#0a0a0a] border border-white/10 flex items-center justify-center"
                                    >
                                        <div className="text-white/10 text-4xl">?</div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Info - Bottom Aligned */}
                    <div className="flex-1 min-w-0 pb-2">
                        <h1 className="text-5xl md:text-6xl lg:text-7xl font-black tracking-tighter text-white leading-none mb-6">
                            DISCOVER<br/>
                            <span className="text-[#fca200]">WEEKLY</span>
                        </h1>
                        <p className="text-sm md:text-base text-gray-500 mb-4 max-w-2xl font-mono">
                            Algorithm-generated playlist / Updated weekly / Personalized to your taste
                        </p>
                        {playlist && (
                            <div className="inline-flex flex-wrap items-center gap-3 text-xs font-mono bg-white/[0.02] border border-white/10 rounded-lg px-4 py-2">
                                <div className="flex items-center gap-2">
                                    <span className="w-1 h-1 bg-[#eab308] rounded-full" />
                                    <span className="text-gray-400">
                                        {format(new Date(playlist.weekStart), "MMM d, yyyy")}
                                    </span>
                                </div>
                                <div className="flex items-center gap-2">
                                    <span className="w-1 h-1 bg-[#a855f7] rounded-full" />
                                    <span className="text-gray-400">
                                        {playlist.totalCount} tracks
                                    </span>
                                </div>
                                {totalDuration > 0 && (
                                    <div className="flex items-center gap-2">
                                        <span className="w-1 h-1 bg-white/20 rounded-full" />
                                        <span className="text-gray-400">
                                            {formatTotalDuration(totalDuration)}
                                        </span>
                                    </div>
                                )}
                                {config?.lastGeneratedAt && (
                                    <div className="flex items-center gap-2">
                                        <span className="w-1 h-1 bg-white/20 rounded-full" />
                                        <span className="text-gray-400">
                                            Updated {format(new Date(config.lastGeneratedAt), "MMM d")}
                                        </span>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
