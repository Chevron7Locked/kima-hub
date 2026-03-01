import Link from "next/link";
import Image from "next/image";
import { Play, LucideIcon } from "lucide-react";
import { cn } from "@/utils/cn";

interface MediaCardProps {
    href: string;
    title: string;
    subtitle: string;
    imageUrl: string | null;
    fallbackIcon: LucideIcon;
    accentColor: {
        border: string;
        gradient: string;
        button: string;
        shadow: string;
    };
    index?: number;
    imageClassName?: string;
}

export function MediaCard({
    href,
    title,
    subtitle,
    imageUrl,
    fallbackIcon: FallbackIcon,
    accentColor,
    index = 0,
    imageClassName = "",
}: MediaCardProps) {
    return (
        <Link
            href={href}
            data-tv-card
            data-tv-card-index={index}
            tabIndex={0}
            className="group block"
        >
            <div
                className={cn(
                    "relative bg-[#0a0a0a] border-2 border-white/10 rounded-lg overflow-hidden transition-all duration-300 hover:shadow-lg",
                    accentColor.border,
                    accentColor.shadow,
                )}
            >
                <div className="relative aspect-square">
                    <div
                        className={cn(
                            "w-full h-full bg-[#181818] flex items-center justify-center overflow-hidden",
                            imageClassName,
                        )}
                    >
                        {imageUrl ? (
                            <Image
                                src={imageUrl}
                                alt={title}
                                fill
                                sizes="(max-width: 640px) 50vw, (max-width: 1024px) 25vw, 16vw"
                                className="object-cover group-hover:scale-110 transition-transform duration-500"
                                loading="lazy"
                                unoptimized
                            />
                        ) : (
                            <FallbackIcon className="w-12 h-12 text-gray-700" />
                        )}
                    </div>

                    {/* Gradient overlay on hover */}
                    <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />

                    {/* Play button */}
                    <div
                        className={cn(
                            "absolute bottom-3 right-3 w-11 h-11 rounded-lg flex items-center justify-center shadow-xl opacity-0 group-hover:opacity-100 transition-all duration-200",
                            accentColor.button,
                        )}
                    >
                        <Play className="w-5 h-5 fill-current ml-0.5" />
                    </div>

                    {/* Color accent bar */}
                    <div
                        className={cn(
                            "absolute bottom-0 left-0 right-0 h-1 transform scale-x-0 group-hover:scale-x-100 transition-transform duration-300",
                            accentColor.gradient,
                        )}
                    />
                </div>

                {/* Info section */}
                <div className="p-3 bg-gradient-to-b from-[#0a0a0a] to-[#0f0f0f]">
                    <h3 className="text-sm font-black text-white truncate mb-1 tracking-tight">
                        {title}
                    </h3>
                    <p className="text-xs font-mono text-gray-500 uppercase tracking-wider truncate">
                        {subtitle}
                    </p>
                </div>
            </div>
        </Link>
    );
}
