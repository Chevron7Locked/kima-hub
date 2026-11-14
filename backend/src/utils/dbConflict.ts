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

function reports(err: unknown, sqlState: string, message: RegExp): boolean {
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
    return reports(err, "40P01", /deadlock detected/i);
}

/** Postgres refused this transaction because rows it used changed under it (40001). */
export function isSerializationFailure(err: unknown): boolean {
    return reports(err, "40001", /could not serialize access/i);
}

/** Either: another transaction's work ended this one, nothing was written, and running it again is safe. */
export function isTransactionConflict(err: unknown): boolean {
    return isDeadlock(err) || isSerializationFailure(err);
}
