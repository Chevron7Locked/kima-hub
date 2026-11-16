/**
 * `nameKeySql` (the fold the listens module finds a kept play's song by, in the database) folds names as `nameKey` (the
 * fold in code) does. Real database; no mocks.
 *
 * Three differences are by design or by the database, and asserted here as such:
 * - a name with no letters or digits has no `nameKey` ("") but keeps itself in SQL, so a kept "!!!" finds "!!!" and not
 *   every other symbol-only name;
 * - SQL does not compose decomposed text first (Postgres can only do that on a UTF8 database, and this must run on any),
 *   so a letter that only exists composed folds apart from its decomposed form there, while `nameKey` joins them;
 * - a database with a C ctype (the all-in-one image's, and the suite's) does not count letters outside ASCII as letters
 *   when stripping, so a name in another script keeps only its ASCII letters and digits there, or itself when it has
 *   none. A UTF8 database with a real locale folds those scripts as `nameKey` does.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../../../utils/db";
import { nameKey } from "../../nameFold";
import { nameKeySql } from "../listens";

const sqlKeys = async (names: string[]): Promise<string[]> => {
    const rows = await prisma.$queryRaw<Array<{ ord: number; k: string }>>(Prisma.sql`
        SELECT v.ord::int AS ord, ${nameKeySql("v.name")} AS k
        FROM unnest(${names}::text[]) WITH ORDINALITY AS v(name, ord)
        ORDER BY v.ord`);
    return rows.map((r) => r.k);
};

/** Whether this database counts a letter outside ASCII as a letter. */
const countsWideLetters = async (): Promise<boolean> => {
    const [row] = await prisma.$queryRaw<Array<{ wide: boolean }>>`SELECT 'й' ~ '[[:alnum:]]' AS wide`;
    return row.wide;
};

describe("nameKeySql", () => {
    it.each([
        ["accents", ["Sigur Rós", "Sigur Ros", "SIGUR RÓS", "Beyoncé", "Beyonce"]],
        ["case", ["Daft Punk", "DAFT PUNK", "daft punk", "dAfT pUnK"]],
        ["punctuation and spaces", ["AC/DC", "AC-DC", "A.C. D.C.", "  ac dc  ", "Guns N' Roses", "Guns N Roses"]],
        ["apostrophe variants", ["Don't Stop", "Don’t Stop", "Don‘t Stop", "Don`t Stop", "Dont Stop", "Don´t Stop"]],
        ["sharp s and ligatures", ["Straße", "STRASSE", "Æon Flux", "Aeon Flux"]],
        ["digits", ["Blink-182", "blink 182", "2Pac", "2 pac"]],
        ["decomposed accents", ["Sigur Rós", "Béyoncé", "Sigur Rós"]],
    ])("folds %s as nameKey does", async (_label, names) => {
        expect(await sqlKeys(names)).toEqual(names.map((n) => nameKey(n)));
    });

    it("folds every variant of a name to one key, as nameKey does", async () => {
        const names = ["Don't Stop", "Don’t Stop", "DON`T STOP", " dont  stop "];

        expect(new Set(await sqlKeys(names)).size).toBe(1);
        expect(new Set(names.map(nameKey)).size).toBe(1);
    });

    it("keeps a name with no letters or digits as itself, where nameKey has no key for it", async () => {
        const names = ["!!!", "???", "™", "♫♫"];

        expect(await sqlKeys(names)).toEqual(names);
        expect(names.map(nameKey)).toEqual(["", "", "", ""]);
    });

    it("keeps an empty name empty", async () => {
        expect(await sqlKeys([""])).toEqual([""]);
        expect(nameKey("")).toBe("");
    });

    it("folds names in other scripts as nameKey does where the database counts their letters, else by their ASCII part", async () => {
        const names = ["宇多田ヒカル", "宇多田 ヒカル", "Би-2", "би 2"];

        const sql = await sqlKeys(names);

        if (await countsWideLetters()) expect(sql).toEqual(names.map((n) => nameKey(n)));
        else expect(sql).toEqual(names.map((n) => n.replace(/[^A-Za-z0-9]/g, "") || n));
    });

    it("does not compose a decomposed letter that has no unaccented form, where nameKey does", async () => {
        const composed = "Ай";
        const decomposed = "Ай";

        expect(nameKey(decomposed)).toBe(nameKey(composed));
        const [sqlComposed, sqlDecomposed] = await sqlKeys([composed, decomposed]);
        expect(sqlDecomposed).not.toBe(sqlComposed);
    });
});
