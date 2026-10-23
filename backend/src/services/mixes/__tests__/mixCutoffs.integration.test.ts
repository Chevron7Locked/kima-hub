/**
 * The cut-off numbers inside the mix rules, tested against a real Postgres.
 *
 * Each mix rule says things like "energy at most 0.5". The constant is only
 * trustworthy if the real query puts a track exactly on the line in and a track
 * just past it out. So for every cut-off below this suite writes real tracks
 * into the database:
 *   - "in" tracks: exactly on the cut-off, and one step inside it;
 *   - "out" tracks: one step past it (0.01 for readings, 0.5 for tempo);
 * every other reading is set so the cut-off under test is the only thing that
 * decides. It then runs the generator on 60 dates (or 60 calls for mixes that
 * take no date) and checks that every "in" track shows up at least once and that
 * no "out" track ever does. The cut-off numbers here are written by hand from
 * the rule's wording, not read from the code.
 *
 * Each rule has a small private pool of tracks (about 16 anchor tracks that
 * satisfy the rule comfortably plus the edge tracks), so each generator can
 * return the whole pool across the 60 calls. Pools are removed after each rule.
 *
 * The radio route's cut-offs are at the end, called over HTTP with supertest.
 */
import express from "express";
import request from "supertest";
import { prisma } from "../../../utils/db";
import type { ProgrammaticMix } from "../helpers";
import * as mood from "../moodMixes";
import * as time from "../timeMixes";
import radioRouter from "../../../routes/library/tracks";

jest.setTimeout(600_000);

const PREFIX = "cut_";
const CALLS = 60;
const dates = Array.from({ length: CALLS }, (_, k) => new Date(Date.UTC(2026, 0, 1 + k)).toISOString().slice(0, 10));

const NOT_DATE: any[] = [
    "hrtime", "nextTick", "performance", "queueMicrotask", "requestAnimationFrame", "cancelAnimationFrame",
    "requestIdleCallback", "cancelIdleCallback", "setImmediate", "clearImmediate", "setInterval", "clearInterval",
    "setTimeout", "clearTimeout",
];

/** Run `fn` with the clock's date set to a weekday (0 = Sunday); only Date is faked. */
async function onWeekday<T>(day: number | undefined, fn: () => Promise<T>): Promise<T> {
    if (day === undefined) return fn();
    // 2026-10-18 is a Sunday.
    jest.useFakeTimers({ doNotFake: NOT_DATE, now: Date.UTC(2026, 9, 18 + day, 12) });
    try {
        return await fn();
    } finally {
        jest.useRealTimers();
    }
}

type Fields = Record<string, number | string | string[] | null>;

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

interface Cut {
    name: string;
    /** Readings changed on both the in and the out tracks so only this cut-off decides. */
    set?: Fields;
    ins: Fields[];
    outs: Fields[];
}

/** A cut-off on one reading: `dir` is "lte" (at most) or "gte" (at least). */
function edge(field: string, dir: "lte" | "gte", cut: number, set: Fields = {}, step = field === "bpm" ? 0.5 : 0.01): Cut {
    const sign = dir === "lte" ? -1 : 1;
    return {
        name: `${field} ${dir === "lte" ? "at most" : "at least"} ${cut}`,
        set,
        ins: [{ [field]: cut }, { [field]: r4(cut + sign * step) }],
        outs: [{ [field]: r4(cut - sign * step) }],
    };
}

interface Rule {
    name: string;
    /** Comfortable values that satisfy the rule; the cut tracks start from these. */
    base: Fields;
    /** Anchors differ from `base` when `base` must sit just outside an OR rule. */
    anchor?: Fields;
    cuts: Cut[];
    /** The generator, called once per date. */
    run: (today: string) => Promise<ProgrammaticMix | null>;
    day?: number;
    /** Every track of the pool is a member of this mood bucket (bucket path), or none (fallback path). */
    bucket?: string;
    /** One more out track: fine on every reading but not in the bucket. */
    outsideBucket?: boolean;
    anchors?: number;
}

const COMPLETED: Fields = { analysisStatus: "completed", analysisMode: "enhanced" };
const user = `${PREFIX}user1`;

