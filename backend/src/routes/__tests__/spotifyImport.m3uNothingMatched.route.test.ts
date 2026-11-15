/**
 * POST /spotify/import/m3u when no entry of the file matched a song: 422 with the reason in the usual `error` field
 * (the web form shows it as it shows every other import error), and the success reply keeps its shape. The import
 * service is stood in for; the route is real.
 */
jest.mock("../../middleware/auth", () => ({
    requireAuthOrToken: (req: any, _res: any, next: any) => {
        req.user = { id: "me", role: "admin" };
        next();
    },
}));
const mockImportFromM3U = jest.fn();
jest.mock("../../services/spotifyImport", () => ({
    spotifyImportService: { importFromM3U: (...a: unknown[]) => mockImportFromM3U(...a) },
    getImportJob: jest.fn(),
}));

import express from "express";
import request from "supertest";
import spotifyRoutes from "../spotify";
import { M3UNothingMatched } from "../../services/m3uParser";
import { mountAsServer } from "./helpers/serverMount";

const app = mountAsServer(express().use(express.json()), "/spotify", spotifyRoutes, "/api/spotify");
const upload = () => request(app).post("/spotify/import/m3u").field("playlistName", "Mix").attach("file", Buffer.from("#EXTM3U\nA/b.flac\n"), "mix.m3u");

it("answers 422 with the reason when no entry matched a song", async () => {
    mockImportFromM3U.mockRejectedValueOnce(new M3UNothingMatched(3));
    const res = await upload();
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: "none of the 3 entries in this file matched a song in your library" });
});

it("keeps the success reply as it was", async () => {
    mockImportFromM3U.mockResolvedValueOnce({ playlistId: "p", matched: 1, unmatched: 0, total: 1 });
    const res = await upload();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ playlistId: "p", matched: 1, unmatched: 0, total: 1 });
});
