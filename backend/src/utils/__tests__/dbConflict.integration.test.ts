/**
 * Transaction conflicts as Prisma really reports them, produced on the suite database: a deadlock and a serialization
 * failure, each through a raw statement and through a model write. The shapes Prisma gives that Postgres cannot be
 * made to produce here (a bare driver code, a message alone) are checked with the same fields.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { isTransactionConflict } from "../dbConflict";
import { untilLockWait } from "../../__tests__/helpers/lockWait";

jest.setTimeout(60_000);

const TX = { timeout: 30_000, maxWait: 30_000 };
const P = "dbc";
const artistId = (n: number) => `${P}a${n}`;

async function seed() {
    await prisma.artist.createMany({
        data: [1, 2].map((n) => ({ id: artistId(n), name: `${P} artist ${n}`, normalizedName: `${P} artist ${n}`, mbid: `${P}-mbid-${n}`, identityKey: `${P}-key-${n}` })),
    });
}

beforeEach(seed);
afterEach(() => prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id LIKE '${P}%'`));

/**
 * Two transactions that each hold one artist row and then ask for the other's. Postgres ends whichever one's deadlock
 * check runs first, and under load that can be either, so the error comes from whichever side was ended.
 */
async function deadlockVictim(touch: (tx: Prisma.TransactionClient, id: string) => Promise<unknown>): Promise<unknown> {
    let inner: Promise<unknown> | undefined;
    const outer = await prisma
        .$transaction(async (tx) => {
            await touch(tx, artistId(1));
            inner = prisma
                .$transaction(async (tx2) => {
                    await touch(tx2, artistId(2));
                    await touch(tx2, artistId(1));
                }, TX)
                .then(() => null, (error: unknown) => error);
            await untilLockWait(`UPDATE "`);
            await touch(tx, artistId(2));
        }, TX)
        .then(() => null, (error: unknown) => error);
    const ended = [outer, await inner].filter((error) => error !== null);
    expect(ended).toHaveLength(1);
    return ended[0];
}

const rawTouch = (tx: Prisma.TransactionClient, id: string) =>
    tx.$executeRawUnsafe(`UPDATE "Artist" SET name = name || '' WHERE id = $1`, id);
const modelTouch = (tx: Prisma.TransactionClient, id: string) =>
    tx.artist.update({ where: { id }, data: { name: `${P} touched` } });

/** A Repeatable Read transaction that read an artist, then finds another transaction changed it before its own write. */
async function serializationVictim(touch: (tx: Prisma.TransactionClient, id: string) => Promise<unknown>): Promise<unknown> {
    try {
        await prisma.$transaction(
            async (tx) => {
                await tx.$queryRawUnsafe(`SELECT id FROM "Artist" WHERE id = $1`, artistId(1));
                await prisma.$executeRawUnsafe(`UPDATE "Artist" SET name = 'changed under it' WHERE id = $1`, artistId(1));
                await touch(tx, artistId(1));
            },
            { ...TX, isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
        );
        return null;
    } catch (error) {
        return error;
    }
}

describe("a deadlock", () => {
    it("is recognised from a raw statement (P2010 carrying 40P01)", async () => {
        const error = await deadlockVictim(rawTouch);
        expect(error).toMatchObject({ code: "P2010", meta: { code: "40P01" } });
        expect(isTransactionConflict(error)).toBe(true);
    });

    it("is recognised from a model write, where Prisma gives no code and only the message says so", async () => {
        const error = await deadlockVictim(modelTouch);
        expect(error).toBeInstanceOf(Prisma.PrismaClientUnknownRequestError);
        expect((error as { code?: string }).code).toBeUndefined();
        expect(isTransactionConflict(error)).toBe(true);
    });
});

describe("a serialization failure", () => {
    it("is recognised from a raw statement (P2010 carrying 40001)", async () => {
        const error = await serializationVictim(rawTouch);
        expect(error).toMatchObject({ code: "P2010", meta: { code: "40001" } });
        expect(isTransactionConflict(error)).toBe(true);
    });

    it("is recognised from a model write, however Prisma reports it", async () => {
        const error = await serializationVictim(modelTouch);
        expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
        expect(isTransactionConflict(error)).toBe(true);
    });
});

describe("the other shapes", () => {
    it("P2034 is a conflict, because Prisma says 'write conflict or a deadlock'", () => {
        const error = Object.assign(new Error("Transaction failed due to a write conflict or a deadlock."), { code: "P2034" });
        expect(isTransactionConflict(error)).toBe(true);
    });

    it("a bare SQLSTATE on code is recognised", () => {
        expect(isTransactionConflict({ code: "40P01" })).toBe(true);
        expect(isTransactionConflict({ code: "40001" })).toBe(true);
    });

    it("the message alone is recognised, in any case", () => {
        expect(isTransactionConflict(new Error("ERROR: Deadlock Detected"))).toBe(true);
        expect(isTransactionConflict(new Error("could not serialize access due to concurrent update"))).toBe(true);
    });

    it("anything else is not a conflict", () => {
        for (const other of [
            new Error("connection refused"),
            Object.assign(new Error("unique"), { code: "P2002" }),
            Object.assign(new Error("raw"), { code: "P2010", meta: { code: "23505" } }),
            null,
            undefined,
            "deadlock detected",
        ]) {
            expect(isTransactionConflict(other)).toBe(false);
        }
    });
});
