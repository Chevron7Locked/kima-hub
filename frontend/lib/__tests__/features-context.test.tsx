import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act, useEffect } from "react";

const auth: { isAuthenticated: boolean; user: { id: string } | null } = { isAuthenticated: false, user: null };
vi.mock("@/lib/auth-context", () => ({ useAuth: () => auth }));
const getFeatures = vi.fn();
vi.mock("@/lib/api", () => ({ api: { getFeatures: () => getFeatures() } }));

import { FeaturesProvider, useFeatures } from "@/lib/features-context";

const INSTALL = { musicCNN: true, vibeEmbeddings: true, audiobookshelfEnabled: false };

const seen: { last?: ReturnType<typeof useFeatures> } = {};
function Probe() {
    const features = useFeatures();
    useEffect(() => {
        seen.last = features;
    });
    return null;
}
const current = () => seen.last!;

let root: Root;
const render = () =>
    act(async () => {
        root.render(
            <FeaturesProvider>
                <Probe />
            </FeaturesProvider>,
        );
    });
const signIn = (id: string | null) => {
    auth.isAuthenticated = id !== null;
    auth.user = id === null ? null : { id };
};

beforeEach(() => {
    getFeatures.mockReset();
    signIn(null);
    root = createRoot(document.createElement("div"));
});

describe("live reporting in the features context", () => {
    it("is on only for the user the server named; signing out or another user signing in turns it off", async () => {
        getFeatures.mockResolvedValueOnce({ ...INSTALL, liveReporting: true });
        signIn("owner");
        await render();
        expect(current().liveReporting).toBe(true);

        signIn(null);
        await render();
        expect(current().liveReporting).toBe(false);

        // A guest signs in without a reload and their own request fails: nothing is inherited.
        getFeatures.mockRejectedValueOnce(new Error("offline"));
        signIn("guest");
        await render();
        expect(current().liveReporting).toBe(false);
        expect(current().musicCNN).toBe(true);

        act(() => root.unmount());
    });

    it("retries a failed first check in 5 s, once", async () => {
        vi.useFakeTimers();
        try {
            getFeatures
                .mockRejectedValueOnce(new Error("offline"))
                .mockRejectedValueOnce(new Error("still offline"))
                .mockResolvedValue({ ...INSTALL, liveReporting: true });
            signIn("owner");
            await render();
            expect(current().liveReporting).toBe(false);

            await act(async () => vi.advanceTimersByTime(5_000));
            expect(getFeatures).toHaveBeenCalledTimes(2);
            // A second failure in a row waits for the minute, not another 5 s.
            await act(async () => vi.advanceTimersByTime(50_000));
            expect(getFeatures).toHaveBeenCalledTimes(2);

            await act(async () => vi.advanceTimersByTime(10_000));
            expect(getFeatures).toHaveBeenCalledTimes(3);
            expect(current().liveReporting).toBe(true);
            act(() => root.unmount());
        } finally {
            vi.useRealTimers();
        }
    });

    it("drops a reply that lands after the user changed", async () => {
        let ownerReply: (v: unknown) => void = () => {};
        getFeatures
            .mockReturnValueOnce(new Promise((resolve) => (ownerReply = resolve)))
            .mockResolvedValueOnce({ ...INSTALL, liveReporting: false });
        signIn("owner");
        await render();
        signIn("guest");
        await render();

        await act(async () => ownerReply({ ...INSTALL, audiobookshelfEnabled: true, liveReporting: true }));

        expect(current()).toMatchObject({ liveReporting: false, audiobookshelfEnabled: false });
        act(() => root.unmount());
    });
});
