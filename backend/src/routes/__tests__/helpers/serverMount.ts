import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import { mountRoute } from "../../access";
import { mountAccess } from "../../mountAccess";

export interface MountOptions {
    /**
     * The test stands in for the signed-in person. The sign-in guards let every request through, as the user the
     * request already carries (the test's own middleware set it) or, if it carries none, as this one. The admin
     * guard stays real, so an admin route still reads the role. "preset" signs in only a request that already
     * carries a user, and answers 401 to the rest, as the real guard does for a request with no session.
     */
    standIn?: { id: string; username?: string; role?: "user" | "admin" } | true | "preset";
}

const DEFAULT_STAND_IN = { id: "stand-in", username: "stand-in", role: "admin" } as const;

/**
 * A route test's `middleware/auth` mock names the one guard its router used to carry, and the mount may need
 * another, so a missing one is filled from the other of the pair that sign a person in. An unmocked module has both.
 */
function fillSignInGuards(): void {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const auth = require("../../../middleware/auth") as Record<string, unknown>;
    auth.requireAuth ??= auth.requireAuthOrToken;
    auth.requireAuthOrToken ??= auth.requireAuth;
}

/** Replaces the sign-in guards of the module registry this test runs in: no session is needed, the stand-in signs in. */
function standInFor(user: NonNullable<MountOptions["standIn"]>): void {
    const person = user === true || user === "preset" ? DEFAULT_STAND_IN : user;
    const signIn = (req: Request, res: Response, next: NextFunction) => {
        if (user === "preset") {
            if (req.user) next();
            else res.status(401).json({ error: "Not authenticated" });
            return;
        }
        req.user ??= { username: person.id, role: "user", ...person } as Request["user"];
        next();
    };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const auth = require("../../../middleware/auth") as Record<string, unknown>;
    auth.requireAuth = signIn;
    auth.requireAuthOrToken = signIn;
}

/**
 * `router` mounted at `prefix` with the access the server declares for `serverPath` ("/api/podcasts"), so a route
 * test is signed in, or refused, the way the server does it. The routers carry no guards of their own. Pass the
 * router of a sub-module (a library router) with the server path of the mount it sits under. No runaway limit.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mountAsServer<T extends { use: (...args: any[]) => unknown }>(
    app: T,
    prefix: string,
    router: RequestHandler,
    serverPath: string,
    options: MountOptions = {},
): T {
    const declared = mountAccess[serverPath];
    if (!declared) throw new Error(`No access is declared for ${serverPath}`);
    if (options.standIn) standInFor(options.standIn);
    else fillSignInGuards();
    mountRoute(app as unknown as Express, { path: prefix, router, access: declared.access });
    return app;
}
