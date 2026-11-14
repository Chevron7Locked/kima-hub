import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

/**
 * The backend's lint: the typescript-eslint recommended rules over every file in `src/` (the scheduler and every
 * enrichment job under `src/workers/` included), and one ruling of ours: Subsonic parameters are read in one place.
 *
 * Subsonic: a client may repeat any parameter, so `req.query.id` is a string or an array, and a cast hides which.
 * `one` and `many` in `src/utils/subsonicParams.ts` are the only readers; this refuses any `.query` read in the
 * Subsonic routes, their auth middleware and their reply helper.
 *
 * A name starting with `_` marks an argument, variable or caught error that is deliberately unused.
 */

const READ_THROUGH_THE_READER =
    "Read a Subsonic parameter with `one(req, name)` or `many(req, name)` from utils/subsonicParams.ts. " +
    "`req.query.x as string` hides a repeated parameter, which arrives as an array.";

const subsonicFiles = [
    "src/routes/subsonic/**/*.ts",
    "src/middleware/subsonicAuth.ts",
    "src/utils/subsonicResponse.ts",
];

export default defineConfig([
    globalIgnores(["dist/**", "node_modules/**", "prisma/**", "scripts/**"]),
    ...tseslint.configs.recommended.map((config) => ({ ...config, files: ["src/**/*.ts"] })),
    {
        files: ["src/**/*.ts"],
        rules: {
            "@typescript-eslint/no-unused-vars": [
                "error",
                {
                    argsIgnorePattern: "^_",
                    varsIgnorePattern: "^_",
                    caughtErrorsIgnorePattern: "^_",
                    destructuredArrayIgnorePattern: "^_",
                },
            ],
            // Not yet enforced outside the workers folder: about 540 `any` in the rest of src (see the workers block below).
            "@typescript-eslint/no-explicit-any": "off",
        },
    },
    {
        // The scheduler and every enrichment job: no `any`. A real exception carries its own disable and a reason.
        files: ["src/workers/**/*.ts"],
        ignores: ["**/__tests__/**"],
        rules: { "@typescript-eslint/no-explicit-any": "error" },
    },
    {
        // Tests build mocks: `any` is how a partial stand-in is typed, and `jest.mock` factories are hoisted above
        // imports, so they can only reach a helper with `require`.
        files: ["src/**/__tests__/**/*.ts"],
        rules: {
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-require-imports": "off",
        },
    },
    {
        files: subsonicFiles,
        ignores: ["**/__tests__/**"],
        languageOptions: { parser: tseslint.parser },
        rules: {
            "no-restricted-syntax": [
                "error",
                // Any `.query` read, so a cast, a non-null, an alias (`const r = req`) or `res.req.query` is caught too.
                {
                    selector: "MemberExpression[computed=false][property.name='query']",
                    message: READ_THROUGH_THE_READER,
                },
                {
                    selector: "MemberExpression[computed=true][property.value='query']",
                    message: READ_THROUGH_THE_READER,
                },
                // `({ query }) =>` and `const { query } = req`.
                {
                    selector: "ObjectPattern > Property[key.name='query']",
                    message: READ_THROUGH_THE_READER,
                },
            ],
        },
    },
]);
