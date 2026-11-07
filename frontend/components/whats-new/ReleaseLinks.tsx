"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { ReleaseLink } from "./types";

const BUTTON =
    "min-h-11 py-2.5 px-4 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] text-white text-sm font-medium flex items-center gap-2 transition-colors";

/** A release item's links, as one row of buttons: a page in the app, or an https address that opens in a new tab. */
export function ReleaseLinks({ links, onFollow }: { links: ReleaseLink[]; onFollow?: (e: React.MouseEvent) => void }) {
    if (links.length === 0) return null;
    return (
        <div className="flex flex-wrap gap-2">
            {links.map((link) =>
                link.href.startsWith("https://") ? (
                    <a key={link.href} href={link.href} target="_blank" rel="noopener noreferrer" className={BUTTON}>
                        {link.label}
                        <ArrowRight className="w-4 h-4" />
                    </a>
                ) : (
                    <Link key={link.href} href={link.href} onClick={onFollow} className={BUTTON}>
                        {link.label}
                        <ArrowRight className="w-4 h-4" />
                    </Link>
                ),
            )}
        </div>
    );
}
