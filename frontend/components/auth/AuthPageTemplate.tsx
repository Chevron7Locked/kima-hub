"use client";

import { ReactNode, useState, useEffect } from "react";
import Image from "next/image";
import { GalaxyBackground } from "@/components/ui/GalaxyBackground";

interface Artist {
    id: string;
    mbid?: string;
    name: string;
    heroUrl: string | null;
    albumCount?: number;
}

interface AuthPageTemplateProps {
    title: string;
    subtitle: string;
    children: ReactNode;
    showArtistBackground?: boolean;
}

export function AuthPageTemplate({
    title,
    subtitle,
    children,
    showArtistBackground = true,
}: AuthPageTemplateProps) {
    const [artists, setArtists] = useState<Artist[]>([]);
    const [currentArtistIndex, setCurrentArtistIndex] = useState(0);

    // Fetch featured artists for background rotation
    useEffect(() => {
        if (!showArtistBackground) return;

        const fetchArtists = async () => {
            try {
                const response = await fetch(
                    "/api/library/recently-listened?limit=10"
                );
                if (response.ok) {
                    const data = await response.json();
                    const artistsWithImages = data.artists.filter(
                        (a: Artist) => a.heroUrl
                    );
                    setArtists(
                        artistsWithImages.length > 0 ? artistsWithImages : []
                    );
                }
            } catch (err) {
                // Fail silently - page will work without backgrounds
            }
        };

        fetchArtists();
    }, [showArtistBackground]);

    // Rotate through artists every 5 seconds
    useEffect(() => {
        if (artists.length <= 1) return;

        const interval = setInterval(() => {
            setCurrentArtistIndex((prev) => (prev + 1) % artists.length);
        }, 5000);

        return () => clearInterval(interval);
    }, [artists.length]);

    const currentArtist = artists[currentArtistIndex];

    return (
        <div className="min-h-screen w-full relative overflow-hidden">
            {/* Animated Background with Artist Images */}
            <div className="absolute inset-0 bg-[#000]">
                {/* Subtle accent gradient */}
                <div className="absolute inset-0 bg-gradient-to-br from-[#fca200]/5 via-transparent to-transparent" />

                {/* Ultra-subtle starfield texture */}
                <div className="opacity-[0.08]">
                    <GalaxyBackground
                        primaryColor="#fca200"
                        secondaryColor="#fca200"
                    />
                </div>

                {showArtistBackground && artists.length > 0 && currentArtist?.heroUrl && (
                    <>
                        <div
                            key={currentArtistIndex}
                            className="absolute inset-0 transition-opacity duration-1000"
                        >
                            <Image
                                src={currentArtist.heroUrl}
                                alt={currentArtist.name}
                                fill
                                className="object-cover"
                                priority
                            />
                        </div>
                        {/* Heavy blur overlay */}
                        <div className="absolute inset-0 backdrop-blur-[100px] bg-black/60" />

                        {/* Gradient overlays for depth */}
                        <div className="absolute inset-0 bg-gradient-to-t from-black via-black/50 to-transparent" />
                        <div className="absolute inset-0 bg-gradient-to-b from-black/80 via-transparent to-black/80" />
                    </>
                )}
            </div>

            {/* Artist Info Section - Bottom Left */}
            {showArtistBackground && currentArtist && (
                <div className="absolute bottom-8 left-8 z-10 text-white max-w-md animate-fade-in">
                    <p className="text-sm font-medium text-white/60 mb-2">
                        Featured Artist
                    </p>
                    <h2 className="text-3xl md:text-4xl font-bold mb-2 drop-shadow-2xl">
                        {currentArtist.name}
                    </h2>
                    {currentArtist.albumCount !== undefined && (
                        <p className="text-white/70 text-sm">
                            {currentArtist.albumCount} album
                            {currentArtist.albumCount !== 1 ? "s" : ""} in your
                            library
                        </p>
                    )}
                </div>
            )}

            {/* Content - Centered */}
            <div className="relative z-20 min-h-screen flex items-center justify-center p-4">
                <div className="w-full max-w-md">
                    {/* Logo */}
                    <div className="flex items-center justify-center mb-8">
                        <div className="relative flex gap-3 items-center group">
                            <div className="relative">
                                <div className="absolute inset-0 bg-white/10 blur-xl rounded-full group-hover:bg-white/20 transition-all duration-300" />
                                <Image
                                    src="/assets/images/LIDIFY.webp"
                                    alt="Lidify"
                                    width={40}
                                    height={40}
                                    className="relative z-10 drop-shadow-2xl"
                                />
                            </div>
                            <span className="text-3xl font-bold bg-gradient-to-r from-white via-white to-gray-200 bg-clip-text text-transparent drop-shadow-2xl">
                                Lidify
                            </span>
                        </div>
                    </div>

                    {/* Content Card */}
                    <div className="bg-[#111]/90 rounded-lg p-6 md:p-8 border border-white/10 shadow-xl">
                        <h1 className="text-2xl font-bold text-white mb-1 text-center">
                            {title}
                        </h1>
                        <p className="text-white/60 text-center mb-8">
                            {subtitle}
                        </p>

                        {children}
                    </div>

                    {/* Footer */}
                    <p className="text-center text-white/40 text-sm mt-6">
                        © 2025 Lidify. Your music, your way.
                    </p>
                </div>
            </div>
        </div>
    );
}
