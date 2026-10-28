import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "..", "..");

function read(rel: string): string {
    return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

describe("openai is absent from the codebase", () => {
    it("the schema has no openai columns", () => {
        expect(read("prisma/schema.prisma")).not.toMatch(/openai/i);
    });

    it("the settings route has no openai fields or endpoint", () => {
        expect(read("src/routes/systemSettings.ts")).not.toMatch(/openai/i);
    });

    it("the encrypted-field map has no openai key", () => {
        expect(read("src/utils/encryptedFields.ts")).not.toMatch(/openai/i);
    });

    it("the frontend api client has no openai method", () => {
        const api = fs.readFileSync(path.join(ROOT, "..", "frontend", "lib", "api.ts"), "utf8");
        expect(api).not.toMatch(/openai/i);
    });
});
