/**
 * Deleting an artist from Lidarr. Lidarr's refresh of an artist, if still running when the artist is deleted, adds it
 * back when it saves the albums ("Adding missing parent artist"; seen every time on Lidarr 3.1.6). So a delete waits
 * for any refresh of that artist first, and counts only once Lidarr no longer has the artist. Lidarr's replies are
 * stood in for; a refresh command has the shape Lidarr 3.1.6 answered on `/api/v1/command` (`body.artistIds`, which
 * is also how it records Kima's `{ artistId }`).
 */
import { lidarrService } from "../lidarr";

const MBID = "40df8d18-6975-476c-9c04-2424d737bcc1";
const ARTIST = { id: 13, artistName: "Lomelda", foreignArtistId: MBID as string | undefined, tags: [] };
const refreshOf = (ids: number[], status = "started") => ({ name: "RefreshArtist", status, body: { artistIds: ids } });
const notFound = () => Object.assign(new Error("Not Found"), { response: { status: 404 } });

const client = { get: jest.fn(), delete: jest.fn() };
const service = lidarrService as any;

/**
 * Lidarr holding one artist: its command lists, one per read with the last repeating, and the artists it holds once
 * the artist is deleted.
 */
function lidarr({ artist = ARTIST, commands = [[]], after = [] as unknown[] }: { artist?: typeof ARTIST; commands?: unknown[][]; after?: unknown[] } = {}) {
    let reads = 0;
    let deleted = false;
    client.delete.mockImplementation(async () => {
        deleted = true;
        return { data: {} };
    });
    client.get.mockImplementation(async (url: string) => {
        if (url === "/api/v1/command") return { data: commands[Math.min(reads++, commands.length - 1)] };
        if (url === `/api/v1/artist/${artist.id}`) {
            if (deleted) throw notFound();
            return { data: artist };
        }
        if (url === "/api/v1/artist") return { data: deleted ? after : [artist] };
        throw notFound();
    });
}

beforeEach(() => {
    jest.restoreAllMocks();
    client.get.mockReset();
    client.delete.mockReset();
    jest.spyOn(service, "ensureInitialized").mockResolvedValue(undefined);
    service.enabled = true;
    service.client = client;
    service.invalidateArtistCache();
    service.REFRESH_POLL_MS = 1;
    service.REFRESH_WAIT_LIMIT_MS = 50;
});

it("deletes an artist Lidarr is not refreshing, and counts it once Lidarr no longer has it", async () => {
    lidarr();
    expect(await lidarrService.deleteArtistById(ARTIST.id, false)).toEqual({ success: true, message: "Artist deleted" });
    expect(client.delete).toHaveBeenCalledWith(`/api/v1/artist/${ARTIST.id}`, expect.objectContaining({ params: { deleteFiles: false, addImportListExclusion: false } }));
});

it("waits for Lidarr's refresh of that artist to end before deleting it", async () => {
    let deletedWhileRefreshing = false;
    lidarr({ commands: [[refreshOf([ARTIST.id])], [refreshOf([ARTIST.id])], [refreshOf([ARTIST.id], "completed")]] });
    const del = client.delete.getMockImplementation()!;
    client.delete.mockImplementation(async (...args: unknown[]) => {
        const { data } = await client.get("/api/v1/command");
        deletedWhileRefreshing = (data as { status: string }[]).some((c) => c.status === "started");
        return del(...args);
    });
    expect((await lidarrService.deleteArtistById(ARTIST.id, false)).success).toBe(true);
    expect(deletedWhileRefreshing).toBe(false);
});

it("leaves the artist and says why when Lidarr's refresh of it does not end in time", async () => {
    lidarr({ commands: [[refreshOf([ARTIST.id], "queued")]] });
    const result = await lidarrService.deleteArtistById(ARTIST.id, false);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/still refreshing/i);
    expect(client.delete).not.toHaveBeenCalled();
});

it("is not held up by a refresh of another artist", async () => {
    lidarr({ commands: [[refreshOf([99])]] });
    expect((await lidarrService.deleteArtistById(ARTIST.id, false)).success).toBe(true);
});

it("does not count a delete Lidarr undid by adding the artist back", async () => {
    lidarr({ after: [{ ...ARTIST, id: 14 }] });
    const result = await lidarrService.deleteArtistById(ARTIST.id, false);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/added .*back/i);
});

it("does not count a delete while a refresh that started during it is still running", async () => {
    // None before the delete; one starts during it and never ends. Lidarr does not hold the artist yet, but may soon.
    lidarr({ commands: [[], [refreshOf([ARTIST.id])]] });
    const result = await lidarrService.deleteArtistById(ARTIST.id, false);
    expect(client.delete).toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/may add it back/i);
});

it("counts an artist Lidarr no longer has as removed, without deleting", async () => {
    client.get.mockRejectedValue(notFound());
    expect(await lidarrService.deleteArtistById(ARTIST.id, false)).toEqual({ success: true, message: "Artist already removed" });
    expect(client.delete).not.toHaveBeenCalled();
});

it("counts an artist removed when it is gone by the time Lidarr is asked to delete it", async () => {
    lidarr();
    const del = client.delete.getMockImplementation()!;
    client.delete.mockImplementation(async (...args: unknown[]) => {
        await del(...args); // gone in Lidarr, which answers 404
        throw notFound();
    });
    expect((await lidarrService.deleteArtistById(ARTIST.id, false)).success).toBe(true);
});

it("counts an artist with no MusicBrainz id removed once its delete is done", async () => {
    const noMbid = { ...ARTIST, foreignArtistId: undefined };
    lidarr({ artist: noMbid, after: [{ id: 30, artistName: "Other", tags: [] }] });
    expect((await lidarrService.deleteArtistById(ARTIST.id, false)).success).toBe(true);
});

describe("by MusicBrainz id", () => {
    it("deletes the artist the same way", async () => {
        lidarr();
        expect(await lidarrService.deleteArtist(MBID, true)).toEqual({ success: true, message: "Deleted Lomelda from Lidarr" });
    });

    it("waits for that artist's refresh too", async () => {
        lidarr({ commands: [[refreshOf([ARTIST.id], "queued")]] });
        const result = await lidarrService.deleteArtist(MBID, true);
        expect(result.success).toBe(false);
        expect(result.message).toMatch(/still refreshing/i);
        expect(client.delete).not.toHaveBeenCalled();
    });

    it("deletes the artist Lidarr holds now, not one it held a moment ago", async () => {
        lidarr();
        await lidarrService.getArtists(); // the list now holds id 13
        lidarr({ artist: { ...ARTIST, id: 14 } }); // Lidarr added it back as 14
        expect((await lidarrService.deleteArtist(MBID, true)).success).toBe(true);
        expect(client.delete).toHaveBeenCalledWith("/api/v1/artist/14", expect.anything());
    });

    it("does not take a Lidarr it cannot reach for one without the artist", async () => {
        client.get.mockRejectedValue(new Error("ECONNREFUSED"));
        const result = await lidarrService.deleteArtist(MBID, true);
        expect(result.success).toBe(false);
        expect(result.message).toMatch(/ECONNREFUSED/);
    });

    it("says an artist already gone is already gone", async () => {
        lidarr();
        client.get.mockImplementation(async (url: string) => {
            if (url === "/api/v1/artist") return { data: [ARTIST] };
            throw notFound();
        });
        expect(await lidarrService.deleteArtist(MBID, true)).toEqual({ success: true, message: "Artist already removed" });
    });
});
