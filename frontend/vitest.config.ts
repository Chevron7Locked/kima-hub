import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
    test: {
        environment: "happy-dom",
        // Node 25+ has its own `localStorage` global that hides happy-dom's and throws
        // without a backing file. Off, the tests see the browser one on every Node.
        execArgv: ["--no-experimental-webstorage"],
        include: [
            "lib/__tests__/**/*.test.{ts,tsx}",
            "hooks/__tests__/**/*.test.{ts,tsx}",
            "components/**/__tests__/**/*.test.{ts,tsx}",
            "tests/unit/**/*.test.ts",
        ],
    },
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "."),
        },
    },
});
