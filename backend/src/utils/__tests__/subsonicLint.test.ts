/**
 * `npm run lint` keeps Subsonic parameters read through `one` and `many`: a `req.query` read in the Subsonic routes,
 * their auth middleware or their reply helper fails it, and the same read elsewhere does not. Runs the real ESLint
 * binary with the backend's own config on source text, so what CI runs is what is tested.
 */

import { spawnSync } from "child_process";
import path from "path";

const BACKEND = path.resolve(__dirname, "../../..");
const ESLINT = path.join(BACKEND, "node_modules/eslint/bin/eslint.js");

function lint(filename: string, source: string): { errors: number; messages: string[] } {
    const run = spawnSync(process.execPath, [ESLINT, "--stdin", "--stdin-filename", filename, "--format", "json"], {
        cwd: BACKEND,
        input: source,
        encoding: "utf8",
    });
    const [file] = JSON.parse(run.stdout) as Array<{ errorCount: number; messages: Array<{ message: string }> }>;
    return { errors: file.errorCount, messages: file.messages.map((m) => m.message) };
}

const CAST = `import { Request } from "express";\nexport const id = (req: Request) => req.query.id as string;\n`;

describe("the Subsonic parameter lint", () => {
    it("fails a req.query cast in a Subsonic route", () => {
        const result = lint("src/routes/subsonic/library.ts", CAST);
        expect(result.errors).toBe(1);
        expect(result.messages[0]).toContain("one(req, name)");
    });

    it("fails the other ways to reach req.query", () => {
        expect(lint("src/routes/subsonic/library.ts", `export const q = (req: any) => req["query"];\n`).errors).toBe(1);
        expect(lint("src/routes/subsonic/library.ts", `export const q = (req: any) => { const { query } = req; return query; };\n`).errors).toBe(1);
    });

    it("fails a cast, a non-null, an alias, a parameter pattern or res.req", () => {
        const errors = (source: string) => lint("src/routes/subsonic/library.ts", source).errors;
        expect(errors(`export const q = (req: any) => (req as { query: { id: string } }).query.id;\n`)).toBe(1);
        expect(errors(`export const q = (req?: any) => req!.query;\n`)).toBe(1);
        expect(errors(`export const q = (req: any) => { const r = req; return r.query; };\n`)).toBe(1);
        expect(errors(`export const q = ({ query }: any) => query;\n`)).toBe(1);
        expect(errors(`export const q = (res: any) => res.req.query;\n`)).toBe(1);
    });

    it("fails the Subsonic auth middleware and reply helper too", () => {
        expect(lint("src/middleware/subsonicAuth.ts", CAST).errors).toBe(1);
        expect(lint("src/utils/subsonicResponse.ts", CAST).errors).toBe(1);
    });

    it("passes a read through the reader", () => {
        const source = `import { Request } from "express";\nimport { one } from "../../utils/subsonicParams";\nexport const id = (req: Request) => one(req, "id");\n`;
        expect(lint("src/routes/subsonic/library.ts", source).errors).toBe(0);
    });

    it("leaves the rest of the backend alone", () => {
        expect(lint("src/routes/library.ts", CAST).errors).toBe(0);
    });
});
