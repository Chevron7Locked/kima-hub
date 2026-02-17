"use client";

import { ChevronRight } from "lucide-react";
import { Card } from "@/components/ui/Card";

export function HowItWorks() {
    return (
        <Card className="p-6 bg-[#111]/50  border-white/5">
            <h3 className="text-lg font-bold mb-4 flex items-center gap-2 text-white">
                How It Works
            </h3>
            <div className="space-y-3 text-sm text-gray-400">
                <div className="flex items-start gap-3">
                    <ChevronRight className="w-4 h-4 mt-0.5 text-purple-400/60 shrink-0" />
                    <p>
                        Analyzes your listening history and library using
                        Last.fm similarity data
                    </p>
                </div>
                <div className="flex items-start gap-3">
                    <ChevronRight className="w-4 h-4 mt-0.5 text-purple-400/60 shrink-0" />
                    <p>
                        Discovers similar artists across tiers: High (80-100%),
                        Medium (50-79%), Explore (30-49%), Wild Cards (0-29%)
                    </p>
                </div>
                <div className="flex items-start gap-3">
                    <ChevronRight className="w-4 h-4 mt-0.5 text-purple-400/60 shrink-0" />
                    <p>
                        One song per album downloads the full album to
                        /music/discovery
                    </p>
                </div>
                <div className="flex items-start gap-3">
                    <ChevronRight className="w-4 h-4 mt-0.5 text-purple-400/60 shrink-0" />
                    <p>
                        Liked albums move to your library. Others removed at
                        week end.
                    </p>
                </div>
                <div className="flex items-start gap-3">
                    <ChevronRight className="w-4 h-4 mt-0.5 text-purple-400/60 shrink-0" />
                    <p>Albums won&apos;t repeat for 6 months</p>
                </div>
                <div className="flex items-start gap-3">
                    <ChevronRight className="w-4 h-4 mt-0.5 text-purple-400/60 shrink-0" />
                    <p>
                        If albums aren&apos;t available, they&apos;re
                        automatically replaced and you can still preview them
                        via Deezer
                    </p>
                </div>
            </div>
        </Card>
    );
}
