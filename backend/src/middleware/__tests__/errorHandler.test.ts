/**
 * What a thrown error becomes on the wire: `UserFacingError` keeps its
 * statusCode, `ZodError` becomes 400, and `AppError` maps its category.
 * `config` is mocked so the env loader's validation stays out of it.
 */

import express from "express";
import request from "supertest";
import { z } from "zod";

const mockConfig = { nodeEnv: "production" as string };
jest.mock("../../config", () => ({
    get config() {
        return mockConfig;
    },
}));

import { errorHandler } from "../errorHandler";
import { asyncHandler } from "../asyncHandler";
import { AppError, ErrorCategory, ErrorCode, UserFacingError } from "../../utils/errors";
import { logger } from "../../utils/logger";

/** An app whose single route throws whatever the test hands it. */
function appThrowing(err: Error) {
    const app = express();
    app.get(
        "/boom",
        asyncHandler(async () => {
            throw err;
        })
    );
    app.use(errorHandler);
    return app;
}

beforeEach(() => {
    mockConfig.nodeEnv = "production";
});

describe("UserFacingError carries its own status to the client", () => {
    it("answers 404 with the message, rather than 500 with it hidden", async () => {
        const res = await request(appThrowing(new UserFacingError("Album not found", 404))).get(
            "/boom"
        );

        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: "Album not found" });
    });

    it.each([
        [400, "Bad query"],
        [401, "Not signed in"],
        [403, "Not yours"],
        [410, "Share link expired"],
    ])("answers %i, a status AppError cannot express", async (status, message) => {
        const res = await request(appThrowing(new UserFacingError(message, status))).get("/boom");

        expect(res.status).toBe(status);
        expect(res.body).toEqual({ error: message });
    });

    it("defaults to 400 when no status is given", async () => {
        const res = await request(appThrowing(new UserFacingError("Bad input"))).get("/boom");

        expect(res.status).toBe(400);
    });

    it("includes the code only when one was set", async () => {
        const withCode = await request(
            appThrowing(new UserFacingError("Gone", 410, "SHARE_EXPIRED"))
        ).get("/boom");
        expect(withCode.body).toEqual({ error: "Gone", code: "SHARE_EXPIRED" });

        const withoutCode = await request(appThrowing(new UserFacingError("Gone", 410))).get(
            "/boom"
        );
        expect(withoutCode.body).toEqual({ error: "Gone" });
    });

    it("shows its message in PRODUCTION -- that is what user-facing means", async () => {
        mockConfig.nodeEnv = "production";

        const res = await request(appThrowing(new UserFacingError("Album not found", 404))).get(
            "/boom"
        );

        expect(res.body.error).toBe("Album not found");
        expect(res.body.error).not.toBe("Internal server error");
    });
});

describe("an error after the response started cannot be answered", () => {
    it("does not throw ERR_HTTP_HEADERS_SENT trying to set a status", async () => {
        // The streaming routes' real failure mode: a 200 and some bytes are
        // already out when the underlying read dies.
        const app = express();
        app.get(
            "/half-sent",
            asyncHandler(async (_req, res) => {
                res.status(200);
                res.write("first chunk");
                throw new Error("stream died mid-transfer");
            })
        );
        app.use(errorHandler);

        const spy = jest.spyOn(logger, "error").mockImplementation(() => {});

        // Express's default handler closes the connection, so supertest sees the
        // socket hang up rather than a body. Either outcome is acceptable; what
        // must NOT happen is errorHandler throwing while trying to set a status.
        await request(app)
            .get("/half-sent")
            .catch(() => undefined);

        expect(spy).toHaveBeenCalledWith(
            expect.stringContaining("Error after response started"),
            "stream died mid-transfer"
        );

        spy.mockRestore();
    });

    it("still answers normally when nothing has been written yet", async () => {
        const res = await request(appThrowing(new UserFacingError("Track not found", 404))).get(
            "/boom"
        );

        expect(res.status).toBe(404);
    });
});

describe("a failed Zod parse is the client's fault, not the server's", () => {
    const schema = z.object({ trackId: z.string(), ms: z.number().int() });

    it("answers 400 with a plain message and no issues, rather than 500", async () => {
        let thrown: Error;
        try {
            schema.parse({ trackId: 123, ms: "nope" });
            throw new Error("schema should have rejected this");
        } catch (e) {
            thrown = e as Error;
        }

        const res = await request(appThrowing(thrown!)).get("/boom");

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: "Invalid request" });
    });

    it("says nothing of the fields in development either, and logs them", async () => {
        mockConfig.nodeEnv = "development";
        const warn = jest.spyOn(logger, "warn").mockImplementation(() => {});
        let thrown: Error;
        try {
            schema.parse({ trackId: 1, ms: 1 });
            throw new Error("schema should have rejected this");
        } catch (e) {
            thrown = e as Error;
        }

        const res = await request(appThrowing(thrown!)).get("/boom");
        const lines = warn.mock.calls.map((call) => String(call[0]));
        warn.mockRestore();

        expect(res.body).toEqual({ error: "Invalid request" });
        expect(lines.some((line) => line.includes("/boom") && line.includes("trackId"))).toBe(true);
    });

    it("says so in production too: which field was wrong goes to the log, never to the caller", async () => {
        mockConfig.nodeEnv = "production";

        let thrown: Error;
        try {
            schema.parse({});
            throw new Error("schema should have rejected this");
        } catch (e) {
            thrown = e as Error;
        }

        const res = await request(appThrowing(thrown!)).get("/boom");

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: "Invalid request" });
    });
});

describe("AppError categories and plain Errors", () => {
    it("maps AppError categories to 400 / 503 / 500", async () => {
        const cases: Array<[ErrorCategory, number]> = [
            [ErrorCategory.RECOVERABLE, 400],
            [ErrorCategory.TRANSIENT, 503],
            [ErrorCategory.FATAL, 500],
        ];

        for (const [category, expected] of cases) {
            const res = await request(
                appThrowing(new AppError(ErrorCode.DB_QUERY_ERROR, category, "nope"))
            ).get("/boom");

            expect(res.status).toBe(expected);
            expect(res.body).toMatchObject({ error: "nope", code: ErrorCode.DB_QUERY_ERROR });
        }
    });

    it("still hides a plain Error behind a generic 500 in production", async () => {
        const res = await request(appThrowing(new Error("connection string leaked here"))).get(
            "/boom"
        );

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: "Internal server error" });
    });

    it("still reveals a plain Error in development", async () => {
        mockConfig.nodeEnv = "development";

        const res = await request(appThrowing(new Error("boom"))).get("/boom");

        expect(res.status).toBe(500);
        expect(res.body.error).toBe("boom");
        expect(res.body.stack).toBeDefined();
    });

    it("does not treat a plain Error with a statusCode property as user-facing", async () => {
        // Guards the branch against being widened to duck-typing later: only the
        // real class is trusted to have a client-safe message.
        const impostor = Object.assign(new Error("internal detail"), { statusCode: 404 });

        const res = await request(appThrowing(impostor)).get("/boom");

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: "Internal server error" });
    });
});
