import type { ReactNode } from "react";

/** The small square holding an activity row's icon, with a brand dot when the row is unread. */
export function ActivityIcon({ children, unread = false }: { children: ReactNode; unread?: boolean }) {
    return (
        <span className="relative mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-white/[0.04]">
            {children}
            {unread && <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-brand" />}
        </span>
    );
}