const rules: Rule[] = [
    // ---- 3AM Thoughts: arousal <= .4 AND energy <= .5 AND bpm <= 110 AND (valence <= .5 OR acousticness >= .3)
    {
        name: "3AM Thoughts",
        base: { ...COMPLETED, arousal: 0.2, energy: 0.3, bpm: 90, valence: 0.3, acousticness: 0.1 },
        run: (d) => mood.generate3AMThoughts(user, d),
        cuts: [
            edge("arousal", "lte", 0.4),
            edge("energy", "lte", 0.5),
            edge("bpm", "lte", 110),
            edge("valence", "lte", 0.5, { acousticness: 0.1 }),
            edge("acousticness", "gte", 0.3, { valence: 0.8 }),
        ],
    },
    // ---- Unhinged: any one extreme (energy >= .85 or <= .15, valence >= .9 or <= .1, bpm >= 160 or <= 70, danceability >= .9)
    {
        name: "Unhinged",
        base: { ...COMPLETED, energy: 0.5, valence: 0.5, bpm: 120, danceability: 0.5 },
        anchor: { ...COMPLETED, energy: 0.97, valence: 0.5, bpm: 120, danceability: 0.5 },
        run: (d) => mood.generateUnhinged(user, d),
        cuts: [
            edge("energy", "gte", 0.85),
            edge("energy", "lte", 0.15),
            edge("valence", "gte", 0.9),
            edge("valence", "lte", 0.1),
            edge("bpm", "gte", 160),
            edge("bpm", "lte", 70),
            edge("danceability", "gte", 0.9),
        ],
    },
    // ---- Chill, bucket path: member of the chill bucket AND energy <= .55
    {
        name: "Chill (bucket path)",
        base: { ...COMPLETED, energy: 0.3 },
        bucket: "chill",
        outsideBucket: true,
        run: (d) => mood.generateChillMix(user, d),
        cuts: [edge("energy", "lte", 0.55)],
    },
    // ---- Chill, fallback: completed AND energy <= .55 AND bpm <= 115 AND (arousal <= .55 OR acousticness >= .3 OR valence <= .65)
    {
        name: "Chill (fallback path)",
        base: { ...COMPLETED, energy: 0.3, bpm: 90, arousal: 0.3, acousticness: 0.1, valence: 0.9 },
        run: (d) => mood.generateChillMix(user, d),
        cuts: [
            edge("energy", "lte", 0.55),
            edge("bpm", "lte", 115),
            edge("arousal", "lte", 0.55),
            edge("acousticness", "gte", 0.3, { arousal: 0.9 }),
            edge("valence", "lte", 0.65, { arousal: 0.9 }),
        ],
    },
    // ---- Late Night, bucket path: chill bucket AND energy <= .5 AND bpm <= 110
    {
        name: "Late Night (bucket path)",
        base: { ...COMPLETED, energy: 0.3, bpm: 90 },
        bucket: "chill",
        outsideBucket: true,
        run: (d) => mood.generateLateNightMix(user, d),
        cuts: [edge("energy", "lte", 0.5), edge("bpm", "lte", 110)],
    },
    // ---- Late Night, fallback: completed AND energy <= .45 AND bpm <= 110 AND (arousal <= .5 OR valence <= .6 OR acousticness >= .3)
    {
        name: "Late Night (fallback path)",
        base: { ...COMPLETED, energy: 0.3, bpm: 90, arousal: 0.3, valence: 0.9, acousticness: 0.1 },
        run: (d) => mood.generateLateNightMix(user, d),
        cuts: [
            edge("energy", "lte", 0.45),
            edge("bpm", "lte", 110),
            edge("arousal", "lte", 0.5),
            edge("valence", "lte", 0.6, { arousal: 0.9 }),
            edge("acousticness", "gte", 0.3, { arousal: 0.9 }),
        ],
    },
    // ---- Melancholy, fallback: completed AND valence <= .35 AND energy <= .6 AND (minor key OR a sad tag)
    {
        name: "Melancholy (fallback path)",
        base: { ...COMPLETED, valence: 0.2, energy: 0.3, keyScale: "minor", moodTags: [] },
        anchors: 15,
        run: (d) => mood.generateMelancholyMix(user, d),
        cuts: [
            edge("valence", "lte", 0.35),
            edge("energy", "lte", 0.6),
            { name: "minor key", set: { moodTags: [] }, ins: [{ keyScale: "minor" }], outs: [{ keyScale: "major" }] },
            {
                name: "sad tag",
                set: { keyScale: "major" },
                ins: [{ moodTags: ["sad"] }, { moodTags: ["melancholic"] }],
                outs: [{ moodTags: ["happy"] }],
            },
        ],
    },
    // ---- Happy, fallback: completed AND valence >= .6 AND energy >= .5
    {
        name: "Happy (fallback path)",
        base: { ...COMPLETED, valence: 0.8, energy: 0.7 },
        run: (d) => mood.generateHappyMix(user, d),
        cuts: [edge("valence", "gte", 0.6), edge("energy", "gte", 0.5)],
    },
    // ---- High Energy: completed AND energy >= .7 AND bpm >= 120
    {
        name: "High Energy",
        base: { ...COMPLETED, energy: 0.9, bpm: 140 },
        run: (d) => mood.generateHighEnergyMix(user, d),
        cuts: [edge("energy", "gte", 0.7), edge("bpm", "gte", 120)],
    },
    // ---- Acoustic: completed AND acousticness >= .6 AND .3 <= energy <= .6
    {
        name: "Acoustic",
        base: { ...COMPLETED, acousticness: 0.8, energy: 0.45 },
        run: (d) => mood.generateAcousticMix(user, d),
        cuts: [edge("acousticness", "gte", 0.6), edge("energy", "gte", 0.3), edge("energy", "lte", 0.6)],
    },
    // ---- Instrumental: completed AND instrumentalness >= .7 AND .3 <= energy <= .6
    {
        name: "Instrumental",
        base: { ...COMPLETED, instrumentalness: 0.85, energy: 0.45 },
        run: (d) => mood.generateInstrumentalMix(user, d),
        cuts: [edge("instrumentalness", "gte", 0.7), edge("energy", "gte", 0.3), edge("energy", "lte", 0.6)],
    },
    // ---- Dance Floor: completed AND danceability >= .7 AND 110 <= bpm <= 140
    {
        name: "Dance Floor",
        base: { ...COMPLETED, danceability: 0.85, bpm: 125 },
        run: (d) => mood.generateDanceFloorMix(user, d),
        cuts: [edge("danceability", "gte", 0.7), edge("bpm", "gte", 110), edge("bpm", "lte", 140)],
    },
    // ---- Sad Girl Sundays (Sunday): (valence <= .35 AND minor key) OR (valence <= .3 AND arousal <= .4)
    {
        name: "Sad Girl Sundays",
        base: { ...COMPLETED, valence: 0.5, keyScale: "major", arousal: 0.9 },
        anchor: { ...COMPLETED, valence: 0.1, keyScale: "minor", arousal: 0.1 },
        day: 0,
        run: (d) => mood.generateSadGirlSundays(user, d),
        cuts: [
            edge("valence", "lte", 0.35, { keyScale: "minor", arousal: 0.9 }),
            { name: "minor key", set: { valence: 0.2, arousal: 0.9 }, ins: [{ keyScale: "minor" }], outs: [{ keyScale: "major" }] },
            edge("valence", "lte", 0.3, { keyScale: "major", arousal: 0.2 }),
            edge("arousal", "lte", 0.4, { keyScale: "major", valence: 0.1 }),
        ],
    },
    // ---- Main Character Energy: valence >= .55 AND energy >= .55 AND danceability >= .5
    {
        name: "Main Character Energy",
        base: { ...COMPLETED, valence: 0.8, energy: 0.8, danceability: 0.8 },
        run: (d) => mood.generateMainCharacterEnergy(user, d),
        cuts: [edge("valence", "gte", 0.55), edge("energy", "gte", 0.55), edge("danceability", "gte", 0.5)],
    },
    // ---- In My Feelings: valence <= .4 AND arousal <= .55 AND acousticness >= .25
    {
        name: "In My Feelings",
        base: { ...COMPLETED, valence: 0.2, arousal: 0.3, acousticness: 0.6 },
        run: (d) => mood.generateInMyFeelings(user, d),
        cuts: [edge("valence", "lte", 0.4), edge("arousal", "lte", 0.55), edge("acousticness", "gte", 0.25)],
    },
    // ---- Romanticize Your Life: .35 <= valence <= .75 AND .25 <= arousal <= .65 AND acousticness >= .25
    {
        name: "Romanticize Your Life",
        base: { ...COMPLETED, valence: 0.55, arousal: 0.45, acousticness: 0.6 },
        run: (d) => mood.generateRomanticizeYourLife(user, d),
        cuts: [
            edge("valence", "gte", 0.35),
            edge("valence", "lte", 0.75),
            edge("arousal", "gte", 0.25),
            edge("arousal", "lte", 0.65),
            edge("acousticness", "gte", 0.25),
        ],
    },
    // ---- Golden Hour: valence >= .45 AND acousticness >= .35 AND .25 <= energy <= .65
    {
        name: "Golden Hour",
        base: { ...COMPLETED, valence: 0.7, acousticness: 0.6, energy: 0.45 },
        run: (d) => mood.generateGoldenHour(user, d),
        cuts: [edge("valence", "gte", 0.45), edge("acousticness", "gte", 0.35), edge("energy", "gte", 0.25), edge("energy", "lte", 0.65)],
    },
    // ---- Day mixes
    {
        name: "Sunday Morning (day mix)",
        base: { ...COMPLETED, energy: 0.3, acousticness: 0.8 },
        day: 0,
        run: () => time.generateDayMix(user),
        cuts: [edge("energy", "lte", 0.5), edge("acousticness", "gte", 0.5)],
    },
    {
        name: "Monday Motivation (day mix)",
        base: { ...COMPLETED, energy: 0.8, valence: 0.8 },
        day: 1,
        run: () => time.generateDayMix(user),
        cuts: [edge("energy", "gte", 0.6), edge("valence", "gte", 0.5)],
    },
    {
        name: "Friday Night (day mix)",
        base: { ...COMPLETED, danceability: 0.85, energy: 0.8 },
        day: 5,
        run: () => time.generateDayMix(user),
        cuts: [edge("danceability", "gte", 0.7), edge("energy", "gte", 0.6)],
    },
];

