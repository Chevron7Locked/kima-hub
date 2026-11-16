/**
 * Songs an import knows no album for are looked up in MusicBrainz once per artist and title: a playlist holding the
 * same song twice asks once and files both copies under the album found. MusicBrainz is stood in for; the preview
 * is asked for through the matching part's interface, with Lidarr configured (the lookup is only made for it).
 */
const mockSearchRecording = jest.fn();
jest.mock("../musicbrainz", () => {
    const actual = jest.requireActual("../musicbrainz");
    return {
        ...actual,
        musicBrainzService: {
            ...actual.musicBrainzService,
            searchRecording: (...a: unknown[]) => mockSearchRecording(...a),
            getReleaseGroup: async () => ({ kind: "absent", evidence: {} }),
        },
    };
});

import { previewOfTracklist } from "../playlistImport/matching";
import { tracklistOf } from "../../__tests__/helpers/tracklist";
import { useLidarr, useNoLidarr } from "../../__tests__/helpers/lidarrSettings";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const ARTIST = "zz-unknown-albums-artist";

beforeAll(() => useLidarr("http://lidarr.invalid"));
afterAll(async () => {
    await useNoLidarr();
    await closeEngineConnections();
});
beforeEach(() => mockSearchRecording.mockReset());

const listed = (spotifyId: string, title: string) => ({ spotifyId, title, artist: ARTIST });

it("asks MusicBrainz once per artist and title, and files every copy under the album found", async () => {
    mockSearchRecording.mockImplementation(async ({ title }: { title: string }) => ({
        kind: "answered",
        value: { albumName: `${title} album`, albumMbid: `${title}-rg`, artistMbid: null },
        evidence: {},
    }));

    const preview = await previewOfTracklist(tracklistOf([listed("a", "Sunflower"), listed("b", "Sunflower"), listed("c", "Laser Beam")]));

    expect(mockSearchRecording).toHaveBeenCalledTimes(2);
    const filed = preview.albumsToDownload.map((album) => [album.albumName, album.albumMbid, album.tracksNeeded.map((t) => t.spotifyId)]);
    expect(filed).toEqual([
        ["Sunflower album", "Sunflower-rg", ["a", "b"]],
        ["Laser Beam album", "Laser Beam-rg", ["c"]],
    ]);
});

it("keeps every copy of a song MusicBrainz does not know together, with no album id", async () => {
    mockSearchRecording.mockResolvedValue({ kind: "absent", evidence: {} });

    const preview = await previewOfTracklist(tracklistOf([listed("a", "Nowhere"), listed("b", "Nowhere")]));

    expect(preview.albumsToDownload).toHaveLength(1);
    expect(preview.albumsToDownload[0]).toMatchObject({ albumName: "Unknown Album", albumMbid: null });
    expect(preview.albumsToDownload[0].tracksNeeded.map((t) => t.spotifyId)).toEqual(["a", "b"]);
});
