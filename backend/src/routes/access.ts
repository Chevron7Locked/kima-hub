/**
 * Who may reach a route is declared where the route is mounted, and a mount that declares nothing refuses
 * everything. The routers carry no access checks of their own.
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
 * their own module can check, so the router keeps that check; the family still has to be declared. A router still
 * checks who the person is for what a route does (an acquire permission, whose item it is), never whether they may
 * reach the route.
 */

import { Router, type Express, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { requireAdmin, requireAuth, requireAuthOrToken } from "../middleware/auth";
import { ACCESS_PASSED, apiLimiter, isUncountedPath } from "../middleware/rateLimiter";
import { largeJsonBody } from "../middleware/jsonBody";
import { logger } from "../utils/logger";

export type AccessFamily = "public" | "signed-in" | "admin" | "internal" | "webhook" | "share-token" | "subsonic";

export interface Access {
    family: AccessFamily;
    /**
     * `signed-in` and `admin`: a token in the query string counts, as it does on streaming URLs. `true` for every
     * route of the mount, or the routes ("METHOD /path" as the router writes it) that take one; the rest want a
     * session, key or header.
     */
    urlToken?: boolean | string[];
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
    /**
     * The mount reads JSON bodies up to 5 MB, after its access check (the server's parser, which skips this mount's
     * path, reads 1 MB for everything else). Only a mount that checks access here can have it.
     */
    largeJsonBody?: boolean;
}

function signedInCheck(urlToken: boolean): RequestHandler {
    return urlToken ? requireAuthOrToken : requireAuth;
}

/** The checks that run in front of a route of this family. */
function checksFor(family: AccessFamily, urlToken: boolean): RequestHandler[] {
    switch (family) {
        case "signed-in":
            return [signedInCheck(urlToken)];
        case "admin":
            return [signedInCheck(urlToken), requireAdmin];
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

/** What a mount declares for one route. */
export interface Declared {
    family: AccessFamily;
    /** A token in the query string counts on this route. */
    urlToken: boolean;
}

/** A lookup over route keys, matched by Express's own router so it answers as the real router would. */
function routeTable(keys: string[]): (method: string, url: string) => Promise<string | undefined> {
    const table = Router();
    for (const key of keys) {
        const { method, path } = parseRouteKey(key);
        (table as unknown as Record<string, (path: string, handler: RequestHandler) => void>)[method.toLowerCase()](
            path,
            (req, _res, next) => {
                (req as Request & { matchedKey?: string }).matchedKey = key;
                next("router");
            },
        );
    }

    return (method, url) =>
        new Promise((resolve) => {
            const stub = { method, url, headers: {} } as unknown as Request & { matchedKey?: string };
            const finish = () => resolve(stub.matchedKey);
            // A stray OPTIONS makes the router answer for itself; the answer is not ours to send.
            const res = { setHeader() {}, getHeader() {}, end: finish } as unknown as Response;
            (table as unknown as { handle: (req: Request, res: Response, done: () => void) => void }).handle(
                stub,
                res,
                finish,
            );
        });
}

/**
 * What a request path under a mount is declared as: an entry of `routes` when one matches, else the mount's family;
 * and whether a query-string token counts there.
 */
export function declaredResolver(access: Access): (method: string, url: string) => Promise<Declared> {
    const overrides = access.routes ?? {};
    const byFamily = Object.keys(overrides).length > 0 ? routeTable(Object.keys(overrides)) : null;
    const tokenRoutes = Array.isArray(access.urlToken) ? routeTable(access.urlToken) : null;
    const allTokens = access.urlToken === true;

    return async (method, url) => {
        const key = byFamily ? await byFamily(method, url) : undefined;
        return {
            family: key ? overrides[key] : access.family,
            urlToken: allTokens || (tokenRoutes ? (await tokenRoutes(method, url)) !== undefined : false),
        };
    };
}

/** Runs handlers one after another; stops at the first that answers, and passes a throw to `next`. */
async function runInOrder(handlers: RequestHandler[], req: Request, res: Response, next: NextFunction): Promise<void> {
    for (const handler of handlers) {
        const outcome = await new Promise<{ passed: boolean; error?: unknown }>((resolve) => {
            // A check that answered the request never calls next, and its promise ends the wait.
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

/** A stand-in response that swallows whatever a check says, so a check can be asked its verdict and not answer. */
function silentResponse(real: Response): Response {
    const silent: Response = new Proxy({} as Response, {
        // `res.status(401).json(...)` is a chain of calls that all land here. It is not a promise: a check returns it.
        get: (_target, name) => (name === "locals" ? real.locals : name === "then" ? undefined : () => silent),
    });
    return silent;
}

/** Whether every check passes for this request, without anything being sent. A refusal or an error is a no. */
async function passes(checks: RequestHandler[], req: Request, res: Response): Promise<boolean> {
    let passed = false;
    await runInOrder(checks, req, silentResponse(res), (error?: unknown) => {
        passed = error === undefined;
    });
    return passed;
}

/**
 * In front of the runaway limit, for the addresses it does not count (streams, polling): asks the access check first
 * and tells the limit whether it passed. A request the check refuses is not exempt, so it is counted.
 */
function settleUncounted(access: Access): RequestHandler {
    const declared = declaredResolver(access);
    return async (req, res, next) => {
        if (!isUncountedPath(req.baseUrl + req.path)) return next();
        try {
            const { family, urlToken } = await declared(req.method, req.url);
            if (await passes(checksFor(family, urlToken), req, res)) res.locals[ACCESS_PASSED] = true;
        } catch (error) {
            return next(error);
        }
        next();
    };
}

function accessCheck(access: Access): RequestHandler {
    const declared = declaredResolver(access);
    return async (req, res, next) => {
        // Already passed in front of the runaway limit.
        if (res.locals[ACCESS_PASSED] === true) return next();
        const { family, urlToken } = await declared(req.method, req.url);
        return runInOrder(checksFor(family, urlToken), req, res, next);
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
    /** A token in the query string counts on this route. */
    urlToken: boolean;
}

interface StackLayer {
    name: string;
    route?: { path: string | string[]; methods: Record<string, boolean>; stack: Array<{ name: string }> };
    handle: { stack?: StackLayer[] };
    regexp: { fast_slash?: boolean };
}

/** A concrete address for a route path, so the resolver can match it: parameters become "x", a pattern written after one included. */
function concretePath(path: string): string {
    return path.replace(/:[A-Za-z0-9_]+(\([^)]*\))?\??/g, "x").replace(/\*/g, "x") || "/";
}

type RouteInRouter = Pick<RouteListing, "method" | "path">;

function collectRoutes(stack: StackLayer[]): Array<RouteInRouter> {
    const found: Array<RouteInRouter> = [];
    for (const layer of stack) {
        if (layer.route) {
            const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
            const methods = layer.route.methods._all
                ? ["ALL"]
                : Object.keys(layer.route.methods).filter((m) => layer.route!.methods[m]).map((m) => m.toUpperCase());
            for (const path of paths) for (const method of methods) found.push({ method, path });
        } else if (layer.name === "router" && layer.handle.stack) {
            // Sub-routers here are all mounted at "/"; one at another prefix has to be listed by hand.
            if (!layer.regexp.fast_slash) throw new Error("A sub-router mounted at a path cannot be listed");
            found.push(...collectRoutes(layer.handle.stack));
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
        const declaredOf = mount.access ? declaredResolver(mount.access) : null;
        for (const route of collectRoutes(stack)) {
            const declared = declaredOf
                ? await declaredOf(route.method === "ALL" ? "GET" : route.method, concretePath(route.path))
                : null;
            listing.push({ mount: mount.path, family: declared?.family ?? null, urlToken: declared?.urlToken ?? false, ...route });
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
    if (mount.runawayLimit) handlers.push(settleUncounted(mount.access), apiLimiter);
    // A mount of one family that the router checks itself needs nothing in front of it.
    const checksAccess =
        mount.access.family === "signed-in" || mount.access.family === "admin" || Boolean(mount.access.routes);
    if (checksAccess) handlers.push(accessCheck(mount.access));
    if (mount.largeJsonBody) {
        if (!checksAccess) throw new Error(`${mount.path} reads a large body, so it must check access in front of it`);
        handlers.push(largeJsonBody);
    }
    app.use(mount.path, ...handlers, mount.router);
}
