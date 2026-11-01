import { combineAnalyzerStatus, heartbeatFresh } from "../utils/analyzerStatus";

describe("analyzer status", () => {
    it("names which analyzers are alive", () => {
        expect(combineAnalyzerStatus(true, true)).toBe("ok");
        expect(combineAnalyzerStatus(true, false)).toBe("analysis-only");
        expect(combineAnalyzerStatus(false, true)).toBe("embeddings-only");
        expect(combineAnalyzerStatus(false, false)).toBe("offline");
    });

    it("reads a heartbeat as fresh only within the window", () => {
        const now = 1_000_000;
        expect(heartbeatFresh(String(now - 1000), now, 120_000)).toBe(true);
        expect(heartbeatFresh(String(now - 121_000), now, 120_000)).toBe(false);
        expect(heartbeatFresh(null, now, 120_000)).toBe(false);
        expect(heartbeatFresh("garbage", now, 120_000)).toBe(false);
    });
});
