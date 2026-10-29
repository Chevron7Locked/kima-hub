"use client";

import { useEffect, useRef } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { useAuth } from "./auth-context";

function makeQueryClient() {
    return new QueryClient({
        defaultOptions: {
            queries: {
                staleTime: 5 * 60 * 1000,
                gcTime: 10 * 60 * 1000,
                refetchOnWindowFocus: false, // a refetch on focus would interrupt playback
                retry: 1,
            },
        },
    });
}

let browserQueryClient: QueryClient | undefined = undefined;

/** A new client per server render; one shared client in the browser. */
function getQueryClient() {
    if (typeof window === "undefined") {
        return makeQueryClient();
    } else {
        if (!browserQueryClient) browserQueryClient = makeQueryClient();
        return browserQueryClient;
    }
}

/** The app's query cache, with React Query's devtools in development. */
export function QueryProvider({ children }: { children: React.ReactNode }) {
    const queryClient = getQueryClient();

    return (
        <QueryClientProvider client={queryClient}>
            <ForgetOnSignOut client={queryClient} />
            {children}
            {process.env.NODE_ENV === "development" && (
                <ReactQueryDevtools
                    initialIsOpen={false}
                    buttonPosition="bottom-left"
                />
            )}
        </QueryClientProvider>
    );
}

/**
 * The cache holds one person's answers (their playlists, shows, search results, whether they may download), so it is
 * emptied when they sign out or someone else signs in: the next person in this tab never sees the last one's data.
 */
function ForgetOnSignOut({ client }: { client: QueryClient }) {
    const { user } = useAuth();
    const userId = user?.id ?? null;
    const last = useRef(userId);
    useEffect(() => {
        if (last.current !== null && last.current !== userId) client.clear();
        last.current = userId;
    }, [userId, client]);
    return null;
}
