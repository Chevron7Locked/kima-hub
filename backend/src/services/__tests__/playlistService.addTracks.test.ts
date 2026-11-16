/**
 * addTracks takes in playable songs only: not a Discover song, a missing file or a corrupt one, and not an id that
 * matches no song. Real database, since the rule lives in a Prisma where-clause.
 */

import { prisma } from "../../utils/db";
import { addTracks, lockPlaylist } from "../playlistService";
import { createTrackChain, deleteFixtures } from "./helpers/trackChainFixture";

const PREFIX = "pl-addtracks-test";

function cleanup() {
    return deleteFixtures(PREFIX);
}

async function fixture(location: "LIBRARY" | "DISCOVER", flags: { missingSince?: Date; corrupt?: boolean } = {}) {
    const { tag, track, user } = await createTrackChain(PREFIX, location, { location });
    if (Object.keys(flags).length > 0) await prisma.track.update({ where: { id: track.id }, data: flags });
    const playlist = await prisma.playlist.create({
        data: { userId: user.id, name: `${PREFIX}-${tag}-pl` },
    });
    return { track, playlist };
}

describe("playlistService.addTracks across album locations", () => {
    beforeAll(cleanup);
    afterAll(cleanup);

    it.each([
        ["a DISCOVER album", "DISCOVER", {}],
        ["a missing file", "LIBRARY", { missingSince: new Date() }],
        ["a corrupt file", "LIBRARY", { corrupt: true }],
    ] as const)("rejects a song on %s", async (_name, location, flags) => {
        const { track, playlist } = await fixture(location, flags);

        const result = await addTracks(playlist.id, [track.id]);

        expect(result).toEqual({ added: 0, duplicates: 0, duplicateIds: [], rejected: [track.id] });
        expect(await prisma.playlistItem.count({ where: { playlistId: playlist.id } })).toBe(0);
    });

    it("adds a track from a LIBRARY album", async () => {
        const { track, playlist } = await fixture("LIBRARY");

        const result = await addTracks(playlist.id, [track.id]);

        expect(result).toMatchObject({ added: 1, duplicates: 0, rejected: [] });
    });

    it("rejects an id that matches no song", async () => {
        const { playlist } = await fixture("LIBRARY");

        const result = await addTracks(playlist.id, ["nonexistent-track-id"]);

        expect(result).toMatchObject({
            added: 0,
            duplicates: 0,
            rejected: ["nonexistent-track-id"],
        });
    });

    it("adds a song the playlist already holds only when told to allow repeats", async () => {
        const { track, playlist } = await fixture("LIBRARY");
        await addTracks(playlist.id, [track.id]);

        expect(await addTracks(playlist.id, [track.id])).toEqual({ added: 0, duplicates: 1, duplicateIds: [track.id], rejected: [] });
        expect(await addTracks(playlist.id, [track.id], { allowRepeats: true })).toEqual({ added: 1, duplicates: 0, duplicateIds: [], rejected: [] });
        expect(await prisma.playlistItem.count({ where: { playlistId: playlist.id, trackId: track.id } })).toBe(2);
    });

    it("lists a song deleted while the add waited for the playlist as rejected, not an error", async () => {
        const { track, playlist } = await fixture("LIBRARY");
        const other = await fixture("LIBRARY");

        // Another writer holds the playlist while the add queues behind it, and deletes one of the songs meanwhile.
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        let locked!: () => void;
        const isLocked = new Promise<void>((resolve) => { locked = resolve; });
        const holder = prisma.$transaction(async (tx) => {
            await lockPlaylist(tx, playlist.id);
            locked();
            await held;
            await tx.track.delete({ where: { id: track.id } });
        });
        await isLocked;
        const adding = addTracks(playlist.id, [track.id, other.track.id]);
        await new Promise((resolve) => setTimeout(resolve, 300));
        release();
        await holder;

        await expect(adding).resolves.toMatchObject({ added: 1, rejected: [track.id] });
        expect(await prisma.playlistItem.count({ where: { playlistId: playlist.id } })).toBe(1);
    });
});
