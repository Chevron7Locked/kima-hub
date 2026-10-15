import { describe, it, expect, vi } from "vitest";
import { createRoot } from "react-dom/client";
import React, { act } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";

const auth: { user: { id: string } | null } = { user: null };
vi.mock("@/lib/auth-context", () => ({ useAuth: () => auth }));
vi.mock("@tanstack/react-query-devtools", () => ({ ReactQueryDevtools: () => null }));

import { QueryProvider } from "@/lib/query-client";

describe("the query cache across sign-ins", () => {
    it("keeps answers through the first sign-in, and empties when that person signs out or another signs in", async () => {
        let client: QueryClient | undefined;
        const Grab = () => {
            client = useQueryClient();
            return null;
        };
        const root = createRoot(document.createElement("div"));
        const render = () =>
            act(async () => {
                root.render(
                    <QueryProvider>
                        <Grab />
                    </QueryProvider>,
                );
            });
        await render();
        client!.setQueryData(["system", "public-config"], { canAcquire: false });

        auth.user = { id: "admin" };
        await render();
        expect(client!.getQueryData(["system", "public-config"])).toEqual({ canAcquire: false });

        client!.setQueryData(["system", "public-config"], { canAcquire: true });
        auth.user = null;
        await render();
        expect(client!.getQueryData(["system", "public-config"])).toBeUndefined();

        auth.user = { id: "admin" };
        await render();
        client!.setQueryData(["playlists"], ["admin's"]);
        auth.user = { id: "member" };
        await render();
        expect(client!.getQueryData(["playlists"])).toBeUndefined();
        root.unmount();
    });
});
