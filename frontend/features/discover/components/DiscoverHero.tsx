import { format, isValid, parse } from "date-fns";
import { Settings } from "lucide-react";
import { DiscoverPlaylist, DiscoverConfig } from "../types";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/Button";
import { plural } from "@/lib/format";

interface DiscoverHeroProps {
    playlist: DiscoverPlaylist | null;
    config: DiscoverConfig | null;
    onOpenSettings: () => void;
}

/**
 * The week's first day as the server's calendar has it: the first ten
 * characters of weekStart, read as a plain date so the browser's own zone
 * cannot move it to the day before or after.
 */
function weekStartLabel(weekStart: string): string {
    const day = parse(weekStart.slice(0, 10), "yyyy-MM-dd", new Date());
    return isValid(day) ? format(day, "MMM d, yyyy") : weekStart;
}

export function DiscoverHero({ playlist, config, onOpenSettings }: DiscoverHeroProps) {
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
        <PageHeader
            eyebrow="Discovery"
            title="Discover Weekly"
            description="A new playlist every week, picked from your listening"
            actions={
                <Button variant="secondary" onClick={onOpenSettings} aria-label="Open discovery settings">
                    <Settings className="w-4 h-4" />
                    Settings
                </Button>
            }
        >
            {playlist && playlist.totalCount > 0 && (
                <div className="mt-4 inline-flex flex-wrap items-center gap-3 text-xs tabular-nums bg-white/[0.02] border border-white/10 rounded-lg px-4 py-2">
                    <div className="flex items-center gap-2">
                        <span className="w-1 h-1 bg-brand rounded-full" />
                        <span className="text-[var(--text-secondary)]" data-testid="discover-week-start">
                            {weekStartLabel(playlist.weekStart)}
                        </span>
                    </div>
                    <div className="flex items-center gap-2">
                        <span className="w-1 h-1 bg-type-track rounded-full" />
                        <span className="text-[var(--text-secondary)]">
                            {plural(playlist.totalCount, "track")}
                        </span>
                    </div>
                    {totalDuration > 0 && (
                        <div className="flex items-center gap-2">
                            <span className="w-1 h-1 bg-white/20 rounded-full" />
                            <span className="text-[var(--text-secondary)]">
                                {formatTotalDuration(totalDuration)}
                            </span>
                        </div>
                    )}
                    {config?.lastGeneratedAt && (
                        <div className="flex items-center gap-2">
                            <span className="w-1 h-1 bg-white/20 rounded-full" />
                            <span className="text-[var(--text-secondary)]">
                                Updated {format(new Date(config.lastGeneratedAt), "MMM d")}
                            </span>
                        </div>
                    )}
                </div>
            )}
        </PageHeader>
    );
}
