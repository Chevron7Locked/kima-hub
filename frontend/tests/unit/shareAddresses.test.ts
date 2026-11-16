/** A share's addresses encode its token wherever it sits, so a token with a reserved character stays one path segment. */

import { describe, expect, it } from "vitest";
import { shareCoverPath, shareUncountedPath, shareResolvePath, shareStreamPath } from "@/lib/shareAddresses";

describe("share addresses", () => {
    it("encode the token in the share, stream and cover addresses", () => {
        expect(shareResolvePath("a/b?c")).toBe("/api/share/a%2Fb%3Fc");
        expect(shareStreamPath("a/b", "t1")).toBe("/api/share/a%2Fb/stream/t1");
        expect(shareCoverPath("a/b", "native:x.jpg")).toBe("/api/share/a%2Fb/cover-art/native%3Ax.jpg?size=500");
    });

    it("the look at a share, which counts no visit, is the share's address with count=0", () => {
        expect(shareUncountedPath("a/b")).toBe("/api/share/a%2Fb?count=0");
    });
});
