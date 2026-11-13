/**
 * Tests run against the real test database. A faked `utils/db` breaks when code changes a lookup without
 * changing what a caller sees, and passes when it is wrong: a fake `findFirst` returns its row whatever the `where`
 * asks for. To check how a module or route answers a database failure, make one call on the real client fail with
 * `jest.spyOn(prisma.<model>, "<method>").mockRejectedValueOnce(...)`.
 */

import fs from "fs";
import path from "path";

const SRC = path.resolve(__dirname, "../..");

/**
 * Test files still allowed to fake the database module, each owned by an open ticket that converts it. Delete the
 * line when the file is converted; the check below fails if a listed file no longer fakes the module.
 */
const EXEMPT = new Set([
    // Another open ticket (the enrichment queue's stage records) is rewriting this file.
    "workers/__tests__/enrichmentQueueBackoff.test.ts",
    // Another open ticket (the listens module) is rewriting Discover seeding's reads of plays.
    "services/discovery/__tests__/discoverySeeding.test.ts",
]);

function testFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return testFiles(full);
        return entry.isFile() && entry.name.endsWith(".test.ts") ? [full] : [];
    });
}

// Any jest module-faking call whose path ends in utils/db, whatever the quotes, depth or extension.
const fakesDb =
    /jest\.(?:mock|doMock|setMock|unstable_mockModule|requireMock)\(\s*["'`][^"'`]*\butils\/db(?:\/index)?(?:\.[cm]?[jt]s)?["'`]/;

const fakers = testFiles(SRC)
    .filter((f) => fakesDb.test(fs.readFileSync(f, "utf8")))
    .map((f) => path.relative(SRC, f));

it("no test fakes the database module, apart from the exempt files", () => {
    expect(fakers.filter((f) => !EXEMPT.has(f))).toEqual([]);
});

it("every exempt file still fakes it, so the list shrinks as files are converted", () => {
    expect([...EXEMPT].filter((f) => !fakers.includes(f))).toEqual([]);
});
