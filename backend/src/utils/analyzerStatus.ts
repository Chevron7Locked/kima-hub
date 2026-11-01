export type AnalyzerStatus = "ok" | "analysis-only" | "embeddings-only" | "offline";

/** How the health reply names the two analyzers, from whether each is alive (its connection or a fresh heartbeat). */
export function combineAnalyzerStatus(analysisAlive: boolean, embeddingsAlive: boolean): AnalyzerStatus {
    if (analysisAlive) return embeddingsAlive ? "ok" : "analysis-only";
    return embeddingsAlive ? "embeddings-only" : "offline";
}

/** A heartbeat is the analyzer's last-beat time in ms since the epoch, as a string. */
export function heartbeatFresh(value: string | null, nowMs: number, withinMs: number): boolean {
    if (!value || !/^\d+$/.test(value)) return false;
    return nowMs - Number(value) < withinMs;
}
