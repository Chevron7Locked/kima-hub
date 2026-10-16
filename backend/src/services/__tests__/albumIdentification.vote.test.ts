/**
 * The album vote on real AcoustID replies for all 13 songs of Perturbator's "Dangerous Days"
 * (fixtures/acoustid/album-dangerous-days.json): AcoustID lists compilations
 * and soundtracks beside the album; the album most songs agree on, under the album's own title,
 * wins. The tie and title rules use small hand-made answers.
 */

import fs from "fs";
import path from "path";
import { acoustidService } from "../acoustidService";
import { voteAlbumReleaseGroup, type AlbumSongAnswer } from "../albumIdentification";

jest.mock("../../utils/logger", () => ({
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const DANGEROUS_DAYS = "f765fa78-96b2-4a72-b8c7-c1d7eecbae92";

type Recorded = {
    request: { inputs: { file: string; title: string; duration: number }[] };
    replies: { offset: number; reply: { fingerprints: { index: number; results: unknown[] }[] } }[];
};
const recorded: Recorded = JSON.parse(
    fs.readFileSync(path.join(__dirname, "fixtures/acoustid/album-dangerous-days.json"), "utf8"),
);

/** Each song's answer, picked the way identification picks it. */
const songs: AlbumSongAnswer[] = recorded.request.inputs.map((input, i) => {
    const batch = recorded.replies.find((r) => i >= r.offset && i < r.offset + 10)!;
    const results = batch.reply.fingerprints.find((f) => f.index === i - batch.offset)?.results ?? [];
    const picked = (acoustidService as any).pickFingerprintMatch(results, input.duration, input.title);
    return {
        pick: picked
            ? {
                  titleAgrees: picked.titleAgrees,
                  releaseGroups: (picked.recording.releasegroups ?? []).map((g: { id: string; title?: string }) => ({ id: g.id, title: g.title ?? "" })),
              }
            : null,
    };
});

const answer = (titleAgrees: boolean, ...albums: Array<[string, string]>): AlbumSongAnswer => ({
    pick: { titleAgrees, releaseGroups: albums.map(([id, title]) => ({ id, title })) },
});

describe("voteAlbumReleaseGroup on a recorded album", () => {
    it("names the album most of its songs agree on, not the compilations AcoustID lists first", () => {
        const verdict = voteAlbumReleaseGroup("Dangerous Days", songs);

        expect(verdict).toMatchObject({ kind: "assign", releaseGroupId: DANGEROUS_DAYS, title: "Dangerous Days", songs: 13 });
        if (verdict.kind === "assign") expect(verdict.votes * 2).toBeGreaterThan(13);
    });

    it("an edition of the album is the same album", () => {
        expect(voteAlbumReleaseGroup("Dangerous Days (Deluxe Edition)", songs)).toMatchObject({ kind: "assign", releaseGroupId: DANGEROUS_DAYS });
    });

    it("a live album is not the studio album", () => {
        expect(voteAlbumReleaseGroup("Dangerous Days (Live)", songs)).toMatchObject({ kind: "none", reason: "no-agreeing-album" });
    });

    it("too few of the songs known: no verdict", () => {
        const known = songs.filter((s) => s.pick?.titleAgrees).slice(0, 4);
        const unknown = Array.from({ length: 9 }, () => ({ pick: null }));
        expect(voteAlbumReleaseGroup("Dangerous Days", [...known, ...unknown])).toMatchObject({ kind: "none", reason: "short-of-majority" });
    });
});

describe("voteAlbumReleaseGroup rules", () => {
    it("never decides a generic title", () => {
        expect(voteAlbumReleaseGroup("Greatest Hits", [answer(true, ["rg-1", "Greatest Hits"])])).toMatchObject({ reason: "generic-title" });
    });

    it("a pick that matches only by length does not vote", () => {
        expect(voteAlbumReleaseGroup("Album", [answer(false, ["rg-1", "Album"])])).toMatchObject({ reason: "no-agreeing-album" });
    });

    it("a one-song album needs its one song", () => {
        expect(voteAlbumReleaseGroup("Virga", [answer(true, ["rg-1", "Virga"])])).toMatchObject({ kind: "assign", releaseGroupId: "rg-1", votes: 1, songs: 1 });
    });

    it("two albums with the same songs: the one whose title is exactly this album's wins", () => {
        const both = answer(true, ["rg-plain", "Bliss"], ["rg-deluxe", "Bliss (Deluxe Edition)"]);
        expect(voteAlbumReleaseGroup("Bliss", [both, both])).toMatchObject({ kind: "assign", releaseGroupId: "rg-plain" });
    });

    it("two albums the title cannot tell apart: no verdict", () => {
        const both = answer(true, ["rg-a", "Be Mine Tonight"], ["rg-b", "Be Mine Tonight"]);
        expect(voteAlbumReleaseGroup("Be Mine Tonight", [both, both])).toMatchObject({ kind: "none", reason: "tie" });
    });

    it("half the songs is not more than half", () => {
        const yes = answer(true, ["rg-1", "Album"]);
        expect(voteAlbumReleaseGroup("Album", [yes, { pick: null }])).toMatchObject({ reason: "short-of-majority" });
    });
});
