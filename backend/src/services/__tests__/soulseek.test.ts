import * as fs from "fs";
import * as path from "path";

describe("SoulseekService - Race Condition Fix", () => {
    describe("reconnection handling", () => {
        it("should have 100ms delay after forceDisconnect on empty search threshold", () => {
            const servicePath = path.join(__dirname, "../soulseek.ts");
            const content = fs.readFileSync(servicePath, "utf-8");

            const emptySearchPattern = /Too many consecutive empty searches.*\n[\s\S]*?this\.forceDisconnect\(\);[\s\S]*?await new Promise\(resolve => setTimeout\(resolve, 100\)\);/;
            expect(content).toMatch(emptySearchPattern);
        });

        it("should have 100ms delay after forceDisconnect on search error threshold", () => {
            const servicePath = path.join(__dirname, "../soulseek.ts");
            const content = fs.readFileSync(servicePath, "utf-8");

            const errorPattern = /consecutive search failures - forcing reconnect.*\n[\s\S]*?this\.forceDisconnect\(\);[\s\S]*?await new Promise\(resolve => setTimeout\(resolve, 100\)\);/;
            expect(content).toMatch(errorPattern);
        });

        it("should have exactly two reconnect delay points in the code", () => {
            const servicePath = path.join(__dirname, "../soulseek.ts");
            const content = fs.readFileSync(servicePath, "utf-8");

            const delayPattern = /await new Promise\(resolve => setTimeout\(resolve, 100\)\);/g;
            const matches = content.match(delayPattern);

            expect(matches).not.toBeNull();
            expect(matches?.length).toBe(2);
        });

        it("should only add delay when not a retry attempt", () => {
            const servicePath = path.join(__dirname, "../soulseek.ts");
            const content = fs.readFileSync(servicePath, "utf-8");

            const noRetryCheck = /if \(\s*!isRetry\s*&&\s*this\.consecutiveEmptySearches\s*>=\s*this\.MAX_CONSECUTIVE_EMPTY\s*\)/g;
            const matches = content.match(noRetryCheck);

            expect(matches).not.toBeNull();
            expect(matches?.length).toBe(2);
        });
    });

    describe("search result deduplication", () => {
        it("should have flattenSearchResults method", () => {
            const servicePath = path.join(__dirname, "../soulseek.ts");
            const content = fs.readFileSync(servicePath, "utf-8");

            // Check that flattenSearchResults method exists
            expect(content).toContain("flattenSearchResults");
            expect(content).toContain("const seen = new Set<string>");
        });

        it("should deduplicate by user:filename key", () => {
            const servicePath = path.join(__dirname, "../soulseek.ts");
            const content = fs.readFileSync(servicePath, "utf-8");

            // Check that deduplication uses user:filename pattern
            const dedupPattern = /const key = `\$\{.*username.*\}:\$\{.*filename.*\}`/;
            expect(content).toMatch(dedupPattern);
        });

        it("should call flattenSearchResults in searchTrack", () => {
            const servicePath = path.join(__dirname, "../soulseek.ts");
            const content = fs.readFileSync(servicePath, "utf-8");

            // Check that searchTrack uses the flattening method
            expect(content).toContain("this.flattenSearchResults(responses)");
        });
    });
});
