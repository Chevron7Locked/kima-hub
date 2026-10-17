/**
 * Migration 20261017130000: an analysis from an analyzer before v5 (v4 mapped valence and arousal by a clipped
 * stretch), or with no version stored, is asked again; a v5 answer, a missing file and a person's decision are left
 * alone, and the decided track's status column still says completed.
 */
import fs from "fs";
import path from "path";
import { prisma } from "../../utils/db";

const P = "av5";
const SQL = fs.readFileSync(
    path.join(__dirname, "../../../prisma/migrations/20261017130000_analysis_v5/migration.sql"),
    "utf8",
);

async function cleanup() {
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE '${P}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id LIKE '${P}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id LIKE '${P}%'`);
}

async function track(id: string, version: string | null, opts: { missing?: boolean; decided?: boolean } = {}) {
    await prisma.track.create({
        data: {
            id, albumId: `${P}alb`, title: id, trackNo: 1, duration: 200, filePath: `/tmp/${id}.flac`,
            fileModified: new Date(), fileSize: 1, analysisStatus: "completed", analysisVersion: version,
            ...(opts.missing ? { missingSince: new Date() } : {}),
        },
    });
    await prisma.trackStage.create({
        data: {
            id: `${id}__analysis`, trackId: id, stage: "analysis", status: "done", attempt: 1, retryable: true,
            ...(opts.decided ? { decidedAt: new Date(), decidedBy: "admin" } : {}),
        },
    });
}

beforeAll(async () => {
    await cleanup();
    await prisma.artist.create({ data: { id: `${P}art`, name: "V5 Artist", identityKey: `${P}-a` } });
    await prisma.album.create({ data: { id: `${P}alb`, artistId: `${P}art`, rgMbid: `${P}-rg`, title: "V5 Album", primaryType: "Album" } });
    await track(`${P}old`, "2.1b6-enhanced-v4");
    await track(`${P}new`, "2.1b6-enhanced-v5");
    await track(`${P}gone`, "2.1b6-enhanced-v3", { missing: true });
    await track(`${P}decided`, "2.1b6-enhanced-v2", { decided: true });
    await track(`${P}unversioned`, null);
    const statements = SQL.split(/;\s*$/m)
        .map((s) => s.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").trim())
        .filter(Boolean);
    for (const statement of statements) await prisma.$executeRawUnsafe(statement);
});

afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});

const stage = (id: string) => prisma.trackStage.findUniqueOrThrow({ where: { id: `${id}__analysis` } });

describe("asking older analyses again", () => {
    it("reopens an answer with no version stored, and its status column follows", async () => {
        expect(await stage(`${P}unversioned`)).toMatchObject({ status: "pending" });
        expect((await prisma.track.findUniqueOrThrow({ where: { id: `${P}unversioned` } })).analysisStatus).toBe("pending");
    });

    it("leaves a decided track's status column saying completed", async () => {
        expect(await stage(`${P}decided`)).toMatchObject({ status: "done" });
        expect((await prisma.track.findUniqueOrThrow({ where: { id: `${P}decided` } })).analysisStatus).toBe("completed");
    });

    it("reopens an answer from an earlier analyzer version", async () => {
        expect(await stage(`${P}old`)).toMatchObject({ status: "pending" });
        expect((await prisma.track.findUniqueOrThrow({ where: { id: `${P}old` } })).analysisStatus).toBe("pending");
    });

    it("leaves a v5 answer, a missing file and a person's decision alone", async () => {
        expect(await stage(`${P}new`)).toMatchObject({ status: "done" });
        expect(await stage(`${P}gone`)).toMatchObject({ status: "done" });
        expect(await stage(`${P}decided`)).toMatchObject({ status: "done" });
    });
});
