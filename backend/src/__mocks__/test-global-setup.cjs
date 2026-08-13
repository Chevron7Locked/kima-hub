/**
 * Jest `globalSetup` -- runs ONCE, in its own process, before any test file
 * or worker starts (Jest never loads `setupFiles`/test-env.cjs into this
 * process, so the env-var fallback has to be resolved here too).
 *
 * WHY THIS FILE PROVISIONS A SEPARATE DATABASE PER WORKER, NOT JUST A SHARED
 * ONE WITH SCOPED FIXTURES: this looks like it could be over-engineering --
 * every test file already prefix-scopes its own rows (`itest_`, `ihttp_
 * {filePrefix}_`, etc.) and cleans up after itself. That WAS enough for a
 * while, and if you're reading this wondering why a whole database-per-
 * worker scheme exists on top of it, here's the concrete failure it exists
 * to close, not a defensive guess:
 *
 * Two specific test files (`socialRoomsN16N19N20.route.test.ts` and
 * `socialRooms.route.test.ts`), run together under Jest's default PARALLEL
 * workers sharing one Postgres database, failed on foreign-key violations --
 * a `RoomMember`/`Play` row rejected because its `Room`/`User` parent
 * "didn't exist", moments after that SAME parent had been used successfully
 * in a PRIOR insert on the SAME Postgres backend connection, same PID
 * throughout, confirmed via `ALTER SYSTEM SET log_statement='all'` and
 * reading the raw statement log. No file's fixtures were unscoped -- both
 * wipe()s were correctly prefix-filtered, confirmed by reading every DELETE
 * in the captured window. The SAME two files, run with `--maxWorkers=1`
 * (still sharing one database, just sequential), were 100% clean, every
 * time. Capping the per-client connection pool (`DATABASE_POOL_SIZE`, down
 * to 1 -- ruling out "wrong connection within one client's own pool"
 * entirely) did NOT fix it either, so this was not simple connection-count
 * exhaustion against Postgres's `max_connections`, even though that IS a
 * real, separate concern on a big box (Jest's default `maxWorkers` is
 * `cpus-1`, and `utils/db.ts`'s per-client pool default is 20 -- the two
 * multiply past 100 on anything bigger than ~5 cores). Twenty-six total
 * `npm test` runs across two people settled it empirically: ~24 clean with
 * this file's isolation in place, 2/4/3 failures immediately after removing
 * it and reverting to a shared database, and back to clean on restoring it.
 *
 * The underlying Postgres/Prisma mechanism for the FK anomaly itself is
 * UNEXPLAINED. This file does not need to explain it to be correct: two test
 * files in physically separate databases cannot interact through the
 * database AT ALL, regardless of what was causing the interaction. If you
 * find the real mechanism later and it turns out to be fixable some cheaper
 * way, great -- but until then, do not delete this as unnecessary complexity
 * without either reproducing the two-file failure under a shared database
 * first, or reading the fuller trace this comment summarizes.
 *
 * Three jobs, now that the why is on record:
 * 1. Bootstrap the vibe schema (vibe-schema.cjs) on the BASE database, so
 *    every integration test that reads `vibe.*` tables can rely on them
 *    existing -- unchanged from before per-worker isolation.
 * 2. Provision one database per Jest worker (`<base>_w<id>`, `1..maxWorkers`),
 *    so two test files scheduled onto DIFFERENT workers physically cannot
 *    see each other's rows -- see test-worker-db.cjs's own comment too.
 *    `test-env.cjs` is what points each worker AT its own database; this is
 *    what makes that database exist and be current.
 * 3. Wipe every worker's database back to zero rows, every run, whether it
 *    was just created or reused from a past run -- see the reuse comment
 *    below for why a database persisting across RUNS still has to start
 *    each run empty.
 *
 * `globalConfig.maxWorkers` (Jest passes this in) is the ACTUAL resolved
 * worker count for THIS run -- confirmed empirically to equal 1 under
 * `--runInBand`, and to equal every `JEST_WORKER_ID` a real multi-file run
 * actually uses, no gaps, no values above it, regardless of machine core
 * count or an explicit `--maxWorkers=N`. Nothing here hardcodes a number --
 * a slower/smaller CI runner, or a developer capping workers by hand, both
 * just provision fewer databases, automatically.
 *
 * Per-worker DDL (existence + freshness) stays SEQUENTIAL through one shared
 * admin connection -- concurrent CREATE/DROP DATABASE from one client isn't
 * something to gamble on being safe. The per-worker CONNECT-heavy steps
 * (freshness probes, the wipe) run CONCURRENTLY across workers instead:
 * measured on a 27-worker box (28 physical cores, Jest's own default
 * `maxWorkers`), a first version of this file that did every worker's
 * freshness probe AND wipe as its own fully sequential connect cost ~4.6s of
 * a ~4.9s total; batching the existence check into one query and running
 * the probes/wipes concurrently cut that to ~1.8s total (cold or warm --
 * dominated by connection count, not by whether a clone/drop happened).
 * That's a real, measured cost, not a guess -- a much bigger box than the
 * one this was measured on, or a `--maxWorkers` override, changes it in
 * proportion to worker count, not necessarily to zero.
 *
 * If there's no reachable Postgres, this throws and Jest aborts the whole
 * run immediately with that error -- the correct behavior: these tests must
 * not be able to silently proceed without a real database.
 */
