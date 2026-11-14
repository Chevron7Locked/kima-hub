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
 * Files still allowed to fake the database module, each owned by an open ticket that converts it. Delete the
 * line when the file is converted; the check below fails if a listed file no longer fakes the module.
 */
const EXEMPT = new Set([
    // Another open ticket (the enrichment queue's stage records) is rewriting this file.
    "workers/__tests__/enrichmentQueueBackoff.test.ts",
    // Ticket 84 converts this one with the scheduler's stop, after the job modules move out.
    "workers/__tests__/unifiedEnrichment.runState.test.ts",
]);

const CODE_FILE = /\.[cm]?[jt]sx?$/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/**
 * Every file a test run loads that is not production code: a test, helper or fixture under any `__tests__` folder, a
 * mock or setup file under `__mocks__`, and a `*.test.*` or `*.spec.*` file wherever it sits. A helper that faked the
 * database module would put the fake under every test that imports it.
 */
function testSupportFiles(dir: string, underTestFolder = false): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            return testSupportFiles(full, underTestFolder || entry.name === "__tests__" || entry.name === "__mocks__");
        }
        if (!entry.isFile() || !CODE_FILE.test(entry.name)) return [];
        return underTestFolder || TEST_FILE.test(entry.name) ? [full] : [];
    });
}

// Any jest module-faking call whose path ends in utils/db, whatever the quotes, depth or extension.
const fakesDb =
    /jest\.(?:mock|doMock|setMock|unstable_mockModule|requireMock)\(\s*["'`][^"'`]*\butils\/db(?:\/index)?(?:\.[cm]?[jt]s)?["'`]/;

const scanned = testSupportFiles(SRC).map((f) => path.relative(SRC, f));
const fakers = scanned.filter((f) => fakesDb.test(fs.readFileSync(path.join(SRC, f), "utf8")));

it("no test, helper or mock fakes the database module, apart from the exempt files", () => {
    expect(fakers.filter((f) => !EXEMPT.has(f))).toEqual([]);
});

it("every exempt file still fakes it, so the list shrinks as files are converted", () => {
    expect([...EXEMPT].filter((f) => !fakers.includes(f))).toEqual([]);
});

it("the scan reaches helper and mock files, not just the tests", () => {
    expect(scanned).toEqual(
        expect.arrayContaining([
            "__tests__/helpers/discoverBuildFixtures.ts",
            "services/__tests__/helpers/lidarrPipeline.ts",
            "routes/__tests__/helpers/serverMount.ts",
            "__mocks__/test-env.cjs",
        ]),
    );
});

it("a helper that fakes the database module is caught", () => {
    // Built in pieces so this file does not match its own check.
    const helper = `export function fake() {\n    ${"jest"}.${"mock"}("../../utils/db", () => ({ prisma: {} }));\n}`;
    expect(fakesDb.test(helper)).toBe(true);
});
