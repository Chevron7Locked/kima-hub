/**
 * When fetching a cover from its host fails, the cover and colour routes answer with what happened, never a 500: a
 * refused or malformed address is the request's (400), a host with no such picture a 404, and a host that cannot
 * be reached (a connection reset twice, a name that does not resolve) a 502. The network fetch is stood in for with
 * the errors Node's fetch and the address guard really throw; the guard itself is tested in ssrfRedirects.
 */
jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));
jest.mock("../../middleware/rateLimiter", () => ({
    imageLimiter: (_req: any, _res: any, next: any) => next(),
    apiLimiter: (_req: any, _res: any, next: any) => next(),
}));
jest.mock("../../utils/redis", () => ({
    redisClient: { get: jest.fn().mockResolvedValue(null), setex: jest.fn().mockResolvedValue("OK") },
}));
jest.mock("../../utils/systemSettings", () => ({ getSystemSettings: jest.fn().mockResolvedValue({}) }));
const mockFetchChecked = jest.fn();
jest.mock("../../utils/ssrf", () => ({
    ...jest.requireActual("../../utils/ssrf"),
    fetchChecked: (...a: unknown[]) => mockFetchChecked(...a),
}));

import express from "express";
import request from "supertest";
import libraryCoverArtRoutes from "../library/coverArt";
import { BlockedAddressError, InvalidAddressError, UnresolvedAddressError } from "../../utils/ssrf";
import { redisClient } from "../../utils/redis";

const app = express();
app.use("/library", libraryCoverArtRoutes);

const COVER = "https://covers.example.org/a.jpg";
const cover = () => request(app).get(`/library/cover-art?url=${encodeURIComponent(COVER)}`);
/** What Node's fetch throws when the host drops the connection. */
const reset = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });

beforeEach(() => mockFetchChecked.mockReset());

describe("GET /library/cover-art?url=", () => {
    it("tries once more after a dropped connection, and answers 502 when that fails too", async () => {
        mockFetchChecked.mockRejectedValueOnce(reset()).mockRejectedValueOnce(reset());
        const res = await cover();
        expect(res.status).toBe(502);
        expect(mockFetchChecked).toHaveBeenCalledTimes(2);
    });

    it("answers 400 for an address the guard refuses or that is not an address", async () => {
        mockFetchChecked.mockRejectedValueOnce(new BlockedAddressError("Blocked: internal address"));
        expect((await cover()).status).toBe(400);
        mockFetchChecked.mockRejectedValueOnce(new InvalidAddressError("Invalid URL"));
        expect((await cover()).status).toBe(400);
    });

    it("answers 502 for a host name that does not resolve, without trying again", async () => {
        mockFetchChecked.mockRejectedValueOnce(new UnresolvedAddressError("DNS resolution failed for covers.example.org"));
        expect((await cover()).status).toBe(502);
        expect(mockFetchChecked).toHaveBeenCalledTimes(1);
    });

    it("answers 404 when the host has no such picture", async () => {
        mockFetchChecked.mockResolvedValueOnce(new Response("nope", { status: 404, statusText: "Not Found" }));
        expect((await cover()).status).toBe(404);
    });

    it("answers 502 when the host errs or is busy, and never remembers that as no picture", async () => {
        for (const [status, statusText] of [[500, "Internal Server Error"], [503, "Service Unavailable"], [429, "Too Many Requests"]] as const) {
            jest.mocked(redisClient.setex).mockClear();
            mockFetchChecked.mockResolvedValueOnce(new Response("oops", { status, statusText }));
            expect({ upstream: status, answer: (await cover()).status }).toEqual({ upstream: status, answer: 502 });
            expect({ upstream: status, cached: jest.mocked(redisClient.setex).mock.calls.length }).toEqual({ upstream: status, cached: 0 });
        }
    });
});
