/**
 * Postgres refusing a transaction because of another one, recognised in every shape Prisma reports it:
 * the SQLSTATE on `meta.code` (a raw statement, `P2010`), on `code` (a driver error), as Prisma's own `P2034`
 * ("write conflict or a deadlock", from a transaction), or in the message text.
 *
 * Two named cases. A deadlock (40P01) is Postgres picking this transaction as the victim; a serialization failure
 * (40001) is a Repeatable Read or Serializable transaction finding its rows changed under it. Each caller says which
 * it retries on. `P2034` does not say which of the two it was, so both recognise it.
 */

interface PrismaLikeError {
    code?: unknown;
    meta?: { code?: unknown };
    message?: unknown;
}

function matchesConflict(err: unknown, sqlState: string, message: RegExp): boolean {
    const e = err as PrismaLikeError | null;
    if (!e || typeof e !== "object") return false;
    return (
        e.meta?.code === sqlState ||
        e.code === sqlState ||
        e.code === "P2034" ||
        (typeof e.message === "string" && message.test(e.message))
    );
}

/** Postgres picked this transaction as a deadlock victim (40P01). */
export function isDeadlock(err: unknown): boolean {
    return matchesConflict(err, "40P01", /deadlock detected/i);
}

/** Postgres refused this transaction because rows it used changed under it (40001). */
export function isSerializationFailure(err: unknown): boolean {
    return matchesConflict(err, "40001", /could not serialize access/i);
}

/** Either: another transaction's work ended this one, nothing was written, and running it again is safe. */
export function isTransactionConflict(err: unknown): boolean {
    return isDeadlock(err) || isSerializationFailure(err);
}

/**
 * The database had no time or no connection to give this transaction, so nothing was written and the same request
 * can be sent again: Prisma's transaction timeout or already-closed transaction (`P2028`), or a connection pool with
 * none free in time (`P2024`).
 */
export function isDatabaseBusy(err: unknown): err is { code: "P2028" | "P2024" } {
    const code = (err as PrismaLikeError | null)?.code;
    return code === "P2028" || code === "P2024";
}

/** The shortest and longest wait before a lost transaction runs again. */
const WAIT_MIN_MS = 50;
const WAIT_MAX_MS = 200;

export interface LostRun {
    /** The run that lost, counting from 1. */
    run: number;
    /** How many runs there are in all. */
    runs: number;
    /** How long the next run waits. */
    waitMs: number;
}

/**
 * Runs `fn` (a whole transaction, so a lost run left nothing behind), and runs it again when it lost to another
 * transaction, up to `runs` runs in all. Each retry waits a random 50 to 200 ms first, so two transactions that
 * lost to each other do not start again in step and collide again. A failure that is not a conflict is thrown at
 * once; a conflict on the last run is thrown as it came. `onLostRun` is for the caller's log.
 */
export async function retryOnConflict<T>(
    fn: () => Promise<T>,
    options: { runs: number; onLostRun?: (lost: LostRun) => void },
): Promise<T> {
    for (let run = 1; ; run++) {
        try {
            return await fn();
        } catch (error) {
            if (run >= options.runs || !isTransactionConflict(error)) throw error;
            const waitMs = WAIT_MIN_MS + Math.random() * (WAIT_MAX_MS - WAIT_MIN_MS);
            options.onLostRun?.({ run, runs: options.runs, waitMs });
            await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
    }
}
