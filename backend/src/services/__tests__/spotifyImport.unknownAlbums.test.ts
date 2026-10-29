/**
 * Songs an import knows no album for are looked up in MusicBrainz once per artist and title: a playlist holding the
 * same song twice asks once and files both copies under the album found. MusicBrainz is stood in for.
 */
const mockSearchRecording = jest.fn();
jest.mock("../musicbrainz", () => ({
    ...jest.requireActual("../musicbrainz"),
    musicBrainzService: { ...jest.requireActual("../musicbrainz").musicBrainzService, searchRecording: (...a: unknown[]) => mockSearchRecording(...a) },
}));

import { spotifyImportService } from "../spotifyImport";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

afterAll(() => closeEngineConnections());

const track = (spotifyId: string, title: string) => ({
    spotifyId, title, artist: "Low", album: "Unknown Album", albumId: "", durationMs: 200000, artistId: "", isrc: null, trackNumber: 0, previewUrl: null, coverUrl: null,
});

it("asks MusicBrainz once per artist and title, and files every copy", async () => {
    mockSearchRecording.mockImplementation(async ({ title }: { title: string }) => ({
        kind: "answered",
        value: { albumName: `${title} album`, albumMbid: `${title}-rg` },
        evidence: {},
    }));
    const tracks = [track("a", "Sunflower"), track("b", "Sunflower"), track("c", "Laser Beam")];

    const result = await (spotifyImportService as any).enrichUnknownAlbumsViaMusicBrainz(tracks, "[t]");

    expect(mockSearchRecording).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ resolved: 3, failed: 0 });
    expect(tracks.map((t) => [t.album, t.albumId])).toEqual([
        ["Sunflower album", "mbid:Sunflower-rg"],
        ["Sunflower album", "mbid:Sunflower-rg"],
        ["Laser Beam album", "mbid:Laser Beam-rg"],
    ]);
    expect([...result.cached.keys()].sort()).toEqual(["a", "b", "c"]);
});

it("counts every copy of a song MusicBrainz does not know as unknown", async () => {
    mockSearchRecording.mockReset().mockResolvedValue({ kind: "absent", evidence: {} });
    const tracks = [track("a", "Nowhere"), track("b", "Nowhere")];

    const result = await (spotifyImportService as any).enrichUnknownAlbumsViaMusicBrainz(tracks, "[t]");

    expect(mockSearchRecording).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ resolved: 0, failed: 2 });
});
