import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";

export type SoundRebuild =
    | { step: "vectors"; done: number; total: number }
    | { step: "moods"; done: number; total: number }
    | { step: "map"; done: number; total: number };

/**
 * Where the library's sound features stand while they are being built: the sound vectors, then the moods scored from
 * them, then the similarity step that lays out the map. Null once all three are complete (or before the first answer).
 * Shares the settings page's query, which the event stream already refreshes.
 */
export function useSoundRebuild(): SoundRebuild | null {
    const { isAuthenticated } = useAuth();
    const { data } = useQuery({
        queryKey: ["enrichment-progress"],
        queryFn: () => api.getEnrichmentProgress(),
        enabled: isAuthenticated,
        refetchInterval: (query) => {
            const p = query.state.data;
            return p && !p.isFullyComplete ? 10_000 : false;
        },
        staleTime: 2000,
        placeholderData: keepPreviousData,
    });
    // "Still building" is work still owed, read the way the settings page reads it: songs that failed for good or whose
    // files are missing are finished questions, not a rebuild that never ends.
    if (!data || data.isFullyComplete) return null;
    const { clapEmbeddings: vectors, moods, similarity } = data;
    if (vectors.pending + vectors.processing + vectors.retrying > 0) {
        return { step: "vectors", done: vectors.completed, total: vectors.total };
    }
    if (moods.pending > 0) return { step: "moods", done: moods.completed, total: moods.total };
    if (similarity.pending > 0) return { step: "map", done: similarity.completed, total: similarity.total };
    return null;
}

/** One plain line for a page that is waiting on the rebuild. */
export function describeSoundRebuild(r: SoundRebuild): string {
    const count = `${r.done.toLocaleString()} of ${r.total.toLocaleString()} songs`;
    if (r.step === "vectors") return `Building sound vectors: ${count}.`;
    if (r.step === "moods") return `Scoring moods: ${count}.`;
    return `Laying out the map: ${count}.`;
}