// ---- pool writing ------------------------------------------------------------

interface PoolTrack {
    id: string;
    fields: Fields;
}

async function ensureAlbum() {
    await prisma.artist.create({
        data: { id: `${PREFIX}art`, name: "Cut-off Artist", normalizedName: "cut-off artist", identityKey: `${PREFIX}ak` },
    });
    await prisma.album.create({
        data: {
            id: `${PREFIX}alb`, rgMbid: `${PREFIX}rg`, artistId: `${PREFIX}art`, identityKey: `${PREFIX}ik`,
            title: "Cut-off Album", primaryType: "Album", year: 2000, location: "LIBRARY",
        },
    });
}

async function writeTracks(tag: string, tracks: PoolTrack[], albumId = `${PREFIX}alb`) {
    await prisma.track.createMany({
        data: tracks.map((t, i) => ({
            id: t.id,
            albumId,
            title: `Cut-off ${tag} ${i}`,
            trackNo: i + 1,
            duration: 200,
            filePath: `/tmp/${t.id}.flac`,
            fileModified: new Date(),
            fileSize: 1000,
            ...(t.fields as any),
        })),
    });
}

async function clearAll() {
    await prisma.track.deleteMany({ where: { id: { startsWith: PREFIX } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: PREFIX } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: PREFIX } } });
    await prisma.user.deleteMany({ where: { id: { startsWith: PREFIX } } });
}

