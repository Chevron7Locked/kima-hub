/**
 * The enrichment offer's song rule, on the suite database: a song on a library album with its file present is owed
 * a question. A corrupt song stays in (it is offered for a retry), unlike the playable-song rule.
 */

import { prisma } from "../../../utils/db";
import { deleteSeededRows } from "../../../__tests__/helpers/trackStage";
import { ownedSongSql } from "../ownedSong";

const P = "ownsong";

async function seed(): Promise<void> {
    await prisma.artist.create({ data: { id: `${P}_art`, name: "Owned Artist", identityKey: `${P}_a` } });
    for (const [suffix, location] of [["lib", "LIBRARY"], ["dis", "DISCOVER"]] as const) {
        await prisma.album.create({
            data: { id: `${P}_${suffix}`, rgMbid: `${P}_rg_${suffix}`, artistId: `${P}_art`, title: `Album ${suffix}`, primaryType: "Album", identityKey: `${P}_ik_${suffix}`, location },
        });
    }
    const song = (id: string, albumId: string, extra: { missingSince?: Date; corrupt?: boolean } = {}) =>
        prisma.track.create({
            data: {
                id: `${P}_${id}`, albumId: `${P}_${albumId}`, title: id, trackNo: 1, duration: 100,
                filePath: `/music/${P}/${id}.flac`, fileModified: new Date(), fileSize: 1000, ...extra,
            },
        });
    await song("here", "lib");
    await song("corrupt", "lib", { corrupt: true });
    await song("missing", "lib", { missingSince: new Date() });
    await song("discover", "dis");
}

beforeAll(async () => {
    await deleteSeededRows(P);
    await seed();
});
afterAll(() => deleteSeededRows(P));

describe("ownedSongSql", () => {
    it("keeps a library song whose file is there, corrupt ones included, and drops a missing file and a Discover song", async () => {
        const rows = await prisma.$queryRaw<Array<{ id: string }>>`
            SELECT t.id FROM "Track" t WHERE t.id LIKE ${`${P}\\_%`} AND ${ownedSongSql("t")} ORDER BY t.id
        `;
        expect(rows.map((r) => r.id)).toEqual([`${P}_corrupt`, `${P}_here`]);
    });

    it("refuses a name that is not a table name or alias", () => {
        expect(() => ownedSongSql('t"; DROP TABLE "Track"; --')).toThrow(/not a table name or alias/);
    });
});
