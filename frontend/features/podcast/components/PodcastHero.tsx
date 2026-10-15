"use client";

import type { ReactNode } from "react";
import type { ColorPalette } from "@/hooks/useImageColor";
import { SpokenHero, type SpokenHeroDetail } from "@/features/spoken/SpokenHero";
import type { CategoryRef } from "../types";

interface PodcastHeroProps {
    title: string;
    author: string;
    description?: string;
    genres?: string[];
    categories?: CategoryRef[];
    heroImage: string | null;
    colors: ColorPalette | null;
    episodeCount: number;
    inProgressCount: number;
    children?: ReactNode;
}

export function PodcastHero({
    title,
    author,
    description,
    genres,
    categories,
    heroImage,
    colors,
    episodeCount,
    inProgressCount,
    children,
}: PodcastHeroProps) {
    const details: SpokenHeroDetail[] = [
        { text: `${episodeCount} ${episodeCount === 1 ? "episode" : "episodes"}` },
        ...(inProgressCount > 0
            ? [{ text: `${inProgressCount} in progress`, className: "text-[var(--color-brand)]" }]
            : []),
    ];

    return (
        <SpokenHero
            kind="podcast"
            title={title}
            author={author}
            description={description}
            details={details}
            tags={
                categories && categories.length > 0
                    ? categories.slice(0, 4).map((c) => ({ label: c.name, href: `/podcasts/category/${c.id}` }))
                    : (genres ?? []).slice(0, 4).map((label) => ({ label }))
            }
            heroImage={heroImage}
            colors={colors}
        >
            {children}
        </SpokenHero>
    );
}
