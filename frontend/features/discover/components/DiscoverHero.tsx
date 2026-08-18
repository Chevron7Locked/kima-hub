import { format } from "date-fns";
import { Settings } from "lucide-react";
import { DiscoverPlaylist, DiscoverConfig } from "../types";

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

    return (
        <div className="relative bg-gradient-to-b from-[#0f0f0f] to-[#0a0a0a] pt-20 pb-8 px-6 md:px-8 border-b border-white/10">
            <div className="max-w-[1600px] mx-auto">
                {/* Settings button - top right */}
                <button
                    onClick={onOpenSettings}
                    aria-label="Open discovery settings"
                    title="Discovery settings"
                    className="absolute top-6 right-8 flex items-center gap-1.5 px-3 py-2 border border-white/10 rounded-lg hover:border-purple-500 hover:bg-white/5 transition-all duration-300 min-h-[44px] focus-visible:outline-2 focus-visible:outline-[var(--color-brand)] focus-visible:outline-offset-2"
                >
                    <Settings className="w-4 h-4 text-white/60" />
                    <span className="text-xs font-mono text-white/50 uppercase tracking-wider">Settings</span>
                </button>

                <div className="flex items-end gap-8">
                    {/* Info - Bottom Aligned */}
                    <div className="flex-1 min-w-0 pb-2">
                        <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight text-white leading-none mb-6">
                            DISCOVER<br/>
                            <span className="text-brand">WEEKLY</span>
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
