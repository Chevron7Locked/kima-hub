/**
 * Discover Weekly's date line shows the day the server's week starts on. The
 * server sends weekStart with its own offset, so the first ten characters are
 * its calendar date; a browser in another zone must not move that to the day
 * before or after. Each case switches this process's zone to the browser's.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createRoot } from "react-dom/client";
import React, { act } from "react";
import { DiscoverHero } from "@/features/discover/components/DiscoverHero";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ORIGINAL_TZ = process.env.TZ;

afterEach(() => {
    if (ORIGINAL_TZ === undefined) delete process.env.TZ;
    else process.env.TZ = ORIGINAL_TZ;
});

/** The date line DiscoverHero renders for `weekStart`, in a browser on `zone`. */
function dateLineIn(zone: string, weekStart: string): { zone: string; line: string | null } {
    process.env.TZ = zone;
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() => {
        root.render(
            <DiscoverHero
                playlist={{
                    weekStart,
                    weekEnd: weekStart,
                    tracks: [],
                    unavailable: [],
                    totalCount: 12,
                    unavailableCount: 0,
                }}
                config={null}
                onOpenSettings={() => {}}
            />,
        );
    });
    const line = container.querySelector('[data-testid="discover-week-start"]')?.textContent ?? null;
    act(() => root.unmount());
    return { zone: Intl.DateTimeFormat().resolvedOptions().timeZone, line };
}

describe("Discover Weekly's week date", () => {
    // Monday 19 October 2026 on servers in Tokyo, Chicago and Kiritimati.
    it.each([
        ["America/Los_Angeles", "2026-10-19T00:00:00.000+09:00"],
        ["America/Los_Angeles", "2026-10-19T00:00:00.000-05:00"],
        ["UTC", "2026-10-19T00:00:00.000+09:00"],
        ["Asia/Tokyo", "2026-10-19T00:00:00.000-05:00"],
        ["Asia/Tokyo", "2026-10-19T00:00:00.000+14:00"],
    ])("shows the server's Monday in a browser on %s for weekStart %s", (zone, weekStart) => {
        expect(dateLineIn(zone, weekStart)).toEqual({ zone, line: "Oct 19, 2026" });
    });

    it("keeps the same date on a UTC server, whatever the browser's zone", () => {
        for (const zone of ["America/Los_Angeles", "Asia/Tokyo", "UTC"]) {
            expect(dateLineIn(zone, "2026-10-19T00:00:00.000Z")).toEqual({ zone, line: "Oct 19, 2026" });
        }
    });
});
