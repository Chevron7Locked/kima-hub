import { test, expect, type Page } from "@playwright/test";
import { loginAsTestUser, getAuthToken } from "./fixtures/test-helpers";

// Wipes enrichment data, re-enriches, and checks the library still works.
// Skips below 10 tracks. scripts/run-enrichment-memory-test.sh runs it with
// memory monitoring.

const POLL_INTERVAL_MS = 10_000;
const ENRICHMENT_TIMEOUT_MS = 45 * 60 * 1000;

type Step = { total: number; completed: number };
type EnrichmentProgress = {
    artists: Step;
    audioAnalysis: Step;
    clapEmbeddings: Step;
    moods: Step;
    similarity: Step;
    isFullyComplete: boolean;
};

/** Poll /api/enrichment/progress until every step, through moods and similarity, is complete again. */
async function waitForEnrichment(
    page: Page,
    token: string,
    timeoutMs: number,
): Promise<EnrichmentProgress> {
    const started = Date.now();
    let last: EnrichmentProgress | null = null;
    while (Date.now() - started < timeoutMs) {
        await page.waitForTimeout(POLL_INTERVAL_MS);
        const res = await page.request.get("/api/enrichment/progress", {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok()) continue;
        const p = (await res.json()) as EnrichmentProgress;
        last = p;
        console.log(
            `[${Math.round((Date.now() - started) / 1000)}s] artists=${p.artists.completed}/${p.artists.total} ` +
                `analysis=${p.audioAnalysis.completed}/${p.audioAnalysis.total} vectors=${p.clapEmbeddings.completed}/${p.clapEmbeddings.total} ` +
                `moods=${p.moods.completed}/${p.moods.total} similarity=${p.similarity.completed}/${p.similarity.total}`,
        );
        if (p.isFullyComplete) return p;
    }
    throw new Error(`Enrichment did not complete within ${timeoutMs / 60_000} minutes. Last progress: ${JSON.stringify(last)}`);
}

test.describe("Enrichment Cycle", () => {
    test.beforeEach(async ({ page }) => {
        await loginAsTestUser(page);
    });

    test("wipe and re-enrich: system is functional after full enrichment cycle", async ({ page }) => {
        test.setTimeout(55 * 60 * 1000);

        const token = await getAuthToken(page);

        const wipeRes = await page.request.post("/api/enrichment/wipe-and-rerun", {
            headers: { Authorization: `Bearer ${token}` },
        });
        expect(wipeRes.ok()).toBe(true);
        const wiped = (await wipeRes.json()) as { artists: number; tracks: number; vectors: number };

        if (wiped.tracks < 10) {
            test.skip(true, `Library too small (${wiped.tracks} tracks) -- skipping enrichment cycle (empty container)`);
            return;
        }
        console.log(`Wiped: ${wiped.tracks} tracks, ${wiped.artists} artists, ${wiped.vectors} sound vectors`);

        // The wipe sends every track back through the pipeline, so the progress is no longer complete.
        const afterWipe = (await (await page.request.get("/api/enrichment/progress", {
            headers: { Authorization: `Bearer ${token}` },
        })).json()) as EnrichmentProgress;
        expect(afterWipe.isFullyComplete).toBe(false);

        const finalProgress = await waitForEnrichment(page, token, ENRICHMENT_TIMEOUT_MS);

        // ---- Functional assertions after enrichment -------------------------

        // 1. At least 80% of tracks made it through analysis and sound vectors
        const analysed = finalProgress.audioAnalysis.completed / Math.max(1, finalProgress.audioAnalysis.total);
        const embedded = finalProgress.clapEmbeddings.completed / Math.max(1, finalProgress.clapEmbeddings.total);
        expect(analysed).toBeGreaterThanOrEqual(0.8);
        expect(embedded).toBeGreaterThanOrEqual(0.8);

        // 2. Vibe map should return embedded tracks
        const vibeRes = await page.request.get("/api/vibe/map", {
            headers: { Authorization: `Bearer ${token}` },
        });
        expect(vibeRes.ok()).toBe(true);
        const vibeData = (await vibeRes.json()) as { tracks: unknown[] };
        expect(Array.isArray(vibeData.tracks)).toBe(true);
        expect(vibeData.tracks.length).toBeGreaterThan(0);

        // 3. Vibe search returns the nearest tracks with no cut-off; probe several
        //    descriptors and require at least one to return results.
        const searchCandidates = ["rock", "pop", "electronic", "loud", "bright", "guitar", "fast", "sad", "piano"];
        let searchHit = false;
        for (const q of searchCandidates) {
            const r = await page.request.post("/api/vibe/search", {
                data: { query: q, limit: 3 },
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!r.ok()) continue;
            const d = (await r.json()) as { tracks: unknown[] };
            if (d.tracks.length > 0) { searchHit = true; break; }
        }
        expect(searchHit).toBe(true);

        // 4. Failure rate should be below 20%
        const failRes = await page.request.get("/api/enrichment/failures/counts", {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (failRes.ok()) {
            const fails = (await failRes.json()) as Record<string, number>;
            const totalFails = Object.values(fails).reduce((a, b) => a + b, 0);
            const failRate = totalFails / wiped.tracks;
            expect(failRate).toBeLessThan(0.2);
        }
    });
});
