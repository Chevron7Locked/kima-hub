import type { SoulseekResult } from "@/features/search/types";

interface SearchSession {
    results: SoulseekResult[];
    complete: boolean;
}

type Listener = () => void;

class SearchResultStore {
    private sessions = new Map<string, SearchSession>();
    private listeners = new Map<string, Set<Listener>>();

    push(searchId: string, results: SoulseekResult[]): void {
        const session = this.sessions.get(searchId) || { results: [], complete: false };
        session.results = [...session.results, ...results];
        this.sessions.set(searchId, session);
        this.notify(searchId);
    }

    complete(searchId: string): void {
        const session = this.sessions.get(searchId);
        if (session) {
            session.complete = true;
            this.notify(searchId);
        }
    }

    getSession(searchId: string): SearchSession | undefined {
        return this.sessions.get(searchId);
    }

    subscribe(searchId: string, listener: Listener): () => void {
        let set = this.listeners.get(searchId);
        if (!set) {
            set = new Set();
            this.listeners.set(searchId, set);
        }
        set.add(listener);
        return () => {
            set!.delete(listener);
            if (set!.size === 0) this.listeners.delete(searchId);
        };
    }

    clear(searchId: string): void {
        this.sessions.delete(searchId);
        this.listeners.delete(searchId);
    }

    private notify(searchId: string): void {
        const set = this.listeners.get(searchId);
        if (set) {
            for (const listener of set) {
                listener();
            }
        }
    }
}

export const searchResultStore = new SearchResultStore();
