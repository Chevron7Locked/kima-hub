import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";

const answer = (status: number, body: unknown) =>
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

afterEach(() => vi.restoreAllMocks());

describe("clearDownloadFromHistory", () => {
    it("treats a download the server says is not there as already cleared, without logging an error", async () => {
        answer(404, { error: "Download not found" });
        const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

        await expect(api.clearDownloadFromHistory("gone")).resolves.toEqual({ success: true });

        expect(log).not.toHaveBeenCalled();
    });

    it("still raises a download that is running", async () => {
        answer(409, { error: "Download is still running" });
        vi.spyOn(console, "error").mockImplementation(() => undefined);

        await expect(api.clearDownloadFromHistory("busy")).rejects.toThrow("Download is still running");
    });
});
