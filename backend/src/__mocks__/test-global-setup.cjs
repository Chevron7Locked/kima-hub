/**
 * Runs once before any worker. Creates the base test database as SQL_ASCII / C (the encoding real installs use),
 * migrates it, and clones a fresh database per Jest worker (`<base>_w<id>`, 1..maxWorkers) every run, wiped to zero
 * rows. Files on different workers cannot touch each other's rows. One run at a time holds the base (a Postgres advisory lock, released in the global
 * teardown or by Postgres itself when the run's process dies).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { DATABASE_URL_FALLBACK } = require('./test-db-defaults.cjs');
const { databaseNameOf, workerDatabaseName, workerDatabaseUrl, adminDatabaseUrl } = require('./test-worker-db.cjs');

/** Real installs run on SQL_ASCII with the C locale; the suite must see the same text rules. */
const ENCODING = 'SQL_ASCII';
const LOCALE = 'C';

/** The longest any one query in a test may run before Postgres cancels it. */
const STATEMENT_TIMEOUT = '60s';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../prisma/migrations');

/**
 * The migrations a database has applied, as one string of sorted `name:checksum` pairs, and whether one started and
 * never finished (a run killed mid-migration; Prisma then refuses to apply anything more). A database with no
 * `_prisma_migrations` table yet has applied nothing.
 */
async function appliedMigrations(client) {
    let rows;
    try {
        rows = await client.$queryRaw`SELECT migration_name, checksum, finished_at, rolled_back_at FROM _prisma_migrations`;
    } catch (err) {
        // Only a missing table means "nothing applied"; any other failure is reported, never read as an empty base.
        if (err?.meta?.code === '42P01' || /relation "_prisma_migrations" does not exist/.test(String(err?.message))) {
            return { applied: '', unfinished: false };
        }
        throw err;
    }
    const done = rows.filter((r) => r.finished_at && !r.rolled_back_at).map((r) => `${r.migration_name}:${r.checksum}`);
    return { applied: [...new Set(done)].sort().join(','), unfinished: rows.some((r) => !r.finished_at && !r.rolled_back_at) };
}

/**
 * Every migration in prisma/migrations in the same form, the checksum being the one Prisma stores (sha256 of
 * migration.sql): a fully migrated database matches it, and an applied migration edited since no longer does.
 */
function migrationsOnDisk() {
    return fs
        .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory() && fs.existsSync(path.join(MIGRATIONS_DIR, e.name, 'migration.sql')))
        .map((e) => {
            const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, e.name, 'migration.sql'));
            return `${e.name}:${crypto.createHash('sha256').update(sql).digest('hex')}`;
        })
        .sort()
        .join(',');
}

/**
 * Applies every pending migration to the base database, exactly as an install would. Returns Prisma's own output
 * when it fails, so the caller can report it.
 */
function migrateBase(baseUrl) {
    try {
        execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
            cwd: path.resolve(__dirname, '../..'),
            env: { ...process.env, DATABASE_URL: baseUrl },
            stdio: 'pipe',
        });
        return null;
    } catch (err) {
        return `${err.stderr ?? ''}${err.stdout ?? ''}`.trim() || String(err.message);
    }
}

/**
 * Truncates every table in the public schema, found from `pg_tables` so new
 * models are covered. `_prisma_migrations` is kept so the database still
 * reads as migrated.
 */
async function wipeAllRows(client) {
    await client.$executeRawUnsafe(`
        DO $$
        DECLARE tbls text;
        BEGIN
            SELECT string_agg(format('%I.%I', schemaname, tablename), ', ')
              INTO tbls
              FROM pg_tables
             WHERE schemaname = 'public' AND tablename <> '_prisma_migrations';
            IF tbls IS NOT NULL THEN
                EXECUTE 'TRUNCATE TABLE ' || tbls || ' CASCADE';
            END IF;
        END $$;
    `);
}

/** Connect to `url`, run `fn`, always disconnect -- the shape every per-database step below shares. */
async function withClient(PrismaClient, url, fn) {
    const client = new PrismaClient({ datasources: { db: { url } } });
    try {
        return await fn(client);
    } finally {
        await client.$disconnect();
    }
}

function hasInstallEncoding(db) {
    return db.enc === ENCODING && db.collate === LOCALE && db.ctype === LOCALE;
}

