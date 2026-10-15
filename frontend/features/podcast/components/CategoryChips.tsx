import Link from "next/link";
import { cn } from "@/lib/cn";
import type { CategoryRef } from "../types";

/** Categories as links to their chart pages; `active` marks the one being viewed. */
export function CategoryChips({ categories, active, className }: { categories: CategoryRef[]; active?: number; className?: string }) {
    return (
        <nav aria-label="podcast categories" className={cn("flex flex-wrap gap-2", className)}>
            {categories.map((c) => (
                <Link
                    key={c.id}
                    href={`/podcasts/category/${c.id}`}
                    aria-current={c.id === active ? "page" : undefined}
                    className={cn(
                        "rounded-full border px-3 py-1.5 text-xs transition-colors",
                        c.id === active
                            ? "border-brand bg-brand text-[var(--color-on-brand)]"
                            : "border-white/10 bg-white/5 text-[var(--text-secondary)] hover:border-white/20 hover:text-white",
                    )}
                >
                    {c.name}
                </Link>
            ))}
        </nav>
    );
}
