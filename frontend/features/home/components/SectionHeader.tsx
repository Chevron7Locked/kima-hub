import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { memo } from "react";

type ContentColor = "featured" | "tracks" | "albums" | "podcasts" | "audiobooks" | "artists" | "discover";

const GRADIENT_MAP: Record<ContentColor, string> = {
    featured: "from-brand to-[#f97316]",
    tracks: "from-[#a855f7] to-[#c026d3]",
    albums: "from-[#22c55e] to-[#16a34a]",
    podcasts: "from-[#3b82f6] to-[#2563eb]",
    audiobooks: "from-[#f59e0b] to-[#d97706]",
    artists: "from-[#ec4899] to-[#db2777]",
    discover: "from-[#a855f7] to-[#c026d3]",
};

interface SectionHeaderProps {
    title: string;
    showAllHref?: string;
    rightAction?: React.ReactNode;
    badge?: string;
    color?: ContentColor;
}

const SectionHeader = memo(function SectionHeader({
    title,
    showAllHref,
    rightAction,
    badge,
    color = "featured",
}: SectionHeaderProps) {
    const gradient = GRADIENT_MAP[color];

    return (
        <h2 className="text-2xl font-bold tracking-tight flex items-center gap-3 mb-6">
            <span className={`w-1 h-8 bg-gradient-to-b ${gradient} rounded-full shrink-0`} />
            <span className="uppercase tracking-tight">{title}</span>
            {badge && <Badge variant="ai">{badge}</Badge>}
            <span className="flex-1 border-t border-white/10" />
            {rightAction ? (
                <span className="shrink-0">{rightAction}</span>
            ) : showAllHref ? (
                <Link
                    href={showAllHref}
                    className="flex items-center gap-1 text-xs font-mono text-gray-500 hover:text-white transition-colors uppercase tracking-wider group shrink-0"
                >
                    Show all
                    <ChevronRight className="w-3.5 h-3.5 group-hover:translate-x-1 transition-transform" />
                </Link>
            ) : null}
        </h2>
    );
});

export { SectionHeader };