beforeAll(async () => {
    await clearAll();
    await prisma.user.create({ data: { id: user, username: user, passwordHash: "x" } });
    await ensureAlbum();
});

afterAll(async () => {
    await clearAll();
    await prisma.$disconnect();
});

describe.each(rules.map((r, idx) => ({ ...r, idx })))("cut-offs of $name", (rule) => {
    const tag = `c${rule.idx}`;
    const anchorIds: string[] = [];
    const inIds = new Map<string, string[]>();
    const outIds = new Map<string, string[]>();
    const union = new Set<string>();
    let nonNull = 0;
    let outsideBucketId: string | null = null;

    beforeAll(async () => {
        const pool: PoolTrack[] = [];
        for (let a = 0; a < (rule.anchors ?? 16); a++) {
            const id = `${PREFIX}${tag}_anchor${a}`;
            anchorIds.push(id);
            pool.push({ id, fields: { ...(rule.anchor ?? rule.base) } });
        }
        rule.cuts.forEach((cut, c) => {
            const mk = (kind: "in" | "out", list: Fields[], into: Map<string, string[]>) => {
                const ids: string[] = [];
                list.forEach((v, i) => {
                    const id = `${PREFIX}${tag}_${c}_${kind}${i}`;
                    ids.push(id);
                    pool.push({ id, fields: { ...rule.base, ...(cut.set ?? {}), ...v } });
                });
                into.set(cut.name + "#" + c, ids);
            };
            mk("in", cut.ins, inIds);
            mk("out", cut.outs, outIds);
        });
        if (rule.outsideBucket) {
            outsideBucketId = `${PREFIX}${tag}_nobucket`;
            pool.push({ id: outsideBucketId, fields: { ...(rule.anchor ?? rule.base) } });
        }
        await writeTracks(tag, pool);
        if (rule.bucket) {
            await prisma.moodBucket.createMany({
                data: pool.filter((p) => p.id !== outsideBucketId).map((p) => ({ trackId: p.id, mood: rule.bucket!, score: 0.5 })),
            });
        }
        for (const d of dates) {
            const mix = await onWeekday(rule.day, () => rule.run(d));
            if (mix) {
                nonNull++;
                mix.trackIds.forEach((id) => union.add(id));
            }
        }
    });

    afterAll(async () => {
        await prisma.track.deleteMany({ where: { id: { startsWith: `${PREFIX}${tag}_` } } });
    });

    it("builds a mix on every call (the pool is large enough and the right path is taken)", () => {
        expect(nonNull).toBe(CALLS);
    });

    it("reaches the anchor tracks", () => {
        expect(anchorIds.filter((id) => union.has(id)).length).toBeGreaterThanOrEqual(Math.min(anchorIds.length, 10));
    });

    // One test per cut-off.
    for (let c = 0; c < rule.cuts.length; c++) {
        const cut = rule.cuts[c];
        it(`${cut.name}: tracks on the line and just inside appear, tracks just past it never do`, () => {
            const ins = inIds.get(cut.name + "#" + c)!;
            const outs = outIds.get(cut.name + "#" + c)!;
            expect(ins.filter((id) => !union.has(id))).toEqual([]);
            expect(outs.filter((id) => union.has(id))).toEqual([]);
        });
    }

    if (rule.outsideBucket) {
        it("a track that fits every reading but is not in the mood bucket never appears", () => {
            expect(union.has(outsideBucketId!)).toBe(false);
        });
    }
});

