"use client";

import { ChevronRight } from "lucide-react";
import { Card } from "@/components/ui/Card";

export function HowItWorks() {
    return (
        <Card className="p-6 bg-[var(--bg-secondary)] border border-[var(--border-subtle)]">
            <h3 className="text-lg font-bold mb-4 flex items-center gap-2 text-white">
                How It Works
            </h3>
            <div className="space-y-3 text-sm text-[var(--text-secondary)]">
                <div className="flex items-start gap-3">
                    <ChevronRight className="w-4 h-4 mt-0.5 text-[var(--text-muted)] shrink-0" />
                    <p>
                        Starts from the artists you&apos;ve played recently (or your
                        library, before you&apos;ve played much) and finds similar artists on
                        ListenBrainz, then Deezer
                    </p>
                </div>
                <div className="flex items-start gap-3">
                    <ChevronRight className="w-4 h-4 mt-0.5 text-[var(--text-muted)] shrink-0" />
                    <p>
                        Mixes close and distant matches: 30% close, 40% near,
                        20% further out, 10% wild cards
                    </p>
                </div>
                <div className="flex items-start gap-3">
                    <ChevronRight className="w-4 h-4 mt-0.5 text-[var(--text-muted)] shrink-0" />
                    <p>
                        Each pick downloads its whole album through Lidarr or Soulseek
                    </p>
                </div>
                <div className="flex items-start gap-3">
                    <ChevronRight className="w-4 h-4 mt-0.5 text-[var(--text-muted)] shrink-0" />
                    <p>
                        Like a song to keep its whole album in your library. Unliked
                        albums are removed at the end of the week.
                    </p>
                </div>
                <div className="flex items-start gap-3">
                    <ChevronRight className="w-4 h-4 mt-0.5 text-[var(--text-muted)] shrink-0" />
                    <p>Albums don&apos;t repeat for 6 months (you can change this)</p>
                </div>
                <div className="flex items-start gap-3">
                    <ChevronRight className="w-4 h-4 mt-0.5 text-[var(--text-muted)] shrink-0" />
                    <p>
                        If an album isn&apos;t available to download, it&apos;s
                        automatically replaced and you can still preview it via Deezer
                    </p>
                </div>
            </div>
        </Card>
    );
}
