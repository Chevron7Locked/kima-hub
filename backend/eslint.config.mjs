import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

/**
 * The backend's lint holds one ruling, so far: Subsonic parameters are read in one place.
 *
 * A Subsonic client may repeat any parameter, so `req.query.id` is a string or an array, and a cast hides which.
 * `one` and `many` in `src/utils/subsonicParams.ts` are the only readers; this refuses a `req.query` read in the
 * Subsonic routes, their auth middleware and their reply helper.
 */

const READ_THROUGH_THE_READER =
    "Read a Subsonic parameter with `one(req, name)` or `many(req, name)` from utils/subsonicParams.ts. " +
    "`req.query.x as string` hides a repeated parameter, which arrives as an array.";

const REQUEST = "/^req(uest)?$/";

const subsonicFiles = [
    "src/routes/subsonic/**/*.ts",
    "src/middleware/subsonicAuth.ts",
    "src/utils/subsonicResponse.ts",
];

export default defineConfig([
    globalIgnores(["dist/**", "node_modules/**", "prisma/**", "scripts/**"]),
    {
        files: subsonicFiles,
        ignores: ["**/__tests__/**"],
        languageOptions: { parser: tseslint.parser },
        rules: {
            "no-restricted-syntax": [
                "error",
                {
                    selector: `MemberExpression[computed=false][object.name=${REQUEST}][property.name='query']`,
                    message: READ_THROUGH_THE_READER,
                },
                {
                    selector: `MemberExpression[computed=true][object.name=${REQUEST}][property.value='query']`,
                    message: READ_THROUGH_THE_READER,
                },
                {
                    selector: `VariableDeclarator[init.name=${REQUEST}] > ObjectPattern > Property[key.name='query']`,
                    message: READ_THROUGH_THE_READER,
                },
            ],
        },
    },
]);
