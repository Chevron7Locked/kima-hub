// Deezer playlist ids are numbers. Anything else (such as the old /playlists/featured path, which now lands on the
// by-id route) is answered 404 here, without spending a Deezer request on it. Only the Deezer client is replaced.

const mockGetPlaylist = jest.fn();
jest.mock("../../services/deezer", () => ({ deezerService: { getPlaylist: mockGetPlaylist } }));
jest.mock("../../middleware/auth", () => ({ requireAuthOrToken: (_req: unknown, _res: unknown, next: () => void) => next() }));

import express from "express";
import request from "supertest";
import browseRoutes from "../browse";

const app = express().use("/browse", browseRoutes);

beforeEach(() => mockGetPlaylist.mockReset());

describe("GET /browse/playlists/:id", () => {
    it("answers 404 for an id that is not a number, without asking Deezer", async () => {
        for (const id of ["featured", "12a", "-1"]) {
            expect((await request(app).get(`/browse/playlists/${id}`)).status).toBe(404);
        }
        expect(mockGetPlaylist).not.toHaveBeenCalled();
    });

    it("asks Deezer for a numeric id", async () => {
        mockGetPlaylist.mockResolvedValue({ id: "908622995", title: "chart", tracks: [] });
        const res = await request(app).get("/browse/playlists/908622995");
        expect(res.status).toBe(200);
        expect(mockGetPlaylist).toHaveBeenCalledWith("908622995");
    });
});
