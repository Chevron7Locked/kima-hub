/**
 * The cut-offs left in the mix rules, tested against a real Postgres. The mood
 * mixes have none: they draw from their recipes (recipes.integration.test.ts).
 * What remains are the literal mixes' rules: Vocal Detox's instrumental
 * reading, Minor Key Mondays' minor key and felt energy at or above the
 * library's median, and Tempo Flow's steady beat.
 *
 * A constant is only trustworthy if the real query puts a track exactly on the
 * line in and a track just past it out. So for every rule this suite writes a
 * small private pool of real tracks (anchors that pass comfortably, tracks on
 * the line and just inside it, tracks just past it), runs the generator on 60
 * dates, and checks that every track meant to pass shows up at least once and
 * that no other ever does. The numbers are written by hand from the rule's
 * wording, not read from the code. Pools are removed after each rule.
 *
 * The radio route's cut-offs are at the end, called over HTTP with supertest.
 */
import express from "express";
import request from "supertest";
import { prisma } from "../../../utils/db";
import type { ProgrammaticMix } from "../helpers";
import * as mood from "../moodMixes";
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

const COMPLETED: Fields = { analysisStatus: "completed", analysisMode: "enhanced" };
const user = `${PREFIX}user1`;

interface PoolTrack {
    id: string;
    fields: Fields;
}

/** Tracks of one rule: each meant to pass or not. */
interface Member {
    name: string;
    fields: Fields;
    passes: boolean;
}

interface Rule {
    name: string;
    members: Member[];
    /** The generator, called once per date. */
    run: (today: string) => Promise<ProgrammaticMix | null>;
    day?: number;
}

const many = (n: number, name: string, fields: Fields, passes = true): Member[] =>
    Array.from({ length: n }, (_, i) => ({ name: `${name}${i}`, fields, passes }));

const rules: Rule[] = [
    // ---- Vocal Detox: instrumentalness >= .75
    {
        name: "Vocal Detox: instrumental at least 0.75",
        run: (d) => mood.generateVocalDetox(user, d),
        members: [
            ...many(16, "anchor", { ...COMPLETED, instrumentalness: 0.9 }),
            { name: "on", fields: { ...COMPLETED, instrumentalness: 0.75 }, passes: true },
            { name: "inside", fields: { ...COMPLETED, instrumentalness: 0.76 }, passes: true },
            { name: "past", fields: { ...COMPLETED, instrumentalness: 0.74 }, passes: false },
        ],
    },
    // ---- Minor Key Mondays (Monday): minor key AND arousal at or above the library's median arousal. The pool is the
    // library: 35 tracks with arousal, sorted 16 at 0.1, then 0.49, then 0.5, then 17 at 0.9, so the median (the 18th)
    // is 0.5 exactly.
    {
        name: "Minor Key Mondays: minor key, felt energy at or above the library's median",
        day: 1,
        run: (d) => mood.generateMinorKeyMix(user, d),
        members: [
            ...many(16, "anchor", { ...COMPLETED, keyScale: "minor", arousal: 0.9 }),
            ...many(16, "quiet", { ...COMPLETED, keyScale: "major", arousal: 0.1 }, false),
            { name: "onMedian", fields: { ...COMPLETED, keyScale: "minor", arousal: 0.5 }, passes: true },
            { name: "underMedian", fields: { ...COMPLETED, keyScale: "minor", arousal: 0.49 }, passes: false },
            { name: "major", fields: { ...COMPLETED, keyScale: "major", arousal: 0.9 }, passes: false },
            { name: "noArousal", fields: { ...COMPLETED, keyScale: "minor", arousal: null }, passes: false },
            { name: "unfinished", fields: { analysisStatus: "pending", keyScale: "minor", arousal: 0.9 }, passes: false },
        ],
    },
    // ---- Tempo Flow: a tempo on a steady beat, tempo confidence >= 2
    {
        name: "Tempo Flow: steady beat, tempo confidence at least 2",
        run: (d) => mood.generateTempoFlow(user, d),
        members: [
            ...many(7, "slow", { ...COMPLETED, bpm: 80, bpmConfidence: 3 }),
            ...many(9, "medium", { ...COMPLETED, bpm: 115, bpmConfidence: 3 }),
            ...many(7, "fast", { ...COMPLETED, bpm: 145, bpmConfidence: 3 }),
            { name: "on", fields: { ...COMPLETED, bpm: 115, bpmConfidence: 2 }, passes: true },
            { name: "inside", fields: { ...COMPLETED, bpm: 115, bpmConfidence: 2.01 }, passes: true },
            { name: "past", fields: { ...COMPLETED, bpm: 115, bpmConfidence: 1.99 }, passes: false },
            { name: "unknown", fields: { ...COMPLETED, bpm: 115, bpmConfidence: null }, passes: false },
        ],
    },
];

// ---- pool writing ------------------------------------------------------------

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

describe.each(rules.map((r, idx) => ({ ...r, idx })))("$name", (rule) => {
    const tag = `c${rule.idx}`;
    const idOf = (m: Member) => `${PREFIX}${tag}_${m.name}`;
    const union = new Set<string>();
    let nonNull = 0;

    beforeAll(async () => {
        await writeTracks(tag, rule.members.map((m) => ({ id: idOf(m), fields: m.fields })));
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

    it("builds a mix on every call", () => {
        expect(nonNull).toBe(CALLS);
    });

    it("returns every track on the line or inside it at least once", () => {
        expect(rule.members.filter((m) => m.passes && !union.has(idOf(m))).map((m) => m.name)).toEqual([]);
    });

    it("never returns a track past the line", () => {
        expect(rule.members.filter((m) => !m.passes && union.has(idOf(m))).map((m) => m.name)).toEqual([]);
    });
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
