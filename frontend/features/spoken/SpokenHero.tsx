"use client";

import { ArrowLeft, Book, Mic2 } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ColorPalette } from "@/hooks/useImageColor";
import { HeroBackdrop } from "@/components/ui/HeroBackdrop";
import { HeroCover } from "@/components/ui/MediaHero";
import { cn } from "@/lib/cn";

const KINDS = {
    audiobook: {
        backHref: "/audiobooks",
        backLabel: "Audiobooks",
        label: "Audiobook",
        dot: "bg-type-audiobook",
        Icon: Book,
        fallback: ["#2a1e0a", "#1a140a"] as [string, string],
    },
    series: {
        backHref: "/audiobooks",
        backLabel: "Audiobooks",
        label: "Series",
        dot: "bg-type-audiobook",
        Icon: Book,
        fallback: ["#2a1e0a", "#1a140a"] as [string, string],
    },
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
    const router = useRouter();
    const { backHref, backLabel, label, dot, Icon, fallback } = KINDS[kind];

    return (
        <div className="relative">
            <HeroBackdrop
                image={heroImage}
                alt={title}
                colors={colors}
                tint="spoken"
                fallback={fallback}
            />

            <div className="relative page-shell pt-8 pb-6">
                <button
                    onClick={() => router.push(backHref)}
                    className="flex items-center gap-2 text-xs tabular-nums text-[var(--text-muted)] hover:text-white transition-colors mb-6"
                >
                    <ArrowLeft className="w-3.5 h-3.5" />
                    {backLabel}
                </button>

                <div className="flex items-center gap-2 mb-4">
                    <div className={cn("w-1.5 h-1.5 rounded-full", dot)} />
                    <span className="t-eyebrow">{label}</span>
                </div>

                <div className="flex items-end gap-6">
                    <HeroCover
                        image={heroImage}
                        alt={title}
                        shape="square"
                        fallbackIcon={<Icon className="w-16 h-16 text-[var(--text-muted)]" />}
                        bgClass="bg-[var(--bg-primary)]"
                    />

                    <div className="flex-1 min-w-0 pb-1">
                        <h1 className="text-2xl md:text-4xl lg:text-5xl font-bold text-white leading-tight line-clamp-2 mb-2 tracking-tight">
                            {title}
                        </h1>

                        {description && (
                            <p className="text-sm text-[var(--text-muted)] line-clamp-2 max-w-3xl mb-3 hidden md:block">
                                {truncateDescription(description, 200)}
                            </p>
                        )}

                        <div className="flex flex-wrap items-center gap-3 text-xs tabular-nums text-[var(--text-secondary)]">
                            <span className="font-bold text-white tracking-tight text-sm">
                                {author}
                            </span>
                            {details.map(({ text, className }) => (
                                <Fragment key={text}>
                                    <span className="text-[var(--text-muted)]">|</span>
                                    <span className={className}>{text}</span>
                                </Fragment>
                            ))}
                        </div>

                        {tags.length > 0 && (
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
                        )}
                    </div>
                </div>
            </div>

            {children && <div className="relative page-shell pb-4">{children}</div>}
        </div>
    );
}