function createDatabaseSql(dbName, template) {
    return template
        ? `CREATE DATABASE "${dbName}" TEMPLATE "${template}"`
        : `CREATE DATABASE "${dbName}" ENCODING '${ENCODING}' LC_COLLATE '${LOCALE}' LC_CTYPE '${LOCALE}' TEMPLATE template0`;
}

const endConnectionsSql = `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`;

module.exports = async function globalSetup(globalConfig) {
    process.env.DATABASE_URL ??= DATABASE_URL_FALLBACK;
    const baseUrl = process.env.DATABASE_URL;

    // Required so late so @prisma/client reads the DATABASE_URL set above --
    // requiring it any earlier would read process.env before the fallback runs.
    const { PrismaClient } = require('@prisma/client');

    const baseDbName = databaseNameOf(baseUrl);
    // This setup drops, recreates, migrates and ends connections to the base and its clones, so it works only on a
    // database named as a test database; an exported DATABASE_URL naming any other database stops the run here.
    if (!/_test$/.test(baseDbName)) {
        throw new Error(
            `DATABASE_URL names the database "${baseDbName}", which is not a test database (its name must end in _test). ` +
                `The test setup drops and recreates its database, so it refuses to run against this one.`,
        );
    }
    const workerIds = Array.from({ length: globalConfig.maxWorkers }, (_, i) => i + 1);

    // One connection, held until the global teardown: the advisory lock lives on it, and Postgres frees the lock
    // when the connection closes, so a run that dies cannot leave the next one locked out.
    const lockUrl = new URL(adminDatabaseUrl(baseUrl));
    lockUrl.searchParams.set('connection_limit', '1');
    const admin = new PrismaClient({ datasources: { db: { url: lockUrl.toString() } } });
    // Takes the run's lock on the base database, or confirms this connection still holds it.
    const tryLock = async () => (await admin.$queryRaw`SELECT pg_try_advisory_lock(hashtext(${`kima-jest:${baseDbName}`})) AS held`)[0].held;
    const locked = await tryLock();
    if (!locked) {
        // A run whose machine slept or froze can hold the lock for hours without running, so the holder is named
        // with the command that frees it.
        const holders = await admin.$queryRaw`
            SELECT a.pid, a.client_addr::text AS addr, a.backend_start::text AS since
              FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
             WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
               AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
               AND l.classid = ((hashtext(${`kima-jest:${baseDbName}`})::bigint >> 32) & 4294967295)::oid
               AND l.objid = (hashtext(${`kima-jest:${baseDbName}`})::bigint & 4294967295)::oid`;
        await admin.$disconnect();
        const who = holders.map((h) => `Postgres process ${h.pid} (from ${h.addr ?? 'a local socket'}, since ${h.since})`);
        throw new Error(
            `Another test run is using the test database ${baseDbName}${who.length ? `: ${who.join(', ')}` : ''}. ` +
                `Wait for it to finish or stop it; two runs on one database wipe each other's rows. If no run is ` +
                `really going (its machine slept or froze), end it with SELECT pg_terminate_backend(<pid>) on that server.`,
        );
    }
    globalThis.__kimaTestLock = admin;
    // Prisma reconnects on its own if the connection drops, and the lock does not survive that; before each step that
    // drops or clones a database the lock is taken again on the current connection (a no-op while it still holds it),
    // and the run stops if another run took it in between.
    const holdLock = async () => {
        if (!(await tryLock())) throw new Error(`The lock on the test database ${baseDbName} was lost to another run.`);
    };

    try {
        const listDatabases = async () => {
            const rows = await admin.$queryRaw`
                SELECT datname, pg_encoding_to_char(encoding) AS enc, datcollate AS collate, datctype AS ctype
                  FROM pg_database`;
            return new Map(rows.map((r) => [r.datname, r]));
        };
        let dbs = await listDatabases();

        // The base and its worker clones, dropped and the base created empty as SQL_ASCII.
        const recreateBase = async () => {
            await holdLock();
            for (const workerId of workerIds) {
                const name = workerDatabaseName(baseUrl, workerId);
                if (dbs.has(name)) await admin.$executeRawUnsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
            }
            if (dbs.has(baseDbName)) await admin.$executeRawUnsafe(`DROP DATABASE "${baseDbName}" WITH (FORCE)`);
            await admin.$executeRawUnsafe(createDatabaseSql(baseDbName));
            dbs = await listDatabases();
        };
        const readBase = () => withClient(PrismaClient, baseUrl, appliedMigrations);

        const base = dbs.get(baseDbName);
        if (!base || !hasInstallEncoding(base)) await recreateBase();

        // Migrations run only when the base differs from prisma/migrations. A migration that never finished, or a
        // base that still differs after migrating (one no longer on disk, or edited since it was applied), is started
        // over from an empty base.
        const wanted = migrationsOnDisk();
        let state = await readBase();
        if (state.unfinished) {
            await recreateBase();
            state = await readBase();
        }
        if (state.applied !== wanted) {
            // A base Prisma cannot bring up to date is started over from empty.
            await holdLock();
            const firstFailure = migrateBase(baseUrl);
            state = await readBase();
            let lastFailure = firstFailure;
            if (state.applied !== wanted) {
                await recreateBase();
                lastFailure = migrateBase(baseUrl);
                state = await readBase();
            }
            if (state.applied !== wanted) {
                throw new Error(
                    `The test base ${baseDbName} does not match prisma/migrations even after a fresh migrate.` +
                        (lastFailure ? `\nprisma migrate deploy said:\n${lastFailure}` : '') +
                        (firstFailure && firstFailure !== lastFailure ? `\nOn the first attempt it said:\n${firstFailure}` : ''),
                );
            }
        }

        // Every worker database is cloned fresh, so nothing a past run left (rows, or a table a killed test renamed)
        // survives. Cloning needs the base free of connections; a killed run can leave one open on the server.
        await holdLock();
        await admin.$executeRawUnsafe(endConnectionsSql, baseDbName);
        // Clones a past run with more workers made are dropped too, so none is left holding old rows or a broken table.
        const ours = new Set(workerIds.map((workerId) => workerDatabaseName(baseUrl, workerId)));
        for (const name of dbs.keys()) {
            if (name.startsWith(`${baseDbName}_w`) && /^\d+$/.test(name.slice(baseDbName.length + 2)) && !ours.has(name)) {
                await admin.$executeRawUnsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
            }
        }
        for (const workerId of workerIds) {
            const name = workerDatabaseName(baseUrl, workerId);
            if (dbs.has(name)) await admin.$executeRawUnsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
            await admin.$executeRawUnsafe(createDatabaseSql(name, baseDbName));
            // A runaway query fails its test with Postgres's own error instead of holding the run open.
            await admin.$executeRawUnsafe(`ALTER DATABASE "${name}" SET statement_timeout = '${STATEMENT_TIMEOUT}'`);
        }

        // Rows the migrations themselves insert are wiped too, so every test starts from empty tables.
        await Promise.all(
            workerIds.map((workerId) => withClient(PrismaClient, workerDatabaseUrl(baseUrl, workerId), wipeAllRows)),
        );
    } catch (err) {
        delete globalThis.__kimaTestLock;
        await admin.$disconnect();
        throw err;
    }

    // The lock must last the whole run, not only the setup: a connection that drops while the tests run would free it
    // for a second run to wipe these databases. It is checked (and so kept from idling out) every 15 s until the
    // teardown, and the run stops at once if another run holds it.
    // A query that fails (a dropped connection Prisma is still replacing) is tried again on the next tick; only another
    // run holding the lock, or three failed checks in a row, stops the run. The teardown waits for a check in flight.
    delete globalThis.__kimaTestLockStopping;
    let failedChecks = 0;
    globalThis.__kimaTestLockCheck = setInterval(() => {
        if (globalThis.__kimaTestLockStopping || globalThis.__kimaTestLockTick) return;
        globalThis.__kimaTestLockTick = tryLock()
            .then((held) => {
                failedChecks = 0;
                if (!held) return `Another run took the lock on the test database ${baseDbName}.`;
                return null;
            })
            .catch((err) => (++failedChecks >= 3 ? `The lock on the test database ${baseDbName} could not be checked: ${err.message}` : null))
            .then((reason) => {
                globalThis.__kimaTestLockTick = null;
                if (!reason || globalThis.__kimaTestLockStopping) return;
                fs.writeSync(2, `\n${reason} Stopping this run: its databases may be wiped under it.\n`);
                process.exit(1);
            });
    }, 15_000);
    globalThis.__kimaTestLockCheck.unref();
};
