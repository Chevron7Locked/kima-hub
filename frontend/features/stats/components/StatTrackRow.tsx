import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/cn";

/** A song in a stats list: its title over its artist, and what the list says about it (a count, an action) on the right. */
export function StatTrackRow({
    title,
    artist,
    trailing,
    className,
    style,
}: {
    title: string;
    artist: string;
    trailing?: ReactNode;
    className?: string;
    style?: CSSProperties;
}) {
    return (
        <li className={cn("flex items-center justify-between gap-4", className)} style={style}>
            <span className="min-w-0">
                <span className="block truncate text-sm text-[var(--text-primary)]">{title}</span>
                <span className="block truncate t-meta">{artist}</span>
            </span>
            {trailing}
        </li>
    );
}

/** The count at the end of a stats row. */
export function StatCount({ children }: { children: ReactNode }) {
    return <span className="t-meta shrink-0 text-[var(--text-secondary)]">{children}</span>;
}
