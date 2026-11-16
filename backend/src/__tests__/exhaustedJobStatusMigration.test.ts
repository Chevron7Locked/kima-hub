/**
 * The migration that turns download jobs left in the old "exhausted" status into "failed", the status a job that ran out
 * of attempts is written with. Run the way an install runs it: a scratch database migrated up to just before it,
 * holding jobs under each status, then migrated the rest of the way. Real Postgres; the scratch database is dropped
 * after.
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
const SCRATCH = `kima_exhausted_jobs_${process.pid}`;

const mine = fs.readdirSync(MIGRATIONS).find((name) => name.endsWith("_download_job_exhausted_is_failed"));

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
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "kima-exhausted-jobs-"));
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

const statuses = async () =>
    Object.fromEntries(
        (await scratch.$queryRawUnsafe<{ id: string; status: string }[]>(`SELECT id, status FROM "DownloadJob" ORDER BY id`)).map((r) => [r.id, r.status]),
    );

it("is a migration of its own", () => {
    expect(mine).toBeDefined();
});

it("turns every exhausted job into a failed one and leaves the other statuses alone", async () => {
    deploy();
    await scratch.user.create({ data: { id: "u1", username: "u1", passwordHash: "x" } });
    for (const [id, status] of [["j1", "pending"], ["j2", "processing"], ["j3", "completed"], ["j4", "failed"], ["j5", "exhausted"]]) {
        await scratch.$executeRawUnsafe(
            `INSERT INTO "DownloadJob" (id, "userId", subject, type, "targetMbid", status, "updatedAt") VALUES ('${id}', 'u1', 's${id}', 'album', 'mbid-${id}', '${status}', now())`,
        );
    }

    // The rest of the way: this migration.
    fs.cpSync(path.join(MIGRATIONS, mine!), path.join(workDir, "migrations", mine!), { recursive: true });
    deploy();

    expect(await statuses()).toEqual({ j1: "pending", j2: "processing", j3: "completed", j4: "failed", j5: "failed" });
});
