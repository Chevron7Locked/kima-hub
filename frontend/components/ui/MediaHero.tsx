"use client";

import { memo, type ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { HeroBackdrop } from "@/components/ui/HeroBackdrop";
import { CachedImage } from "@/components/ui/CachedImage";
import { cn } from "@/lib/cn";
import type { ColorPalette } from "@/hooks/useImageColor";

interface HeroCoverProps {
    image: string | null;
    alt: string;
    shape: "square" | "circle";
    fallbackIcon: ReactNode;
    bgClass?: string;
}

/** The 140/192 cover box under a hero: one place the size, ring and shadow live. */
const HeroCover = memo(function HeroCover({
    image,
    alt,
    shape,
    fallbackIcon,
    bgClass = "bg-[#282828]",
}: HeroCoverProps) {
    return (
        <div
            className={cn(
                "w-[140px] h-[140px] md:w-[192px] md:h-[192px] shrink-0 overflow-hidden relative ring-1 ring-white/10 shadow-[0_8px_30px_rgba(0,0,0,0.45)]",
                shape === "circle" ? "rounded-full" : "rounded-[14px]",
                bgClass,
            )}
        >
            {image ? (
                <CachedImage
                    src={image}
                    alt={alt}
                    fill
                    sizes="(max-width: 768px) 140px, 192px"
                    className="object-cover"
                    priority
                />
            ) : (
                <div className="w-full h-full flex items-center justify-center">
                    {fallbackIcon}
                </div>
            )}
        </div>
    );
});

interface MediaHeroProps {
    image: string | null;
    /** The cover box art; defaults to the backdrop image. */
    coverImage?: string | null;
    alt: string;
    colors: ColorPalette | null;
    tint: "music" | "spoken";
    fallback: [string, string];
    shape: "square" | "circle";
    fallbackIcon: ReactNode;
    eyebrowDotClass: string;
    eyebrowLabel: string;
    title: string;
    /** Beside the title: the metadata edit controls. */
    titleExtra?: ReactNode;
    /** Spacing between title and edit controls; artist keeps the wider gap-3. */
    titleGap?: "gap-2" | "gap-3";
    /** The dot-separated meta line under the title. */
    meta: ReactNode;
    /** A block under the meta line: the genre chip, the tags. */
    metaExtra?: ReactNode;
    /** A short description between the title and the meta line, shown from the medium breakpoint up. */
    description?: string;
    /** A link back to the list this page belongs to, above the hero. */
    back?: { href: string; label: string };
    /** The cover box's background behind a missing cover. */
    coverBgClass?: string;
    children?: ReactNode;
}

/** The page hero: backdrop, cover, eyebrow, title, meta. Albums, artists, audiobooks and podcasts share it. */
export function MediaHero({
    image,
    coverImage,
    alt,
    colors,
    tint,
    fallback,
    shape,
    fallbackIcon,
    eyebrowDotClass,
    eyebrowLabel,
    title,
    titleExtra,
    titleGap = "gap-2",
    meta,
    metaExtra,
    description,
    back,
    coverBgClass,
    children,
}: MediaHeroProps) {
    return (
        <div className="relative animate-rise">
            <HeroBackdrop image={image} alt={alt} colors={colors} tint={tint} fallback={fallback} />

            <div className={cn("relative page-shell pb-6", back ? "pt-8" : "pt-16")}>
                {back && (
                    <Link
                        href={back.href}
                        className="inline-flex items-center gap-2 text-xs tabular-nums text-[var(--text-muted)] hover:text-white transition-colors mb-6"
                    >
                        <ArrowLeft className="w-3.5 h-3.5" />
                        {back.label}
                    </Link>
                )}
                <div className="flex items-end gap-6">
                    <HeroCover
                        image={coverImage ?? image}
                        alt={alt}
                        shape={shape}
                        fallbackIcon={fallbackIcon}
                        bgClass={coverBgClass}
                    />

                    <div className="flex-1 min-w-0 pb-1">
                        <div className="flex items-center gap-2 mb-1">
                            <div className={cn("w-1.5 h-1.5 rounded-full", eyebrowDotClass)} />
                            <span className="t-eyebrow">{eyebrowLabel}</span>
                        </div>
                        <div className={cn("flex items-center group mb-2", titleGap)}>
                            <h1 className="text-2xl md:text-4xl lg:text-5xl font-bold tracking-tight text-white leading-tight line-clamp-2">
                                {title}
                            </h1>
                            {titleExtra}
                        </div>
                        {description && (
                            <p className="text-sm text-[var(--text-muted)] line-clamp-2 max-w-3xl mb-3 hidden md:block">
                                {description}
                            </p>
                        )}
                        <div className="flex flex-wrap items-center gap-1 text-sm text-[var(--text-secondary)] mb-1">
                            {meta}
                        </div>
                        {metaExtra}
                    </div>
                </div>
            </div>

            {children && <div className="relative page-shell pb-4">{children}</div>}
        </div>
    );
}
