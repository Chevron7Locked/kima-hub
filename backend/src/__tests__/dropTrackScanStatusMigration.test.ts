/**
 * The migration that drops the dead scan columns from Track (scanStatus, scanError, scanStartedAt) and the indexes on
 * them, run the way an install runs it: a scratch database migrated up to just before it, holding tracks, then migrated
 * the rest of the way. Real Postgres; the scratch database is dropped after.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { PrismaClient } from "@prisma/client";

const { adminDatabaseUrl } = require("../__mocks__/test-worker-db.cjs") as { adminDatabaseUrl: (url: string) => string };

jest.setTimeout(240_000);

const BACKEND = path.resolve(__dirname, "../..");
const MIGRATIONS = path.join(BACKEND, "prisma/migrations");
const SCRATCH = `kima_scan_status_${process.pid}`;

const mine = fs.readdirSync(MIGRATIONS).find((name) => name.endsWith("_drop_track_scan_status"));

let workDir: string;
let scratchUrl: string;
let admin: PrismaClient;
let scratch: PrismaClient;

function deploy() {
    execFileSync("npx", ["prisma", "migrate", "deploy", "--schema", path.join(workDir, "schema.prisma")], {
        cwd: BACKEND,
        env: { ...process.env, DATABASE_URL: scratchUrl },
        stdio: "pipe",
    });
}

beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${SCRATCH}`;
    scratchUrl = url.toString();
    admin = new PrismaClient({ datasources: { db: { url: adminDatabaseUrl(process.env.DATABASE_URL!) } } });
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${SCRATCH}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${SCRATCH}" ENCODING 'SQL_ASCII' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`);

    // The schema and every migration except this one.
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "kima-scan-status-"));
    fs.copyFileSync(path.join(BACKEND, "prisma/schema.prisma"), path.join(workDir, "schema.prisma"));
    fs.mkdirSync(path.join(workDir, "migrations"));
    fs.copyFileSync(path.join(MIGRATIONS, "migration_lock.toml"), path.join(workDir, "migrations/migration_lock.toml"));
    for (const entry of fs.readdirSync(MIGRATIONS, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === mine) continue;
        fs.cpSync(path.join(MIGRATIONS, entry.name), path.join(workDir, "migrations", entry.name), { recursive: true });
    }
    scratch = new PrismaClient({ datasources: { db: { url: scratchUrl } } });
});

afterAll(async () => {
    await scratch?.$disconnect();
    await admin?.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${SCRATCH}" WITH (FORCE)`);
    await admin?.$disconnect();
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
});

const scanColumns = async () =>
    (
        await scratch.$queryRawUnsafe<{ column_name: string }[]>(
            `SELECT column_name FROM information_schema.columns WHERE table_name = 'Track' AND column_name LIKE 'scan%' ORDER BY column_name`,
        )
    ).map((r) => r.column_name);

const scanIndexes = async () =>
    (
        await scratch.$queryRawUnsafe<{ indexname: string }[]>(
            `SELECT indexname FROM pg_indexes WHERE tablename = 'Track' AND (indexname ILIKE '%scan%' OR indexdef ILIKE '%scanStatus%') ORDER BY indexname`,
        )
    ).map((r) => r.indexname);

it("is a migration of its own", () => {
    expect(mine).toBeDefined();
});

it("drops the scan columns and every index on them, and leaves the tracks and their other indexes", async () => {
    deploy();
    expect(await scanColumns()).toEqual(["scanError", "scanStartedAt", "scanStatus"]);
    expect(await scanIndexes()).toEqual(expect.arrayContaining(["Track_scanStatus_idx", "Track_scan_pending_idx"]));

    await scratch.artist.create({ data: { id: "ar1", name: "A", normalizedName: "a", identityKey: "a" } });
    await scratch.album.create({
        data: { id: "al1", rgMbid: "rg1", artistId: "ar1", identityKey: "al1", title: "T", primaryType: "Album", location: "LIBRARY" },
    });
    await scratch.track.create({
        data: { id: "t1", albumId: "al1", title: "t", trackNo: 1, duration: 100, filePath: "t1.flac", fileModified: new Date(), fileSize: 1 },
    });

    // The rest of the way: this migration.
    fs.cpSync(path.join(MIGRATIONS, mine!), path.join(workDir, "migrations", mine!), { recursive: true });
    deploy();

    expect(await scanColumns()).toEqual([]);
    expect(await scanIndexes()).toEqual([]);
    expect(await scratch.track.count()).toBe(1);
    const indexes = await scratch.$queryRawUnsafe<{ indexname: string }[]>(`SELECT indexname FROM pg_indexes WHERE tablename = 'Track'`);
    expect(indexes.map((i) => i.indexname)).toContain("Track_analysisStatus_idx");
});
