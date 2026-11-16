/**
 * `nameKeySql` on a database whose encoding is UTF8. The suite's own database is SQL_ASCII, like a real install's, where
 * Postgres cannot compose text, so this builds a throwaway UTF8 database beside it (same server, C locale, `unaccent` and
 * the trim function the fold calls) and runs the fold there. The fold there composes decomposed text first, as `nameKey`
 * does; the SQL_ASCII branch is asserted in nameKeySql.integration.test.ts.
 */
import fs from "fs";
import path from "path";
import { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "../../../utils/db";
import { nameKey } from "../../nameFold";
import { nameKeySql } from "../listens";

jest.setTimeout(60_000);

const MIGRATION = path.resolve(__dirname, "../../../../prisma/migrations/20260728090000_artist_identity/migration.sql");

let utf8: PrismaClient;
let databaseName = "";

/** The trim function as the migration defines it, so the throwaway database folds with the real one. */
function trimFunctionSql(): string {
    const found = /CREATE OR REPLACE FUNCTION kima_text_trim[\s\S]*?LANGUAGE sql IMMUTABLE STRICT;/.exec(fs.readFileSync(MIGRATION, "utf8"));
    if (!found) throw new Error("kima_text_trim is not defined in the artist identity migration");
    return found[0];
}

beforeAll(async () => {
    const [{ name }] = await prisma.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
    databaseName = `${name}_utf8`;
    await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await prisma.$executeRawUnsafe(`CREATE DATABASE "${databaseName}" TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`);
    const url = new URL(process.env.DATABASE_URL as string);
    url.pathname = `/${databaseName}`;
    utf8 = new PrismaClient({ datasourceUrl: url.toString() });
    await utf8.$executeRawUnsafe("CREATE EXTENSION IF NOT EXISTS unaccent");
    await utf8.$executeRawUnsafe(trimFunctionSql());
});

afterAll(async () => {
    await utf8?.$disconnect();
    if (databaseName) await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
});

const keys = async (db: PrismaClient, names: string[]): Promise<string[]> => {
    const rows = await db.$queryRaw<Array<{ k: string }>>(Prisma.sql`
        SELECT ${nameKeySql("v.name")} AS k
        FROM unnest(${names}::text[]) WITH ORDINALITY AS v(name, ord)
        ORDER BY v.ord`);
    return rows.map((r) => r.k);
};

describe("nameKeySql on a UTF8 database", () => {
    it("is a UTF8 database, and the suite's own is not", async () => {
        const [{ encoding }] = await utf8.$queryRaw<Array<{ encoding: string }>>`SELECT current_setting('server_encoding') AS encoding`;
        const [{ encoding: suite }] = await prisma.$queryRaw<Array<{ encoding: string }>>`SELECT current_setting('server_encoding') AS encoding`;

        expect(encoding).toBe("UTF8");
        expect(suite).not.toBe("UTF8");
    });

    it("composes a decomposed letter before folding, as nameKey does", async () => {
        const composed = "Ай"; // й as one character
        const decomposed = "Ай"; // и and a combining breve
        const names = [composed, decomposed, "Sigur Rós", "Sigur Rós", "Béyoncé"];

        const [a, b, c, d, e] = await keys(utf8, names);

        // The C locale cannot lower a Cyrillic capital, so the letters keep their case; what matters is that the two forms join.
        expect(b).toBe(a);
        expect(nameKey(decomposed)).toBe(nameKey(composed));
        expect(c).toBe(d);
        expect([c, e]).toEqual(["sigurros", "beyonce"]);
    });

    it("still keeps a name with nothing left as itself, and a name in another script by its letters", async () => {
        const [symbols, other] = await keys(utf8, ["!!!", "Би-2"]);

        expect(symbols).toBe("!!!");
        expect(other).toMatch(/^[Бб]и2$/);
    });
});
