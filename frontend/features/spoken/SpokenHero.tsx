"use client";

import { Book, Mic2 } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import Link from "next/link";
import type { ColorPalette } from "@/hooks/useImageColor";
import { MediaHero } from "@/components/ui/MediaHero";
import { cn } from "@/lib/cn";

const AUDIOBOOKS = {
    backHref: "/audiobooks",
    backLabel: "Audiobooks",
    dot: "bg-type-audiobook",
    Icon: Book,
    fallback: ["#2a1e0a", "#1a140a"] as [string, string],
};

const KINDS = {
    audiobook: { ...AUDIOBOOKS, label: "Audiobook" },
    series: { ...AUDIOBOOKS, label: "Series" },
    podcast: {
        backHref: "/podcasts",
        backLabel: "Podcasts",
        label: "Podcast",
        dot: "bg-type-podcast",
        Icon: Mic2,
        fallback: ["#251a33", "#120e18"] as [string, string],
    },
};

export interface SpokenHeroDetail {
    text: string;
    className?: string;
}

interface SpokenHeroTag {
    label: string;
    accent?: boolean;
    href?: string;
}

interface SpokenHeroProps {
    kind: keyof typeof KINDS;
    title: string;
    author: string;
    description?: string;
    details: SpokenHeroDetail[];
    tags: SpokenHeroTag[];
    heroImage: string | null;
    colors: ColorPalette | null;
    children?: ReactNode;
}

function truncateDescription(description: string, maxLen: number): string {
    const clean = description.replace(/<[^>]*>/g, "").trim();
    if (clean.length <= maxLen) return clean;
    return clean.substring(0, maxLen).trimEnd() + "...";
}

export function SpokenHero({
    kind,
    title,
    author,
    description,
    details,
    tags,
    heroImage,
    colors,
    children,
}: SpokenHeroProps) {
    const { backHref, backLabel, label, dot, Icon, fallback } = KINDS[kind];

    return (
        <MediaHero
            image={heroImage}
            alt={title}
            colors={colors}
            tint="spoken"
            fallback={fallback}
            shape="square"
            fallbackIcon={<Icon className="w-16 h-16 text-[var(--text-muted)]" />}
            coverBgClass="bg-[var(--bg-primary)]"
            eyebrowDotClass={dot}
            eyebrowLabel={label}
            title={title}
            back={{ href: backHref, label: backLabel }}
            description={description ? truncateDescription(description, 200) : undefined}
            meta={
                <div className="flex flex-wrap items-center gap-3 text-xs tabular-nums">
                    <span className="font-bold text-white tracking-tight text-sm">{author}</span>
                    {details.map(({ text, className }) => (
                        <Fragment key={text}>
                            <span className="text-[var(--text-muted)]">|</span>
                            <span className={className}>{text}</span>
                        </Fragment>
                    ))}
                </div>
            }
            metaExtra={
                tags.length > 0 ? (
                    // Linked tags are navigation, so they show on phones too; plain ones are detail.
                    <div className={cn("flex-wrap gap-1.5 mt-3", tags.some((t) => t.href) ? "flex" : "hidden md:flex")}>
                        {tags.map(({ label: tag, accent, href }) => {
                            const look = cn(
                                "px-2.5 py-0.5 bg-white/5 border border-white/10 rounded text-xs tabular-nums",
                                accent ? "text-brand" : "text-[var(--text-secondary)]",
                            );
                            return href ? (
                                <Link key={tag} href={href} className={cn(look, "transition-colors hover:border-white/25 hover:text-white")}>
                                    {tag}
                                </Link>
                            ) : (
                                <span key={tag} className={look}>
                                    {tag}
                                </span>
                            );
                        })}
                    </div>
                ) : undefined
            }
        >
            {children}
        </MediaHero>
    );
}
