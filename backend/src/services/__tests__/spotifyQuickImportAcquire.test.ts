/**
 * Quick import picks every downloadable album on its own, so it starts downloads like any acquire route (#238).
 * For someone who may not acquire it only matches the playlist against the library. Real database and Redis; the
 * playlist fetch and the import that follows are stubbed, and the albums handed to it are what is checked.
 */
import { prisma } from "../../utils/db";
import { invalidateSystemSettingsCache } from "../../utils/systemSettings";
import { deezerService } from "../deezer";
import { spotifyImportService } from "../spotifyImport";

const MEMBER = "zz-quick-member";
const ADMIN = "zz-quick-admin";
const URL = "https://www.deezer.com/playlist/90210";
const preview = {
    playlist: { id: "90210", name: "Road trip" },
    summary: { total: 2, inLibrary: 0, downloadable: 2 },
    albumsToDownload: [{ albumMbid: "mbid-a", spotifyAlbumId: "sp-a", tracksNeeded: [{}] }],
};

async function albumsHandedOn(userId: string): Promise<string[]> {
    jest.spyOn(deezerService, "getPlaylist").mockResolvedValue({ id: "90210" } as never);
    jest.spyOn(spotifyImportService, "generatePreviewFromDeezer").mockResolvedValue(preview as never);
    jest.spyOn(spotifyImportService as never, "buildPendingTracks").mockReturnValue([] as never);
    const processImport = jest.spyOn(spotifyImportService as never, "processImport").mockResolvedValue(undefined as never);
    const { jobId } = await spotifyImportService.quickImport(URL, userId);
    await spotifyImportService.processQuickImportFromQueue(jobId, URL);
    expect(processImport).toHaveBeenCalledTimes(1);
    return (processImport.mock.calls[0] as unknown[])[1] as string[];
}

beforeAll(async () => {
    for (const [id, role] of [[MEMBER, "user"], [ADMIN, "admin"]] as const) {
        await prisma.user.upsert({ where: { id }, create: { id, username: id, passwordHash: "x", role }, update: { role } });
    }
    await prisma.systemSettings.upsert({ where: { id: "default" }, create: { id: "default", allowMemberAcquire: false }, update: { allowMemberAcquire: false } });
    invalidateSystemSettingsCache();
});

afterEach(() => jest.restoreAllMocks());

afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [MEMBER, ADMIN] } } });
});

it("downloads nothing for a member while member downloads are off, and still imports the playlist", async () => {
    expect(await albumsHandedOn(MEMBER)).toEqual([]);
});

it("downloads every missing album for an admin", async () => {
    expect(await albumsHandedOn(ADMIN)).toEqual(["mbid-a"]);
});
