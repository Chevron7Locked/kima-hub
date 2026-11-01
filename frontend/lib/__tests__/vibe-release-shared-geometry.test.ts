import { describe, expect, it, vi } from "vitest";
import { releaseSharedGeometry, sharedFullscreenGeometry } from "@/features/vibe/map/releaseSharedGeometry";

describe("releaseSharedGeometry", () => {
    it("tells every renderer holding the shared full-screen triangle to let go of it", () => {
        // A renderer that has drawn the triangle registers exactly this kind of listener, and it points back at the renderer.
        const listener = vi.fn();
        sharedFullscreenGeometry().addEventListener("dispose", listener);
        releaseSharedGeometry();
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it("can be called again after the triangle was released", () => {
        releaseSharedGeometry();
        expect(() => releaseSharedGeometry()).not.toThrow();
    });
});
