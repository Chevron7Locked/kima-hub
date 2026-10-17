import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "..", "..");

function read(rel: string): string {
    return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

// This guard was added after the legacy OpenAI integration was removed.
// The AI playlist generation feature (PR #241) deliberately reintroduces
// provider support through a generic /v1/chat/completions client built on
// fetch. The remaining guarantee worth guarding: no direct openai SDK
// dependency in backend or frontend.
describe("AI provider integration stays SDK-free", () => {
    it("the backend has no openai package dependency", () => {
        expect(read("package.json")).not.toMatch(/"openai"\s*:/);
    });

    it("the frontend has no openai package dependency", () => {
        const pkg = fs.readFileSync(path.join(ROOT, "..", "frontend", "package.json"), "utf8");
        expect(pkg).not.toMatch(/"openai"\s*:/);
    });
});
