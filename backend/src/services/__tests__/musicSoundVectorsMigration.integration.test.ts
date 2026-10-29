/**
 * Migration 20261017120000: vectors under any label but the music model's ONNX one (the general model's, the
 * single-slice music model's) are removed with their feel and map rows, and their tracks asked again; a track whose
 * file is gone is closed as missing; vectors under the ONNX label stay.
 */
import fs from "fs";
import path from "path";
import { prisma } from "../../utils/db";
import { AXIS_ZERO, insertEmbeddings } from "../../__tests__/helpers/embeddingFixtures";
import { MATCHING_MODEL } from "../matching/state";

const P = "msv";
const SQL = fs.readFileSync(
    path.join(__dirname, "../../../prisma/migrations/20261017120000_music_sound_vectors/migration.sql"),
    "utf8",
);

async function cleanup() {
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE '${P}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id LIKE '${P}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id LIKE '${P}%'`);
}

async function track(id: string, label: string, missing = false) {
    await prisma.track.create({
        data: {
            id, albumId: `${P}alb`, title: id, trackNo: 1, duration: 200, filePath: `/tmp/${id}.flac`,
            fileModified: new Date(), fileSize: 1, vibeAnalysisStatus: "completed",
            ...(missing ? { missingSince: new Date() } : {}),
        },
    });
    await prisma.trackStage.create({ data: { id: `${id}__embedding`, trackId: id, stage: "embedding", status: "done", attempt: 1, retryable: false } });
    await insertEmbeddings([{ trackId: id, vector: AXIS_ZERO }], { model: label });
    await prisma.$executeRawUnsafe(
        `INSERT INTO matching_feel (track_id, embedded_at, probe, valence, arousal)
         SELECT track_id, analyzed_at, 'old-probe', 0.5, 0.5 FROM track_embeddings WHERE track_id = $1`,
        id,
    );
}

async function vectors(id: string) {
    return prisma.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM track_embeddings WHERE track_id = $1`, id);
}

beforeAll(async () => {
    await cleanup();
    await prisma.artist.create({ data: { id: `${P}art`, name: "Music Label Artist", identityKey: `${P}-a` } });
    await prisma.album.create({ data: { id: `${P}alb`, artistId: `${P}art`, rgMbid: `${P}-rg`, title: "Music Label Album", primaryType: "Album" } });
    await track(`${P}general`, "laion-clap-htsat-unfused-v1");
    await track(`${P}slice`, "laion-clap-music-v1");
    await track(`${P}gone`, "laion-clap-htsat-unfused-v1", true);
    await track(`${P}new`, "laion-clap-music-onnx-v1");
    // Statements end at a semicolon closing a line (one sits inside a string literal).
    const statements = SQL.split(/;\s*$/m)
        .map((s) => s.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").trim())
        .filter(Boolean);
    for (const statement of statements) await prisma.$executeRawUnsafe(statement);
});

afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});

async function stage(id: string) {
    return prisma.trackStage.findUniqueOrThrow({ where: { id: `${id}__embedding` } });
}

describe("re-queueing vectors from every model but the music ONNX one", () => {
    it("is the label the backend matches on", () => {
        expect(MATCHING_MODEL).toBe("laion-clap-music-onnx-v1");
    });

    it.each([`${P}general`, `${P}slice`])("removes %s's vector and its feel, and asks the track again", async (id) => {
        expect(await vectors(id)).toHaveLength(0);
        expect(await prisma.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM matching_feel WHERE track_id = $1`, id)).toHaveLength(0);
        expect(await stage(id)).toMatchObject({ status: "pending", retryable: true, attempt: 0 });
        expect((await prisma.track.findUniqueOrThrow({ where: { id } })).vibeAnalysisStatus).toBe("pending");
    });

    it("closes a missing file's record as missing instead of leaving it waiting", async () => {
        expect(await vectors(`${P}gone`)).toHaveLength(0);
        expect(await stage(`${P}gone`)).toMatchObject({ status: "failed", failureClass: "FILE_MISSING", retryable: false });
        expect(await prisma.track.findUniqueOrThrow({ where: { id: `${P}gone` } })).toMatchObject({
            vibeAnalysisStatus: "permanently_failed",
            vibeAnalysisError: "file missing",
        });
    });

    it("leaves vectors from the music ONNX model alone", async () => {
        expect(await vectors(`${P}new`)).toHaveLength(1);
        expect(await stage(`${P}new`)).toMatchObject({ status: "done" });
        expect((await prisma.track.findUniqueOrThrow({ where: { id: `${P}new` } })).vibeAnalysisStatus).toBe("completed");
    });
});
