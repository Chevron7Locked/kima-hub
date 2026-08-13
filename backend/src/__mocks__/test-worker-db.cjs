/**
 * Per-worker database naming, shared by `test-env.cjs` (runs INSIDE each Jest
 * worker, has `JEST_WORKER_ID`, points that worker's `DATABASE_URL` at its own
 * database) and `test-global-setup.cjs` (runs ONCE, before any worker exists,
 * provisions one database per worker slot). Pulled out standalone rather than
 * duplicated in both, for the same reason `test-db-defaults.cjs` already is:
 * two independent copies of "how do we name a worker's database" is exactly
 * the kind of rule that silently drifts apart -- see that file's own comment.
 *
 * This is the fix for a bug class this track hit five separate times: a test
 * assuming it owns the whole database (unscoped `deleteMany`, `count()`,
 * `TRUNCATE`, `[0]` of a global ranking, a global pagination `total`) racing
 * a DIFFERENT test file's fixtures under Jest's parallel workers, because
 * every worker pointed at the SAME physical database. Naming each worker's
 * database from `JEST_WORKER_ID` -- 1-indexed, matching Jest's own numbering,
 * confirmed empirically (`--maxWorkers=N` with more test files than workers
 * still only ever produces worker ids `1..N`, no gaps, no values above N) --
 * makes that collision structurally impossible: two files scheduled onto
 * DIFFERENT workers now physically cannot see each other's rows, no matter
 * what either one's fixtures do. Two files scheduled onto the SAME worker
 * still share that worker's database, but Jest never runs two files
 * concurrently within one worker, so that was never the race in the first
 * place. Per-file scoped prefixes (`itest_`, `ihttp_{filePrefix}_`, etc.)
 * still matter for a different reason this doesn't touch: cleaning up after
 * yourself so a THIS-worker file that ran earlier doesn't leave rows a later
 * file on the same worker trips over.
 *
 * See `test-global-setup.cjs`'s own top comment for a SIXTH failure mode this
 * also closes, discovered while diagnosing this: two files sharing a database
 * under concurrent workers produced foreign-key violations on rows a session
 * had just committed itself, which was NOT a scoping bug in either file and
 * was NOT fixed by capping the Postgres connection pool. Physical isolation
 * closes it without knowing why it happened.
 */

/** The bare database name a Postgres connection URL points at. */
function databaseNameOf(url) {
    return new URL(url).pathname.replace(/^\//, "");
}

/** worker id 1 => "<base>_w1", etc. */
function workerDatabaseName(baseUrl, workerId) {
    return `${databaseNameOf(baseUrl)}_w${workerId}`;
}

/** Same connection (host/port/user/pass/query params) as `baseUrl`, pointed at that worker's own database instead of the shared one. */
function workerDatabaseUrl(baseUrl, workerId) {
    const u = new URL(baseUrl);
    u.pathname = `/${workerDatabaseName(baseUrl, workerId)}`;
    return u.toString();
}

/** Same connection as `baseUrl`, pointed at Postgres's own always-present admin database -- never the template db itself, which Postgres refuses to clone FROM while anything (including the cloning connection) is connected TO it. */
function adminDatabaseUrl(baseUrl) {
    const u = new URL(baseUrl);
    u.pathname = "/postgres";
    return u.toString();
}

module.exports = { databaseNameOf, workerDatabaseName, workerDatabaseUrl, adminDatabaseUrl };
