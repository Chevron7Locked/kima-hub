/**
 * The playlist import routes: a bad body is a 400 on every route, an import starts only from the caller's own finished
 * preview (both the web and the app make one first), and an import job answers only its owner. The import service is
 * stood in for; the routes are real.
 */
jest.mock("../../utils/logger", () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock("../../middleware/auth", () => ({
    requireAuthOrToken: (req: any, _res: any, next: any) => {
        req.user = { id: req.headers["x-user"] || "me", role: "admin" };
        next();
    },
}));
const mockService = {
    startPreviewJob: jest.fn(),
    getPreviewResult: jest.fn(),
    quickImport: jest.fn(),
    startImport: jest.fn(),
    getUserJobs: jest.fn(),
    refreshJobMatches: jest.fn(),
    cancelJob: jest.fn(),
    generatePreview: jest.fn(),
    generatePreviewFromDeezer: jest.fn(),
    generatePreviewFromExternalPlatform: jest.fn(),
    isExternalPlatformUrl: jest.fn(),
    importFromM3U: jest.fn(),
};
const mockGetImportJob = jest.fn();
jest.mock("../../services/spotifyImport", () => ({
    spotifyImportService: mockService,
    getImportJob: (...a: unknown[]) => mockGetImportJob(...a),
}));

import express from "express";
import request from "supertest";
import spotifyRoutes from "../spotify";

const app = express().use(express.json()).use("/spotify", spotifyRoutes);
const PREVIEW = { playlist: { id: "pl", name: "Mix" }, matches: [] };
const importBody = { spotifyPlaylistId: "pl", playlistName: "Mix", albumMbidsToDownload: [], previewJobId: "pv-1" };

beforeEach(() => {
    jest.clearAllMocks();
    mockService.getPreviewResult.mockResolvedValue({ status: "completed", preview: PREVIEW, userId: "me" });
    mockService.startImport.mockResolvedValue({ id: "job-1", status: "pending" });
    mockService.startPreviewJob.mockResolvedValue({ jobId: "pv-2" });
    mockService.quickImport.mockResolvedValue({ jobId: "job-q" });
    mockService.refreshJobMatches.mockResolvedValue({ added: 2, total: 5 });
    mockService.cancelJob.mockResolvedValue({ playlistCreated: false, playlistId: null, tracksMatched: 0 });
    mockGetImportJob.mockResolvedValue({ id: "job-1", userId: "me", status: "processing" });
});

describe("a bad body", () => {
    it.each([
        ["/spotify/preview/start", { url: "not a url" }],
        ["/spotify/import/quick", {}],
        ["/spotify/import", { playlistName: "Mix" }],
    ])("is a 400 at %s", async (path, body) => {
        const res = await request(app).post(path).send(body);
        expect(res.status).toBe(400);
        expect(res.body.error).toBe("Invalid request body");
    });
});

describe("POST /spotify/import", () => {
    it("starts from the caller's finished preview", async () => {
        const res = await request(app).post("/spotify/import").send(importBody).expect(200);
        expect(res.body).toEqual({ jobId: "job-1", status: "pending", message: "Import started" });
        expect(mockService.startImport).toHaveBeenCalledWith("me", "pl", "Mix", [], PREVIEW);
    });

    it("needs a preview: one is never built here", async () => {
        const { previewJobId: _, ...withoutPreview } = importBody;
        const res = await request(app).post("/spotify/import").send({ ...withoutPreview, url: "https://open.spotify.com/playlist/pl" });
        expect(res.status).toBe(400);
        expect(mockService.generatePreview).not.toHaveBeenCalled();
        expect(mockService.startImport).not.toHaveBeenCalled();
    });

    it("refuses a preview that is not finished, and someone else's", async () => {
        mockService.getPreviewResult.mockResolvedValueOnce({ status: "pending" });
        expect((await request(app).post("/spotify/import").send(importBody)).status).toBe(400);
        mockService.getPreviewResult.mockResolvedValueOnce({ status: "completed", preview: PREVIEW, userId: "someone" });
        expect((await request(app).post("/spotify/import").send(importBody)).status).toBe(403);
        expect(mockService.startImport).not.toHaveBeenCalled();
    });
});

describe("POST /spotify/import/quick", () => {
    it("takes a playlist address and refuses anything else", async () => {
        await request(app).post("/spotify/import/quick").send({ url: "https://open.spotify.com/playlist/abc" }).expect(200);
        await request(app).post("/spotify/import/quick").send({ url: "https://example.com/playlist/abc" }).expect(400);
        expect(mockService.quickImport).toHaveBeenCalledTimes(1);
    });
});

describe("an import job", () => {
    it.each([
        ["get", "/spotify/import/job-1/status"],
        ["post", "/spotify/import/job-1/refresh"],
        ["post", "/spotify/import/job-1/cancel"],
    ] as const)("answers its owner at %s %s, refuses others, and is 404 when gone", async (method, path) => {
        expect((await request(app)[method](path)).status).toBe(200);
        expect((await request(app)[method](path).set("x-user", "someone")).status).toBe(403);
        mockGetImportJob.mockResolvedValueOnce(null);
        expect((await request(app)[method](path)).status).toBe(404);
    });

    it("refresh and cancel say what they did", async () => {
        expect((await request(app).post("/spotify/import/job-1/refresh")).body).toEqual({ message: "Added 2 newly downloaded track(s)", added: 2, total: 5 });
        expect((await request(app).post("/spotify/import/job-1/cancel")).body).toEqual({ message: "Import cancelled.", playlistId: null, tracksMatched: 0 });
    });
});
