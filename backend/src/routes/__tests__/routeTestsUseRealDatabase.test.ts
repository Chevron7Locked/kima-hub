/**
 * Route tests run against the real test database. A faked `utils/db` breaks when a route changes a lookup without
 * changing what a client sees, and passes when it is wrong: a fake `findFirst` returns its row whatever the `where`
 * asks for. To check how a route answers a database failure, make one call on the real client fail with
 * `jest.spyOn(prisma.<model>, "<method>").mockRejectedValueOnce(...)`.
 */

import fs from "fs";
import path from "path";

const ROUTES = path.resolve(__dirname, "..");

function testFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return testFiles(full);
        return entry.isFile() && entry.name.endsWith(".test.ts") ? [full] : [];
    });
}

it("no route test fakes the database module", () => {
    // Any jest module-faking call whose path ends in utils/db, whatever the quotes, depth or extension.
    const fakesDb =
        /jest\.(?:mock|doMock|setMock|unstable_mockModule|requireMock)\(\s*["'`][^"'`]*\butils\/db(?:\/index)?(?:\.[cm]?[jt]s)?["'`]/;
    const offenders = testFiles(ROUTES)
        .filter((f) => fakesDb.test(fs.readFileSync(f, "utf8")))
        .map((f) => path.relative(ROUTES, f));
    expect(offenders).toEqual([]);
});
