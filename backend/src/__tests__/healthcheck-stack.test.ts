export {};

// The all-in-one container's health verdict (backend/healthcheck-stack.js).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { decide, clapRequired } = require("../../healthcheck-stack.js");

const web = { status: 200 };
const backendOk = (analyzers: string) => ({
    status: 200,
    body: { status: "ok", db: "ok", redis: "ok", analyzers, lidarr: "error", embeddingWritePath: "error" },
});

describe("container health verdict", () => {
    it("is healthy when web, backend and both analyzers are up, whatever Lidarr and the embedding write path say", () => {
        expect(decide({ web, backend: backendOk("ok"), clap: true })).toEqual({ healthy: true });
    });

    it("accepts a redirect from the web app", () => {
        expect(decide({ web: { status: 307 }, backend: backendOk("ok"), clap: true }).healthy).toBe(true);
    });

    it("fails when the web app does not answer or errors", () => {
        expect(decide({ web: { status: null, error: "ECONNREFUSED" }, backend: backendOk("ok"), clap: true })).toEqual({
            healthy: false,
            reason: "web: no answer (ECONNREFUSED)",
        });
        expect(decide({ web: { status: 500 }, backend: backendOk("ok"), clap: true }).reason).toBe("web: 500");
    });

    it("fails when the backend does not answer", () => {
        const r = decide({ web, backend: { status: null, error: "ECONNREFUSED" }, clap: true });
        expect(r).toEqual({ healthy: false, reason: "backend: no answer (ECONNREFUSED)" });
    });

    it("names the broken part when the backend reports 503", () => {
        const backend = { status: 503, body: { status: "degraded", db: "ok", redis: "error", analyzers: "ok" } };
        expect(decide({ web, backend, clap: true }).reason).toBe("backend: 503 redis error");
        const both = { status: 503, body: { db: "error", redis: "error" } };
        expect(decide({ web, backend: both, clap: true }).reason).toBe("backend: 503 db error, redis error");
        expect(decide({ web, backend: { status: 503, body: null }, clap: true }).reason).toBe("backend: 503");
    });

    it("fails on a 200 with an unreadable body", () => {
        expect(decide({ web, backend: { status: 200, body: null }, clap: true }).reason).toBe(
            "backend: 200 but unreadable reply"
        );
    });

    it("requires both analyzers when CLAP is configured", () => {
        expect(decide({ web, backend: backendOk("analysis-only"), clap: true }).reason).toBe(
            "analyzers: clap-analyzer down"
        );
        expect(decide({ web, backend: backendOk("embeddings-only"), clap: true }).reason).toBe(
            "analyzers: audio-analyzer down"
        );
        expect(decide({ web, backend: backendOk("offline"), clap: true }).reason).toBe(
            "analyzers: audio-analyzer and clap-analyzer down"
        );
    });

    it("needs only the MusiCNN analyzer when CLAP is disabled", () => {
        expect(decide({ web, backend: backendOk("analysis-only"), clap: false }).healthy).toBe(true);
        expect(decide({ web, backend: backendOk("embeddings-only"), clap: false }).reason).toBe(
            "analyzers: audio-analyzer down"
        );
        expect(decide({ web, backend: backendOk("offline"), clap: false }).reason).toBe("analyzers: audio-analyzer down");
    });

    it("fails when the analyzer status is unknown or missing", () => {
        expect(decide({ web, backend: backendOk("unknown"), clap: true }).reason).toBe("analyzers: status unknown");
        const noField = { status: 200, body: { db: "ok", redis: "ok" } };
        expect(decide({ web, backend: noField, clap: true }).reason).toBe("analyzers: status missing");
    });

    it("reads DISABLE_CLAP the way start.sh does", () => {
        expect(clapRequired({})).toBe(true);
        expect(clapRequired({ DISABLE_CLAP: "" })).toBe(true);
        expect(clapRequired({ DISABLE_CLAP: "false" })).toBe(true);
        expect(clapRequired({ DISABLE_CLAP: "true" })).toBe(false);
        expect(clapRequired({ DISABLE_CLAP: "1" })).toBe(false);
    });
});
