/**
 * `asyncHandler` -- the bridge from a rejected route handler to `next()`.
 *
 * The claim this wrapper exists for: without it, a rejected async handler in
 * express 4 sends NO RESPONSE AT ALL. That is the fact the whole route-hygiene
 * pass rests on -- the plan for it said "let errors reach errorHandler instead
 * of a local res.status(500)", which is right for express 5 and actively
 * harmful here, because deleting those try/catch blocks without a bridge turns
 * answered 500s into requests that hang until the client gives up.
 *
 * That negative claim is NOT asserted below, and the omission is deliberate
 * rather than an oversight. Jest fails any test that produces an unhandled
 * rejection -- correctly -- so the failure mode cannot be observed from inside
 * a test without either suppressing process-level handlers for the whole run or
 * asserting on Jest's own error. Both are worse than not testing it.
 *
 * It was measured directly instead, against this repo's express 4.18:
 *
 *     process.on("unhandledRejection", e => console.log("UNHANDLED:", e.message));
 *     const app = express();
 *     app.get("/throws", async () => { throw new Error("boom"); });
 *     app.use((err, _req, res, _next) => res.status(500).json({ handled: true }));
 *     // race the request against a 2.5s timer
 *
 *     -> UNHANDLED: boom
 *     -> OUTCOME: TIMEOUT - no response ever sent
 *
 * Re-run that if you ever want to check whether an express upgrade has made
 * this wrapper unnecessary. Everything below tests the wrapper itself.
 */

import express from "express";
import request from "supertest";
import { asyncHandler } from "../asyncHandler";

/** Stands in for the real errorHandler; same shape, no config dependency. */
function errorSink(
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
) {
    res.status(500).json({ reachedErrorHandler: true, message: err.message });
}

describe("asyncHandler bridges the rejection to next()", () => {
    it("reaches the error handler when the handler throws", async () => {
        const app = express();
        app.get(
            "/wrapped",
            asyncHandler(async () => {
                throw new Error("boom");
            })
        );
        app.use(errorSink);

        const res = await request(app).get("/wrapped");

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ reachedErrorHandler: true, message: "boom" });
    });

    it("reaches the error handler when the handler rejects rather than throws", async () => {
        const app = express();
        app.get(
            "/rejects",
            asyncHandler(() => Promise.reject(new Error("rejected")))
        );
        app.use(errorSink);

        const res = await request(app).get("/rejects");

        expect(res.body).toEqual({ reachedErrorHandler: true, message: "rejected" });
    });

    it("leaves a successful handler completely alone", async () => {
        const app = express();
        app.get(
            "/ok",
            asyncHandler(async (_req, res) => {
                res.status(201).json({ fine: true });
            })
        );
        app.use(errorSink);

        const res = await request(app).get("/ok");

        expect(res.status).toBe(201);
        expect(res.body).toEqual({ fine: true });
    });

    it("handles a SYNCHRONOUS handler, including one that throws", async () => {
        // Wrapping must never be the wrong choice, so that nobody has to decide
        // per-route whether a handler is async enough to need it.
        const app = express();
        app.get(
            "/sync-throws",
            asyncHandler(() => {
                throw new Error("sync boom");
            })
        );
        app.use(errorSink);

        const res = await request(app).get("/sync-throws");

        expect(res.body).toEqual({ reachedErrorHandler: true, message: "sync boom" });
    });

    it("does not swallow next() called by the handler itself", async () => {
        const app = express();
        app.get(
            "/passes-through",
            asyncHandler(async (_req, _res, next) => {
                next();
            }),
            (_req, res) => res.json({ secondHandlerRan: true })
        );
        app.use(errorSink);

        const res = await request(app).get("/passes-through");

        expect(res.body).toEqual({ secondHandlerRan: true });
    });
});