// ---- radio cut-offs ------------------------------------------------------------

const app = express();
app.use(express.json());
app.use("/", radioRouter);

interface RadioRule {
    name: string;
    query: Record<string, string | number>;
    base: Fields;
    cuts: Cut[];
}

const radioRules: RadioRule[] = [
    { name: "mood acoustic: acousticness >= .6", query: { type: "mood", value: "acoustic" },
      base: { ...COMPLETED, acousticness: 0.8 }, cuts: [edge("acousticness", "gte", 0.6)] },
    { name: "mood instrumental: instrumentalness >= .7", query: { type: "mood", value: "instrumental" },
      base: { ...COMPLETED, instrumentalness: 0.85 }, cuts: [edge("instrumentalness", "gte", 0.7)] },
    { name: "mood high-energy: energy >= .7 and bpm >= 120", query: { type: "mood", value: "high-energy" },
      base: { ...COMPLETED, energy: 0.9, bpm: 140 }, cuts: [edge("energy", "gte", 0.7), edge("bpm", "gte", 120)] },
    { name: "workout: (energy >= .65 and bpm >= 115) or a workout tag", query: { type: "workout" },
      base: { ...COMPLETED, energy: 0.9, bpm: 140, moodTags: [] },
      cuts: [
          edge("energy", "gte", 0.65),
          edge("bpm", "gte", 115),
          { name: "workout tag", set: { energy: 0.2, bpm: 80 },
            ins: [{ moodTags: ["workout"] }, { moodTags: ["energetic"] }, { moodTags: ["upbeat"] }],
            outs: [{ moodTags: ["calm"] }] },
      ] },
];

