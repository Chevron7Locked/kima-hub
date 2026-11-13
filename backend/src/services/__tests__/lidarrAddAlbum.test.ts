/**
 * addAlbum: Discover adds only under an artist it tagged, only the exact MBID,
 * only without files; a library request untags the artist; an untagged artist Kima's records show is Discover's gets
 * its tag back first (that check is tested with the removal module); every request
 * accepts any edition; a search that grabs nothing is explained from Lidarr's
 * release list; a Lidarr outage is reported as one, never as "not found".
 */

import { AcquisitionErrorType, lidarrService } from "../lidarr";
import { ensureDiscoverTag } from "../discovery/lidarrRemoval";

jest.mock("../discovery/lidarrRemoval", () => ({ ensureDiscoverTag: jest.fn() }));
const ensureTag = ensureDiscoverTag as jest.Mock;

const TAG = 22;
const ARTIST_MBID = "artist-mbid";

const artist = (tags: number[]) => ({ id: 5, artistName: "Interpol", foreignArtistId: ARTIST_MBID, tags });
const album = (foreignAlbumId: string, title: string, trackFileCount = 0) => ({
    id: 7, artistId: 5, title, foreignAlbumId, monitored: false, releases: [{ id: 1 }], statistics: { trackFileCount },
});

let catalog: ReturnType<typeof album>[];
let searchMessage: string;
let releases: { rejections: string[] }[];
const client = { get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn() };
const service = lidarrService as any;

beforeEach(() => {
    jest.restoreAllMocks();
    Object.values(client).forEach((fn) => fn.mockReset());
    searchMessage = "Album search completed. 1 reports downloaded.";
    releases = [];
    client.get.mockImplementation(async (url: string) => {
        if (url.startsWith("/api/v1/album?artistId=")) return { data: catalog };
        if (url === "/api/v1/album/7") return { data: catalog[0] };
        if (url.startsWith("/api/v1/command/")) return { data: { status: "completed", message: searchMessage } };
        if (url === "/api/v1/release") return { data: releases };
        return { data: [] };
    });
    client.put.mockImplementation(async (_url: string, body: unknown) => ({ data: body }));
    client.post.mockResolvedValue({ data: { id: 1 } });
    jest.spyOn(service, "ensureInitialized").mockResolvedValue(undefined);
    service.enabled = true;
    service.client = client;
    jest.spyOn(service, "getOrCreateDiscoveryTag").mockResolvedValue(TAG);
    ensureTag.mockReset().mockResolvedValue("not Discover's");
});

const addForDiscover = (rgMbid: string, title: string) =>
    lidarrService.addAlbum(rgMbid, "Interpol", title, "/music", ARTIST_MBID, true);

it("leaves an artist the user already had in Lidarr alone", async () => {
    jest.spyOn(service, "getArtistList").mockResolvedValue([artist([])]);
    catalog = [album("rg-asked", "Antics")];

    expect(await addForDiscover("rg-asked", "Antics")).toBeNull();
    expect(ensureTag).toHaveBeenCalledWith(expect.objectContaining({ id: 5 }), TAG);
    expect(client.put).not.toHaveBeenCalled();
    expect(client.post).not.toHaveBeenCalled();
});

it("adds under an artist whose Discover tag an earlier cleanup took off, once the tag is back", async () => {
    jest.spyOn(service, "getArtistList").mockResolvedValue([artist([])]);
    ensureTag.mockResolvedValue("tagged");
    catalog = [album("rg-asked", "Antics")];

    expect(await addForDiscover("rg-asked", "Antics")).not.toBeNull();
});

it("does not add when Lidarr will not take the tag back", async () => {
    jest.spyOn(service, "getArtistList").mockResolvedValue([artist([])]);
    ensureTag.mockResolvedValue("refused");
    catalog = [album("rg-asked", "Antics")];

    expect(await addForDiscover("rg-asked", "Antics")).toBeNull();
    expect(client.post).not.toHaveBeenCalled();
});

it("does not fetch another edition when the asked MBID is missing", async () => {
    jest.spyOn(service, "getArtistList").mockResolvedValue([artist([TAG])]);
    catalog = [album("rg-live", "Antics (Live)")];

    await expect(addForDiscover("rg-asked", "Antics")).rejects.toMatchObject({
        type: AcquisitionErrorType.ALBUM_NOT_FOUND,
    });
    expect(client.put).not.toHaveBeenCalled();
    expect(client.post).not.toHaveBeenCalled();
});

it("does not take over an album that already has files", async () => {
    jest.spyOn(service, "getArtistList").mockResolvedValue([artist([TAG])]);
    catalog = [album("rg-asked", "Antics", 11)];

    expect(await addForDiscover("rg-asked", "Antics")).toBeNull();
    expect(client.put).not.toHaveBeenCalled();
    expect(client.post).not.toHaveBeenCalled();
});

