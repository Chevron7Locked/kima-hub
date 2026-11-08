import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
    test: {
        environment: "happy-dom",
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
