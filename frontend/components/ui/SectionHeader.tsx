import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { memo, type ReactNode } from "react";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/cn";

type SectionType = "featured" | "track" | "album" | "artist" | "podcast" | "audiobook";

const BAR: Record<SectionType, string> = {
    featured: "bg-brand",
    track: "bg-type-track",
    album: "bg-type-album",
    artist: "bg-type-artist",
    podcast: "bg-type-podcast",
    audiobook: "bg-type-audiobook",
};

interface SectionHeaderProps {
    title: ReactNode;
    type?: SectionType;
    count?: ReactNode;
    badge?: string;
    showAllHref?: string;
    action?: ReactNode;
    size?: "md" | "sm";
    className?: string;
}

export const SectionHeader = memo(function SectionHeader({
    title,
    type = "featured",
    count,
    badge,
    showAllHref,
    action,
    size = "md",
    className,
}: SectionHeaderProps) {
    return (
        <div className={cn("flex items-center gap-3", size === "md" ? "mb-4" : "mb-3", className)}>
            <span
                aria-hidden="true"
                className={cn("w-1 rounded-full shrink-0", size === "md" ? "h-7" : "h-6", BAR[type])}
            />
            <h2 className={cn("font-bold tracking-tight text-white", size === "md" ? "text-xl" : "text-lg")}>
                {title}
            </h2>
            {count !== undefined && <span className="t-meta">{count}</span>}
            {badge && <Badge variant="ai">{badge}</Badge>}
            <span className="flex-1 border-t border-white/10" />
            {action ? (
                <span className="shrink-0">{action}</span>
            ) : showAllHref ? (
                <Link
                    href={showAllHref}
                    className="flex items-center gap-1 -my-3 py-3 min-h-[44px] text-xs text-[var(--text-muted)] hover:text-white transition-colors group shrink-0"
                >
                    Show all
                    <ChevronRight className="w-3.5 h-3.5 group-hover:translate-x-1 transition-transform" />
                </Link>
            ) : null}
        </div>
    );
});