describe.each(radioRules.map((r, idx) => ({ ...r, idx })))("radio cut-offs: $name", (rule) => {
    const tag = `r${rule.idx}`;
    const ins: string[] = [];
    const outs: string[] = [];
    const anchors: string[] = [];
    let returned = new Set<string>();

    beforeAll(async () => {
        const pool: PoolTrack[] = [];
        for (let a = 0; a < 5; a++) {
            const id = `${PREFIX}${tag}_anchor${a}`;
            anchors.push(id);
            pool.push({ id, fields: { ...rule.base } });
        }
        rule.cuts.forEach((cut, c) => {
            cut.ins.forEach((v, i) => {
                const id = `${PREFIX}${tag}_${c}_in${i}`;
                ins.push(id);
                pool.push({ id, fields: { ...rule.base, ...(cut.set ?? {}), ...v } });
            });
            cut.outs.forEach((v, i) => {
                const id = `${PREFIX}${tag}_${c}_out${i}`;
                outs.push(id);
                pool.push({ id, fields: { ...rule.base, ...(cut.set ?? {}), ...v } });
            });
        });
        await writeTracks(tag, pool);
        // The pool is under the limit, so each call returns every matching track.
        returned = new Set();
        for (let k = 0; k < 5; k++) {
            const res = await request(app).get("/radio").query({ ...rule.query, limit: 100 });
            expect(res.status).toBe(200);
            for (const t of res.body.tracks) returned.add(t.id);
        }
    });

    afterAll(async () => {
        await prisma.track.deleteMany({ where: { id: { startsWith: `${PREFIX}${tag}_` } } });
    });

    it("returns the anchors and every track on the line or just inside it", () => {
        expect(anchors.filter((id) => !returned.has(id))).toEqual([]);
        expect(ins.filter((id) => !returned.has(id))).toEqual([]);
    });

    it("never returns a track just past a cut-off", () => {
        expect(outs.filter((id) => returned.has(id))).toEqual([]);
    });
});

describe("radio cut-offs: decade", () => {
    // Decade 1990 means original year 1990-1999; with no original year the album year decides.
    const albums = [
        { n: "y1990", year: 1990, originalYear: null, inside: true },
        { n: "y1999", year: 1999, originalYear: null, inside: true },
        { n: "y1989", year: 1989, originalYear: null, inside: false },
        { n: "y2000", year: 2000, originalYear: null, inside: false },
        { n: "orig95_year05", year: 2005, originalYear: 1995, inside: true },
        { n: "orig05_year95", year: 1995, originalYear: 2005, inside: false },
    ];
    const returned = new Set<string>();

    beforeAll(async () => {
        for (const a of albums) {
            await prisma.album.create({
                data: {
                    id: `${PREFIX}dec_${a.n}`, rgMbid: `${PREFIX}dec_rg_${a.n}`, artistId: `${PREFIX}art`,
                    identityKey: `${PREFIX}dec_ik_${a.n}`, title: a.n, primaryType: "Album",
                    year: a.year, originalYear: a.originalYear, location: "LIBRARY",
                },
            });
            await writeTracks(a.n, [{ id: `${PREFIX}dec_${a.n}_t`, fields: { ...COMPLETED } }], `${PREFIX}dec_${a.n}`);
        }
        for (let k = 0; k < 3; k++) {
            const res = await request(app).get("/radio").query({ type: "decade", value: 1990, limit: 100 });
            expect(res.status).toBe(200);
            for (const t of res.body.tracks) returned.add(t.id);
        }
    });

    afterAll(async () => {
        await prisma.track.deleteMany({ where: { id: { startsWith: `${PREFIX}dec_` } } });
        await prisma.album.deleteMany({ where: { id: { startsWith: `${PREFIX}dec_` } } });
    });

    it.each(albums)("album $n (year $year, original $originalYear): inside is $inside", (a) => {
        expect(returned.has(`${PREFIX}dec_${a.n}_t`)).toBe(a.inside);
    });
});
