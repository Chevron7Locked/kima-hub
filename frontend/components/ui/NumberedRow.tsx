import type { ReactNode } from "react";

/** A plain numbered list row: position, title over subtitle, and a short note on the right. */
export function NumberedRow({ n, title, subtitle, trailing }: { n: number; title: ReactNode; subtitle: ReactNode; trailing?: ReactNode }) {
    return (
        <div className="flex items-center gap-3 px-4 py-2 hover:bg-white/5">
            <span className="w-5 text-right text-xs text-[var(--text-muted)]">{n}</span>
            <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-[var(--text-primary)]">{title}</p>
                <p className="truncate text-xs text-[var(--text-muted)]">{subtitle}</p>
            </div>
            {trailing !== undefined && <span className="text-xs text-[var(--text-muted)]">{trailing}</span>}
        </div>
    );
}
