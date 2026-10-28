// A similar artist is matched to the library by the same normalized name the scanner stores, so an
// accented or "&" name is found. On the real database; only the outside artwork lookup is stubbed.

jest.mock("../../../services/artwork", () => ({
    findArtistArtwork: jest.fn().mockResolvedValue(null),
    withAlbumArtwork: jest.fn(),
}));

import { prisma } from "../../../utils/db";
import { normalizeArtistName, artistIdentityKey } from "../../../services/artistIdentity";
import { resolveSimilarArtists } from "../artists";
import { closeEngineConnections } from "../../../__tests__/helpers/engineConnections";

const P = "zz-similar-lib";
const NAMES = ["Sigur Rós", "Hall & Oates", "Björk"];

beforeAll(async () => {
    for (const [i, name] of NAMES.entries()) {
        await prisma.artist.create({
            data: {
                id: `${P}-${i}`,
                name,
                normalizedName: normalizeArtistName(name),
                identityKey: `${P}-${artistIdentityKey(name)}`,
                heroUrl: `native:artists/${P}-${i}.jpg`,
            },
        });
    }
});

afterAll(async () => {
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await closeEngineConnections();
});

it("finds accented and ampersand names in the library, without an mbid", async () => {
    const out = await resolveSimilarArtists(NAMES.map((name) => ({ name, match: 0.5 })));
    expect(out.map((a) => [a.id, a.inLibrary, a.coverArt])).toEqual(
        NAMES.map((_, i) => [`${P}-${i}`, true, `native:artists/${P}-${i}.jpg`]),
    );
});

it("an artist not in the library stays out", async () => {
    const [out] = await resolveSimilarArtists([{ name: "Nobody Here", match: 0.5 }]);
    expect(out.inLibrary).toBe(false);
    expect(out.id).toBe("Nobody Here");
});
