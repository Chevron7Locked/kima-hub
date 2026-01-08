import { Music2 } from "lucide-react";
import { format } from "date-fns";
import { DiscoverPlaylist, DiscoverConfig } from "../types";

interface DiscoverHeroProps {
    playlist: DiscoverPlaylist | null;
    config: DiscoverConfig | null;
}

export function DiscoverHero({ playlist, config }: DiscoverHeroProps) {
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

    return (
        <div className="relative bg-gradient-to-b from-purple-900/40 via-[#1a1a1a] to-transparent pt-16 pb-10 px-4 md:px-8">
            <div className="flex items-end gap-6">
                {/* Icon */}
                <div className="w-[140px] h-[140px] md:w-[192px] md:h-[192px] bg-gradient-to-br from-purple-600/30 to-yellow-600/20 rounded shadow-2xl shrink-0 flex items-center justify-center border border-white/10">
                    <Music2 className="w-16 h-16 md:w-20 md:h-20 text-purple-400" />
                </div>

                {/* Info - Bottom Aligned */}
                <div className="flex-1 min-w-0 pb-1">
                    <p className="text-xs font-medium text-white/90 mb-1">
                        Playlist
                    </p>
                    <h1 className="text-2xl md:text-4xl lg:text-5xl font-bold text-white leading-tight line-clamp-2 mb-2">
                        Discover Weekly
                    </h1>
                    <p className="text-sm text-white/60 mb-2 line-clamp-2">
                        Your personalized playlist of new music, curated based
                        on your listening history.
                    </p>
                    <div className="flex flex-wrap items-center gap-1 text-sm text-white/70">
                        {playlist && (
                            <>
                                <span>
                                    Week of{" "}
                                    {format(
                                        new Date(playlist.weekStart),
                                        "MMM d, yyyy"
                                    )}
                                </span>
                                <span className="mx-1">•</span>
                                <span>{playlist.totalCount} songs</span>
                                {totalDuration > 0 && (
                                    <span>
                                        , {formatTotalDuration(totalDuration)}
                                    </span>
                                )}
                            </>
                        )}
                        {config?.lastGeneratedAt && (
                            <>
                                <span className="mx-1">•</span>
                                <span>
                                    Updated{" "}
                                    {format(
                                        new Date(config.lastGeneratedAt),
                                        "MMM d"
                                    )}
                                </span>
                            </>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