const { DATABASE_URL_FALLBACK } = require('./test-db-defaults.cjs');
const { ensureVibeSchema } = require('./vibe-schema.cjs');
const { databaseNameOf, workerDatabaseName, workerDatabaseUrl, adminDatabaseUrl } = require('./test-worker-db.cjs');

/** The most recently applied migration's name, or null on a database with no `_prisma_migrations` table yet. */
async function latestMigration(client) {
    try {
        const rows =
            await client.$queryRaw`SELECT migration_name FROM _prisma_migrations ORDER BY finished_at DESC NULLS LAST LIMIT 1`;
        return rows[0]?.migration_name ?? null;
    } catch {
        return null;
    }
}

/**
 * Every row, in every table, in both schemas a test could write to -- built
 * dynamically off `pg_tables` rather than an enumerated list, so a new
 * Prisma model or a new vibe table is covered automatically, the same
 * reason `ensureVibeSchema` and every batched primitive in this track's own
 * code prefers "compute the set" over "hand-maintain the set". One combined
 * `TRUNCATE a, b, c ... CASCADE` rather than one statement per table --
 * cheaper, and CASCADE is required regardless given the FK graph between
 * these tables. `_prisma_migrations` is excluded on purpose: wiping it would
 * make every worker database look un-migrated to Prisma and to this file's
 * own `latestMigration` check on the NEXT run.
 */
async function wipeAllRows(client) {
    await client.$executeRawUnsafe(`
        DO $$
        DECLARE tbls text;
        BEGIN
            SELECT string_agg(format('%I.%I', schemaname, tablename), ', ')
              INTO tbls
              FROM pg_tables
             WHERE schemaname IN ('public', 'vibe') AND tablename <> '_prisma_migrations';
            IF tbls IS NOT NULL THEN
                EXECUTE 'TRUNCATE TABLE ' || tbls || ' CASCADE';
            END IF;
        END $$;
    `);
}

/** Connect to `url`, run `fn`, always disconnect -- the shape every per-worker probe/wipe below shares. */
async function withClient(PrismaClient, url, fn) {
    const client = new PrismaClient({ datasources: { db: { url } } });
    try {
        return await fn(client);
    } finally {
        await client.$disconnect();
    }
}

