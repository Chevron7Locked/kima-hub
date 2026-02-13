"use client";

import { cn } from "@/utils/cn";

interface SkeletonProps {
    className?: string;
}

export function Skeleton({ className }: SkeletonProps) {
    return (
        <div
            className={cn("animate-pulse bg-[#1a1a1a] rounded-sm", className)}
        />
    );
}