it("monitors and searches for the album it asked for", async () => {
    jest.spyOn(service, "getArtistList").mockResolvedValue([artist([TAG])]);
    catalog = [album("rg-asked", "Antics")];

    expect(await addForDiscover("rg-asked", "Antics")).not.toBeNull();
    expect(client.post).toHaveBeenCalledWith("/api/v1/command", expect.objectContaining({ name: "AlbumSearch" }));
});

it("lets Lidarr import whichever edition the download matches", async () => {
    jest.spyOn(service, "getArtistList").mockResolvedValue([artist([TAG])]);
    catalog = [album("rg-asked", "Antics")];

    await addForDiscover("rg-asked", "Antics");

    expect(client.put).toHaveBeenCalledWith(
        "/api/v1/album/7",
        expect.objectContaining({ monitored: true, anyReleaseOk: true })
    );
});

it("takes the Discover tag off an artist the user asks for an album by", async () => {
    jest.spyOn(service, "getArtistList").mockResolvedValue([artist([TAG])]);
    const untag = jest.spyOn(service, "removeTagsFromArtist").mockResolvedValue(true);
    catalog = [album("rg-asked", "Antics")];

    await lidarrService.addAlbum("rg-asked", "Interpol", "Antics", "/music", ARTIST_MBID, false);

    expect(untag).toHaveBeenCalledWith(5, [TAG]);
});

it("leaves the Discover tag on for Discover's own requests", async () => {
    jest.spyOn(service, "getArtistList").mockResolvedValue([artist([TAG])]);
    const untag = jest.spyOn(service, "removeTagsFromArtist").mockResolvedValue(true);
    catalog = [album("rg-asked", "Antics")];

    await addForDiscover("rg-asked", "Antics");

    expect(untag).not.toHaveBeenCalled();
});

it("reports an album Lidarr holds in full as owned without searching", async () => {
    jest.spyOn(service, "getArtistList").mockResolvedValue([artist([])]);
    catalog = [{ ...album("rg-asked", "Antics", 11), statistics: { trackFileCount: 11, percentOfTracks: 100 } as any }];

    await expect(
        lidarrService.addAlbum("rg-asked", "Interpol", "Antics", "/music", ARTIST_MBID, false)
    ).rejects.toMatchObject({ type: AcquisitionErrorType.ALREADY_OWNED });
    expect(client.post).not.toHaveBeenCalled();
});

describe("a search that grabs nothing", () => {
    const addForLibrary = () => lidarrService.addAlbum("rg-asked", "Interpol", "Antics", "/music", ARTIST_MBID, false);

    beforeEach(() => {
        jest.spyOn(service, "getArtistList").mockResolvedValue([artist([])]);
        catalog = [album("rg-asked", "Antics")];
    });

    it("treats ten grabs as a started download", async () => {
        searchMessage = "Album search completed. 10 reports downloaded.";

        expect(await addForLibrary()).not.toBeNull();
        expect(client.get).not.toHaveBeenCalledWith("/api/v1/release", expect.anything());
    });

    it("searches once before explaining why nothing was grabbed", async () => {
        searchMessage = "Album search completed. 0 reports downloaded.";

        await expect(addForLibrary()).rejects.toMatchObject({ type: AcquisitionErrorType.NO_RELEASES_AVAILABLE });
        const searches = client.post.mock.calls.filter(([, body]) => body?.name === "AlbumSearch");
        expect(searches).toHaveLength(1);
    });

    it("treats existing-files rejections as availability, not ownership", async () => {
        searchMessage = "Album search completed. 0 reports downloaded.";
        releases = [
            { rejections: ["Existing files meets cutoff: FLAC"] },
            { rejections: ["Existing files on disk is of equal or higher preference: FLAC"] },
        ];

        // Owned means percentOfTracks (checked above), not Lidarr refusing a
        // release because of files belonging to OTHER albums (bundle rejections).
        await expect(addForLibrary()).rejects.toMatchObject({ type: AcquisitionErrorType.NO_RELEASES_AVAILABLE });
    });

    it("names the top rejection reasons when nothing was approved", async () => {
        searchMessage = "Album search completed. 0 reports downloaded.";
        releases = [
            { rejections: ["Existing files meets cutoff: FLAC"] },
            { rejections: ["Release is not in the wanted quality profile"] },
            { rejections: ["Release is not in the wanted quality profile"] },
        ];

        await expect(addForLibrary()).rejects.toMatchObject({
            type: AcquisitionErrorType.NO_RELEASES_AVAILABLE,
            message: expect.stringContaining("3 found, none approved: Release is not in the wanted quality profile (2)"),
        });
    });

    it("reports a dropped connection as Lidarr being unavailable", async () => {
        client.post.mockRejectedValue(Object.assign(new Error("socket hang up"), { isAxiosError: true }));

        await expect(addForLibrary()).rejects.toMatchObject({ type: AcquisitionErrorType.LIDARR_UNAVAILABLE });
    });

    it("passes a Lidarr 400 through unchanged", async () => {
        client.post.mockRejectedValue(Object.assign(new Error("Bad request"), { isAxiosError: true, response: { status: 400 } }));

        await expect(addForLibrary()).rejects.toThrow("Bad request");
    });
});
