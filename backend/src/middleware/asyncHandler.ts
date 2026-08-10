/**
 * Route a rejected async handler to Express's error pipeline.
 *
 * Express 4 does not do this. Given `async (req, res) => { throw x }` it calls
 * the handler, receives a promise, and discards it -- so the rejection becomes
 * an `unhandledRejection`, `errorHandler` never runs, and NO RESPONSE IS EVER
 * SENT. The request hangs until the client times out. Measured against this
 * repo's own express 4.18 rather than assumed:
 *
 *     app.get("/throws", async () => { throw new Error("boom") });
 *     app.use(errorHandler);
 *     -> UNHANDLED_REJECTION: boom
 *     -> request never answered
 *
 * That is worse than the local `try/catch` + `res.status(500)` blocks scattered
 * through the route files, which at least answer. So those blocks cannot simply
 * be deleted in favour of throwing: the throwing style only works if something
 * bridges the promise to `next()`. This is that bridge.
 *
 *     router.get("/thing", asyncHandler(async (req, res) => {
 *         const thing = await service.get(req.params.id);   // may throw
 *         res.json(thing);                                   // no try/catch
 *     }));
 *
 * A thrown `AppError` reaches `errorHandler` and becomes the status its
 * category maps to; anything else becomes a 500. Both are answers.
 *
 * `authed()` in types/authed-request.ts already does this for handlers behind
 * an auth guard, and is built on this function so there is one bridge rather
 * than two that can drift. Use `authed()` when the handler needs `req.user`,
 * this when it does not.
 *
 * Express 5 handles rejected handlers natively and makes this unnecessary.
 * Upgrading is the real fix; until then, every async route needs a wrapper.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";

type AsyncRouteHandler = (
    req: Request,
    res: Response,
    next: NextFunction
) => unknown;

export function asyncHandler(handler: AsyncRouteHandler): RequestHandler {
    return (req, res, next) => {
        // `Promise.resolve` rather than assuming the handler is async: a
        // synchronous handler passed through here still works, and a
        // synchronous THROW still propagates the way Express already handles
        // it. Wrapping is never wrong, so nobody has to decide.
        Promise.resolve(handler(req, res, next)).catch(next);
    };
}
