/**
 * The M3U upload allows five a minute from one address: a runaway limit, not protection for a secret. The sixth is
 * a 429 in the limiter's own words. The real limiter and the real route are mounted; only the import is stood in for.
 */
jest.mock("../../middleware/auth", () => ({
    requireAuthOrToken: (req: any, _res: any, next: any) => {
        req.user = { id: "me", role: "admin" };
        next();
    },
}));
const mockImport = jest.fn();
jest.mock("../../services/spotifyImport", () => ({
    spotifyImportService: { importFromM3U: (...a: unknown[]) => mockImport(...a) },
    getImportJob: jest.fn(),
}));

import express from "express";
import request from "supertest";
import spotifyRoutes from "../spotify";
import { mountAsServer } from "./helpers/serverMount";

const app = mountAsServer(express().use(express.json()), "/spotify", spotifyRoutes, "/api/spotify");
const upload = () =>
    request(app).post("/spotify/import/m3u").field("playlistName", "Mix").attach("file", Buffer.from("a/b/1.flac\n"), "mix.m3u");

describe("POST /spotify/import/m3u", () => {
    it("answers the sixth upload in a minute with 429 and the limiter's wording", async () => {
        mockImport.mockResolvedValue({ playlistId: "p", matched: 1 });

        const first = [];
        for (let i = 0; i < 5; i++) first.push((await upload()).status);
        const sixth = await upload();

        expect(first).toEqual([200, 200, 200, 200, 200]);
        expect([sixth.status, sixth.body]).toEqual([429, { error: "Too many M3U imports, please wait a minute" }]);
        expect(mockImport).toHaveBeenCalledTimes(5);
    });
});
