/**
 * The migration that drops the DISCOVERY and DISCOVERY_KEPT play labels, run the way an install runs it: a scratch
 * database migrated up to just before it, holding plays under every label, then migrated the rest of the way. Real
 * Postgres; the scratch database is dropped after.
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
const SCRATCH = `kima_listen_labels_${process.pid}`;

const mine = fs.readdirSync(MIGRATIONS).find((name) => name.endsWith("_drop_discover_play_labels"));

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
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "kima-listen-labels-"));
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

const labels = async () =>
    (
        await scratch.$queryRawUnsafe<{ enumlabel: string }[]>(
            `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'ListenSource' ORDER BY e.enumsortorder`,
        )
    ).map((r) => r.enumlabel);

const sources = async () =>
    Object.fromEntries(
        (await scratch.$queryRawUnsafe<{ id: string; source: string }[]>(`SELECT id, source::text AS source FROM "Play" ORDER BY id`)).map((r) => [r.id, r.source]),
    );

it("is a migration of its own", () => {
    expect(mine).toBeDefined();
});

it("rewrites plays under both Discover labels to LIBRARY, leaves the others, and drops both labels", async () => {
    deploy();
    expect(await labels()).toEqual(["LIBRARY", "DISCOVERY", "DISCOVERY_KEPT", "SUBSONIC"]);

    await scratch.user.create({ data: { id: "u1", username: "u1", passwordHash: "x" } });
    await scratch.artist.create({ data: { id: "ar1", name: "A", normalizedName: "a", identityKey: "a" } });
    await scratch.album.create({
        data: { id: "al1", rgMbid: "rg1", artistId: "ar1", identityKey: "al1", title: "T", primaryType: "Album", location: "LIBRARY" },
    });
    await scratch.track.create({
        data: { id: "t1", albumId: "al1", title: "t", trackNo: 1, duration: 100, filePath: "t1.flac", fileModified: new Date(), fileSize: 1 },
    });
    for (const [id, source] of [["p1", "LIBRARY"], ["p2", "DISCOVERY"], ["p3", "DISCOVERY_KEPT"], ["p4", "SUBSONIC"]]) {
        await scratch.$executeRawUnsafe(`INSERT INTO "Play" (id, "userId", "trackId", source) VALUES ('${id}', 'u1', 't1', '${source}')`);
    }

    // The rest of the way: this migration.
    fs.cpSync(path.join(MIGRATIONS, mine!), path.join(workDir, "migrations", mine!), { recursive: true });
    deploy();

    expect(await sources()).toEqual({ p1: "LIBRARY", p2: "LIBRARY", p3: "LIBRARY", p4: "SUBSONIC" });
    expect(await labels()).toEqual(["LIBRARY", "SUBSONIC"]);

    // A play written without a label is still a library play, and the label's index is still there.
    await scratch.$executeRawUnsafe(`INSERT INTO "Play" (id, "userId", "trackId") VALUES ('p5', 'u1', 't1')`);
    expect((await sources()).p5).toBe("LIBRARY");
    const indexes = await scratch.$queryRawUnsafe<{ indexname: string }[]>(`SELECT indexname FROM pg_indexes WHERE tablename = 'Play'`);
    expect(indexes.map((i) => i.indexname)).toContain("Play_source_idx");
    await expect(
        scratch.$executeRawUnsafe(`INSERT INTO "Play" (id, "userId", "trackId", source) VALUES ('p6', 'u1', 't1', 'DISCOVERY')`),
    ).rejects.toThrow();
});
