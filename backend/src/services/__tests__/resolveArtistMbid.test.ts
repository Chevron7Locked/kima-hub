/**
 * resolveArtistMbid only returns an id it can stand behind: the name must match
 * exactly once folded, and when album titles are given the artist's catalogue
 * must hold one of them. Outages pass through untouched.
 */

jest.mock("../../utils/redis", () => ({ redisClient: { get: jest.fn(), setex: jest.fn() } }));
jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

const mockSearchArtist = jest.fn();
const mockGetReleaseGroups = jest.fn();
jest.mock("../musicbrainz", () => ({
    musicBrainzService: {
        searchArtist: (...a: unknown[]) => mockSearchArtist(...a),
        getAllReleaseGroups: (...a: unknown[]) => mockGetReleaseGroups(...a),
    },
}));

import { getArtistCorrection, resolveArtistMbid } from "../artistCorrection";

const answered = (value: unknown) => ({ kind: "answered", value, evidence: {} });
const LOW = { id: "low-mbid", name: "Low" };
const LOW_UK = { id: "low-uk-mbid", name: "Low" };
const LOW_ROAR = { id: "low-roar-mbid", name: "Low Roar" };

beforeEach(() => {
    mockSearchArtist.mockReset();
    mockGetReleaseGroups.mockReset();
});

describe("resolveArtistMbid", () => {
    it("passes an outage through instead of calling it no match", async () => {
        mockSearchArtist.mockResolvedValue({ kind: "transient", evidence: {} });

        const found = await resolveArtistMbid("Low", ["Things We Lost in the Fire"]);

        expect(found.kind).toBe("transient");
    });

    it("rejects a top hit whose name only contains the one asked for", async () => {
        mockSearchArtist.mockResolvedValue(answered([LOW_ROAR]));

        const found = await resolveArtistMbid("Low");

        expect(found.kind).toBe("absent");
    });

    it("accepts a hit by alias", async () => {
        mockSearchArtist.mockResolvedValue(
            answered([{ id: "x", name: "Ye", aliases: [{ name: "Kanye West" }] }])
        );

        const found = await resolveArtistMbid("Kanye West");

        expect(found.kind === "answered" && found.value.mbid).toBe("x");
    });

    it("picks the same-named artist whose catalogue holds the album", async () => {
        mockSearchArtist.mockResolvedValue(answered([LOW_UK, LOW]));
        mockGetReleaseGroups.mockImplementation(async (mbid: string) =>
            answered(
                mbid === LOW.id
                    ? [{ id: "rg", title: "Things We Lost in the Fire" }]
                    : [{ id: "rg2", title: "Something Else" }]
            )
        );

        const found = await resolveArtistMbid("Low", ["Things We Lost In The Fire"]);

        expect(found.kind === "answered" && found.value.mbid).toBe(LOW.id);
    });

    it("stores nothing when no catalogue holds the album", async () => {
        mockSearchArtist.mockResolvedValue(answered([LOW]));
        mockGetReleaseGroups.mockResolvedValue(answered([{ id: "rg", title: "Other" }]));

        const found = await resolveArtistMbid("Low", ["Things We Lost in the Fire"]);

        expect(found.kind).toBe("absent");
    });

    it("refuses to guess between namesakes when only generic titles are known", async () => {
        mockSearchArtist.mockResolvedValue(answered([LOW_UK, LOW]));

        const found = await resolveArtistMbid("Low", ["Unknown Album"]);

        expect(found.kind).toBe("absent");
        expect(mockGetReleaseGroups).not.toHaveBeenCalled();
    });

    it("refuses a shared name for storage when the artist has no albums", async () => {
        mockSearchArtist.mockResolvedValue(answered([LOW_UK, LOW]));

        expect((await resolveArtistMbid("Low", [])).kind).toBe("absent");
    });

    it("takes a unique name for storage when the artist has no albums", async () => {
        mockSearchArtist.mockResolvedValue(answered([LOW, LOW_ROAR]));

        const found = await resolveArtistMbid("Low", []);

        expect(found.kind === "answered" && found.value.mbid).toBe(LOW.id);
    });

    it("passes a catalogue outage through", async () => {
        mockSearchArtist.mockResolvedValue(answered([LOW]));
        mockGetReleaseGroups.mockResolvedValue({ kind: "rateLimited", evidence: {} });

        const found = await resolveArtistMbid("Low", ["Things We Lost in the Fire"]);

        expect(found.kind).toBe("rateLimited");
    });
});

describe("getArtistCorrection", () => {
    it("keeps an exact name even when a longer name containing it ranks first", async () => {
        mockSearchArtist.mockResolvedValue(answered([LOW_ROAR, LOW]));

        expect(await getArtistCorrection("low")).toMatchObject({ corrected: false, canonicalName: "Low", mbid: "low-mbid" });
    });

    it("completes a partial name when nothing matches exactly", async () => {
        mockSearchArtist.mockResolvedValue(answered([{ id: "omam", name: "Of Mice & Men" }]));

        expect(await getArtistCorrection("of mice")).toMatchObject({ corrected: true, canonicalName: "Of Mice & Men" });
    });
});
