"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { ReleaseLink } from "./types";

/** A release item's links into the app, as one row of buttons. */
export function ReleaseLinks({ links, onFollow }: { links: ReleaseLink[]; onFollow?: (e: React.MouseEvent) => void }) {
    if (links.length === 0) return null;
    return (
        <div className="flex flex-wrap gap-2">
            {links.map((link) => (
                <Link
                    key={link.href}
                    href={link.href}
                    onClick={onFollow}
                    className="min-h-11 py-2.5 px-4 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] text-white text-sm font-medium flex items-center gap-2 transition-colors"
                >
                    {link.label}
                    <ArrowRight className="w-4 h-4" />
                </Link>
            ))}
        </div>
    );
}
