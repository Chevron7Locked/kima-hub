import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import { mountRoute } from "../../access";
import { mountAccess } from "../../mountAccess";

export interface ServerMountOptions {
    /**
     * The test stands in for the signed-in person. The sign-in checks let every request through, as the user the
     * request already carries (the test's own middleware set it) or, if it carries none, as this one. The admin
     * check stays real, so an admin route still reads the role. "preset" signs in only a request that already
     * carries a user, and answers 401 to the rest, as the real check does for a request with no session.
     */
    standIn?: true | "preset";
}

const STAND_IN = { id: "stand-in", username: "stand-in", role: "admin" } as const;

/**
 * A route test's `middleware/auth` mock names the one check its router used to carry, and the mount may need
 * another, so a missing one is filled from the other of the pair that sign a person in. An unmocked module has both.
 */
function fillSignInChecks(): void {
     
    const auth = require("../../../middleware/auth") as Record<string, unknown>;
    auth.requireAuth ??= auth.requireAuthOrToken;
    auth.requireAuthOrToken ??= auth.requireAuth;
}

/** Replaces the sign-in checks of the module registry this test runs in: no session is needed, the stand-in signs in. */
function standInFor(user: NonNullable<ServerMountOptions["standIn"]>): void {
    const signIn = (req: Request, res: Response, next: NextFunction) => {
        if (user === "preset") {
            if (req.user) next();
            else res.status(401).json({ error: "Not authenticated" });
            return;
        }
        req.user ??= STAND_IN as Request["user"];
        next();
    };
     
    const auth = require("../../../middleware/auth") as Record<string, unknown>;
    auth.requireAuth = signIn;
    auth.requireAuthOrToken = signIn;
}

/**
 * `router` mounted at `prefix` with the access the server declares for `serverPath` ("/api/podcasts"), so a route
 * test is signed in, or refused, the way the server does it. The routers carry no access checks of their own. Pass the
 * router of a library router with the server path of the mount it sits under. No runaway limit.
 */
 
export function mountAsServer<T extends { use: (...args: any[]) => unknown }>(
    app: T,
    prefix: string,
    router: RequestHandler,
    serverPath: string,
    options: ServerMountOptions = {},
): T {
    const declared = mountAccess[serverPath];
    if (!declared) throw new Error(`No access is declared for ${serverPath}`);
    if (options.standIn) standInFor(options.standIn);
    else fillSignInChecks();
    mountRoute(app as unknown as Express, { path: prefix, router, access: declared.access, largeJsonBody: declared.largeJsonBody });
    return app;
}
