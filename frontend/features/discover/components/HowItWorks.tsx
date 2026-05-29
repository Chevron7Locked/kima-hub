"use client";

import { ChevronRight } from "lucide-react";
import { Card } from "@/components/ui/Card";

export function HowItWorks() {
    return (
        <Card className="p-6 bg-[var(--bg-secondary)] border border-[var(--border-subtle)]">
            <h3 className="text-lg font-bold mb-4 flex items-center gap-2 text-white">
                How It Works
            </h3>
            <div className="space-y-3 text-sm text-gray-400">
                <div className="flex items-start gap-3">
                    <ChevronRight className="w-4 h-4 mt-0.5 text-purple-500/60 shrink-0" />
                    <p>
                        Analyzes your listening history and library using
                        Last.fm similarity data
                    </p>
                </div>
                <div className="flex items-start gap-3">
                    <ChevronRight className="w-4 h-4 mt-0.5 text-purple-500/60 shrink-0" />
                    <p>
                        Discovers similar artists across tiers: High (80-100%),
                        Medium (50-79%), Explore (30-49%), Wild Cards (0-29%)
                    </p>
                </div>
                <div className="flex items-start gap-3">
                    <ChevronRight className="w-4 h-4 mt-0.5 text-purple-500/60 shrink-0" />
                    <p>
                        Selecting one song from an album downloads the full album
                        to <span className="font-mono text-white/50">/music/discovery</span>
                    </p>
                </div>
                <div className="flex items-start gap-3">
                    <ChevronRight className="w-4 h-4 mt-0.5 text-purple-500/60 shrink-0" />
                    <p>
                        Like an album to keep it in your library. Unliked albums
                        are removed at the end of the week.
                    </p>
                </div>
                <div className="flex items-start gap-3">
                    <ChevronRight className="w-4 h-4 mt-0.5 text-purple-500/60 shrink-0" />
                    <p>Albums won&apos;t repeat for 6 months</p>
                </div>
                <div className="flex items-start gap-3">
                    <ChevronRight className="w-4 h-4 mt-0.5 text-purple-500/60 shrink-0" />
                    <p>
                        If an album isn&apos;t available to download, it&apos;s
                        automatically replaced and you can still preview it via Deezer
                    </p>
                </div>
            </div>
        </Card>
    );
}
