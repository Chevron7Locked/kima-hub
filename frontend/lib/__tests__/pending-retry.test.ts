import { describe, expect, it } from "vitest";
import { retryNotice } from "../pending-retry";

const failure = (status: number, data: object) => Object.assign(new Error("x"), { status, data });

describe("retryNotice", () => {
    it("says Soulseek has no files for a 404 that carries NO_SOURCES, with the server's message", () => {
        const err = failure(404, { code: "NO_SOURCES", error: "No matching files found", message: "Nothing found for this song" });
        expect(retryNotice(err, "Failed to retry download")).toEqual({
            title: "Track not found on Soulseek",
            message: "Nothing found for this song",
            expected: true,
        });
    });

    it("does not read the error text: the same words without the code are a generic failure", () => {
        expect(retryNotice(failure(404, { error: "No matching files found" }), "Failed to retry download")).toEqual({
            title: "Failed to retry download",
        });
    });

    it("tells a 502 from a missing source, with the reason the server gave", () => {
        const notice = retryNotice(failure(502, { success: false, error: "slskd is not reachable" }), "Failed to retry downloads");
        expect(notice).toEqual({ title: "Soulseek is not answering", message: "slskd is not reachable" });
    });

    it("falls back to the caller's title for any other failure, including a non-error", () => {
        expect(retryNotice(failure(500, {}), "Failed to retry downloads")).toEqual({ title: "Failed to retry downloads" });
        expect(retryNotice(undefined, "Failed to retry downloads")).toEqual({ title: "Failed to retry downloads" });
    });
});