module.exports = async function globalSetup(globalConfig) {
    process.env.DATABASE_URL ??= DATABASE_URL_FALLBACK;
    const baseUrl = process.env.DATABASE_URL;

    // Required so late so @prisma/client reads the DATABASE_URL set above --
    // requiring it any earlier would read process.env before the fallback runs.
    const { PrismaClient } = require('@prisma/client');

    // Job 1: the base/template database. Also now the TEMPLATE every
    // worker's own database is cloned from below, so it has to be fully
    // ready -- migrated (a prior, separate step: CI's own `prisma migrate
    // deploy`, or a developer's `npm run db:migrate`) and vibe-schema-
    // bootstrapped -- before any clone happens.
    const base = new PrismaClient();
    let targetMigration;
    try {
        await base.$queryRaw`SELECT 1`; // fail loudly without a real DB
        await ensureVibeSchema(base);
        targetMigration = await latestMigration(base);
    } finally {
        await base.$disconnect(); // Postgres refuses to CREATE DATABASE ... TEMPLATE while anything is connected to the template, including this process
    }

    const baseDbName = databaseNameOf(baseUrl);
    const workerIds = Array.from({ length: globalConfig.maxWorkers }, (_, i) => i + 1);
    const admin = new PrismaClient({ datasources: { db: { url: adminDatabaseUrl(baseUrl) } } });
    try {
        // One query for every worker's existence, not one query PER worker.
        const allDbs = await admin.$queryRaw`SELECT datname FROM pg_database`;
        const existingNames = new Set(allDbs.map((r) => r.datname));

        // Freshness probes run CONCURRENTLY -- independent reads against
        // independent databases, nothing here shares a connection or
        // mutates anything, so there's no ordering reason to serialize them.
        const freshness = await Promise.all(
            workerIds.map(async (workerId) => {
                const dbName = workerDatabaseName(baseUrl, workerId);
                if (!existingNames.has(dbName)) return { workerId, dbName, needsCreate: true, stale: false };
                const theirMigration = await withClient(PrismaClient, workerDatabaseUrl(baseUrl, workerId), latestMigration);
                return { workerId, dbName, needsCreate: false, stale: theirMigration !== targetMigration };
            }),
        );

        // CREATE/DROP DATABASE stay sequential through the one shared admin
        // connection -- see the file-level comment on why concurrent DDL
        // from one client isn't worth gambling on.
        for (const { dbName, needsCreate, stale } of freshness) {
            if (needsCreate) {
                await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}" TEMPLATE "${baseDbName}"`);
            } else if (stale) {
                // Reused across runs deliberately, not dropped in a
                // teardown: recreating every worker's database from scratch
                // on every single `npm test` invocation is the expensive
                // path this design exists to avoid, and reuse doesn't
                // reintroduce the bug this file exists to kill -- that bug
                // was two DIFFERENT workers' rows colliding WITHIN one run,
                // and a worker's database is exclusively its own across
                // runs the identical way it is within one. What reuse DOES
                // risk: a database kept from a PAST run, on a long-lived
                // local Postgres, can predate a migration that has since
                // landed and been applied to the base database -- that's
                // `stale` above, checked concurrently for every worker
                // before this loop, not here. CI never hits this branch:
                // its Postgres service container is created fresh every
                // run, so no worker database can ever predate anything.
                await admin.$executeRawUnsafe(`DROP DATABASE "${dbName}"`);
                await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}" TEMPLATE "${baseDbName}"`);
            }
        }
    } finally {
        await admin.$disconnect();
    }

    // Job 3: wipe every worker's database to zero rows, concurrently -- see
    // the file-level comment for why this runs even on a database that was
    // already current and didn't need CREATE/DROP above. A worker database
    // kept across runs would otherwise carry forward whatever a PAST run's
    // test files left behind (including a crash that skipped its own
    // cleanup) -- exactly the "stale state" this whole change exists to
    // eliminate, not merely narrow to one worker.
    await Promise.all(
        workerIds.map((workerId) => withClient(PrismaClient, workerDatabaseUrl(baseUrl, workerId), wipeAllRows)),
    );
};
