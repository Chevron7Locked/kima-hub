/**
 * Who may reach a route is declared where the route is mounted, and a mount that declares nothing refuses
 * everything.
 *
 * A mount names one family for all of its routes. A route that differs from its mount lists itself in `routes`
 * ("GET /:id/cover" as the router writes it, relative to the mount). The families:
 *
 *   public       answers without a session (sign-in, health, the audiobook cover)
 *   signed-in    a session, app key or token; `urlToken` also takes the token streaming URLs carry in `?token=`
 *   admin        signed in, and an admin
 *   internal     a machine caller holding the server's own secret (the analyzers, the public vibe feed)
 *   webhook      Lidarr, which the router checks against its configured webhook secret
 *   share-token  a stranger holding a share link; the router resolves the token
 *   subsonic     a Subsonic client, which the router signs in itself
 *
 * `signed-in` and `admin` are enforced here, in front of the router. The other families name a credential that only
 * their own module can check, so the router keeps that check; the family still has to be declared.
 */

import { Router, type Express, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { requireAdmin, requireAuth, requireAuthOrToken } from "../middleware/auth";
import { apiLimiter } from "../middleware/rateLimiter";
import { logger } from "../utils/logger";

export type AccessFamily = "public" | "signed-in" | "admin" | "internal" | "webhook" | "share-token" | "subsonic";

export interface Access {
    family: AccessFamily;
    /** `signed-in` and `admin`: a token in the query string counts, as it does on streaming URLs. */
    urlToken?: boolean;
    /** Routes whose family differs from the mount's: "METHOD /path" exactly as the router writes it. */
    routes?: Record<string, AccessFamily>;
}

export interface Mount {
    path: string;
    router: RequestHandler;
    /** A mount with no access refuses every request. */
    access?: Access;
    /** The per-address runaway limit, in front of the access check. */
    runawayLimit?: boolean;
}

function signedInGuard(urlToken: boolean | undefined): RequestHandler {
    return urlToken ? requireAuthOrToken : requireAuth;
}

/** The guards that run in front of a route of this family. */
function guardsFor(family: AccessFamily, urlToken: boolean | undefined): RequestHandler[] {
    switch (family) {
        case "signed-in":
            return [signedInGuard(urlToken)];
        case "admin":
            return [signedInGuard(urlToken), requireAdmin];
        default:
            return [];
    }
}

/** Splits "GET /:id/cover" into its method and path. */
export function parseRouteKey(key: string): { method: string; path: string } {
    const match = /^([A-Z]+) (\/.*)$/.exec(key);
    if (!match) throw new Error(`Access route "${key}" must read "METHOD /path"`);
    return { method: match[1], path: match[2] };
}

/**
 * The family of a request path under a mount: an entry of `routes` when one matches, matched by Express's own router
 * so it answers as the real router would, else the mount's family.
 */
export function familyResolver(access: Access): (method: string, url: string) => Promise<AccessFamily> {
    const entries = Object.entries(access.routes ?? {});
    if (entries.length === 0) return async () => access.family;

    const table = Router();
    for (const [key, family] of entries) {
        const { method, path } = parseRouteKey(key);
        (table as unknown as Record<string, (path: string, handler: RequestHandler) => void>)[method.toLowerCase()](
            path,
            (req, _res, next) => {
                (req as Request & { declaredFamily?: AccessFamily }).declaredFamily = family;
                next("router");
            },
        );
    }

    return (method, url) =>
        new Promise((resolve) => {
            const stub = { method, url, headers: {} } as unknown as Request & { declaredFamily?: AccessFamily };
            const finish = () => resolve(stub.declaredFamily ?? access.family);
            // A stray OPTIONS makes the router answer for itself; the answer is not ours to send.
            const res = { setHeader() {}, getHeader() {}, end: finish } as unknown as Response;
            (table as unknown as { handle: (req: Request, res: Response, done: () => void) => void }).handle(
                stub,
                res,
                finish,
            );
        });
}

/** Runs handlers one after another; stops at the first that answers, and passes a throw to `next`. */
async function runInOrder(handlers: RequestHandler[], req: Request, res: Response, next: NextFunction): Promise<void> {
    for (const handler of handlers) {
        const outcome = await new Promise<{ passed: boolean; error?: unknown }>((resolve) => {
            // A guard that answered the request never calls next, and its promise ends the wait.
            Promise.resolve()
                .then(() => handler(req, res, (error?: unknown) => resolve({ passed: error === undefined, error })))
                .then(
                    () => resolve({ passed: false }),
                    (error) => resolve({ passed: false, error }),
                );
        });
        if (outcome.error !== undefined) return next(outcome.error);
        if (!outcome.passed) return;
    }
    next();
}

function accessCheck(access: Access): RequestHandler {
    if (!access.routes || Object.keys(access.routes).length === 0) {
        return (req, res, next) => runInOrder(guardsFor(access.family, access.urlToken), req, res, next);
    }
    const familyOf = familyResolver(access);
    return async (req, res, next) => {
        const family = await familyOf(req.method, req.url);
        return runInOrder(guardsFor(family, access.urlToken), req, res, next);
    };
}

/** One route of a mounted router and the family its mount declares for it. */
export interface RouteListing {
    mount: string;
    /** Upper case; "ALL" for a route that answers every method. */
    method: string;
    /** As the router writes it, relative to the mount. */
    path: string;
    /** Null when the mount declares no access, which is when it refuses. */
    family: AccessFamily | null;
    /** A `requireAdmin` runs in front of the route inside its router. */
    adminInRouter: boolean;
}

interface StackLayer {
    name: string;
    route?: { path: string | string[]; methods: Record<string, boolean>; stack: Array<{ name: string }> };
    handle: { stack?: StackLayer[] };
    regexp: { fast_slash?: boolean };
}

/** A concrete address for a route path, so the resolver can match it: parameters become "x". */
function concretePath(path: string): string {
    return path.replace(/:[A-Za-z0-9_]+\??/g, "x").replace(/\*/g, "x") || "/";
}

type RouteInRouter = Omit<RouteListing, "mount" | "family">;

function collectRoutes(stack: StackLayer[], inheritedAdmin: boolean): Array<RouteInRouter> {
    const found: Array<RouteInRouter> = [];
    let adminInRouter = inheritedAdmin;
    for (const layer of stack) {
        if (layer.route) {
            const names = layer.route.stack.map((entry) => entry.name);
            const admin = adminInRouter || names.includes("requireAdmin");
            const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
            const methods = layer.route.methods._all
                ? ["ALL"]
                : Object.keys(layer.route.methods).filter((m) => layer.route!.methods[m]).map((m) => m.toUpperCase());
            for (const path of paths) for (const method of methods) found.push({ method, path, adminInRouter: admin });
        } else if (layer.name === "router" && layer.handle.stack) {
            // Sub-routers here are all mounted at "/"; one at another prefix has to be listed by hand.
            if (!layer.regexp.fast_slash) throw new Error("A sub-router mounted at a path cannot be listed");
            found.push(...collectRoutes(layer.handle.stack, adminInRouter));
        } else if (layer.name === "requireAdmin") {
            adminInRouter = true;
        }
    }
    return found;
}

/**
 * Every route of every mount with the family its mount declares for it. This is what the route-listing test reads,
 * so a mount that loses its declaration, or an override that no longer names a route, shows up there.
 */
export async function listRoutes(mounts: Mount[]): Promise<RouteListing[]> {
    const listing: RouteListing[] = [];
    for (const mount of mounts) {
        const stack = (mount.router as unknown as { stack?: StackLayer[] }).stack;
        if (!stack) throw new Error(`${mount.path} is not a router, so its routes cannot be listed`);
        const familyOf = mount.access ? familyResolver(mount.access) : null;
        for (const route of collectRoutes(stack, false)) {
            const family = familyOf ? await familyOf(route.method === "ALL" ? "GET" : route.method, concretePath(route.path)) : null;
            listing.push({ mount: mount.path, family, ...route });
        }
    }
    return listing;
}

function refuseUndeclared(path: string): RequestHandler {
    return (_req, res) => {
        res.status(403).json({ error: `No access is declared for ${path}` });
    };
}

/** The one way a router is mounted: its limit, then its access check, then the router. */
export function mountRoute(app: Express, mount: Mount): void {
    if (!mount.access) {
        logger.error(`[ACCESS] ${mount.path} declares no access; it refuses every request`);
        app.use(mount.path, refuseUndeclared(mount.path));
        return;
    }
    const handlers: RequestHandler[] = [];
    if (mount.runawayLimit) handlers.push(apiLimiter);
    if (guardsFor(mount.access.family, mount.access.urlToken).length > 0 || mount.access.routes) {
        handlers.push(accessCheck(mount.access));
    }
    app.use(mount.path, ...handlers, mount.router);
}
