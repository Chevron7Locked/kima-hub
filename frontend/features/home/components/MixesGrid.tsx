"use client";

import { MixCard } from "@/components/MixCard";
import { Mix } from "../types";
import { memo, type CSSProperties } from "react";
import { cn } from "@/utils/cn";

interface MixesGridProps {
    mixes: Mix[];
}

const MixesGrid = memo(function MixesGrid({ mixes }: MixesGridProps) {
    return (
        <div className="flex gap-3 overflow-x-auto scrollbar-hide scroll-smooth snap-x snap-mandatory">
            {mixes.map((mix, index) => {
                const staggered = index < 8;
                return (
                    <div
                        key={mix.id}
                        className={cn(
                            "flex-shrink-0 snap-start w-[140px] sm:w-[160px] md:w-[170px] lg:w-[180px]",
                            staggered && "animate-rise [animation-delay:calc(var(--i)*45ms)]",
                        )}
                        style={staggered ? { "--i": index } as CSSProperties : undefined}
                    >
                        <MixCard mix={mix} index={index} />
                    </div>
                );
            })}
        </div>
    );
});

export { MixesGrid };
