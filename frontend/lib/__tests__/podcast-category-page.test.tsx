// The category page keeps its chart when a background refresh of Apple's category list fails; the "couldn't reach
// apple podcasts" screen is only for having no list at all.
import { describe, it, expect, vi, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/link", () => ({
    default: ({ children, href, ...rest }: { children?: React.ReactNode; href: string; [k: string]: unknown }) =>
        React.createElement("a", { href, ...rest }, children),
}));
vi.mock("next/navigation", () => ({ useParams: () => ({ id: "1303" }), useRouter: () => ({ push: vi.fn() }), usePathname: () => "/podcasts/category/1303" }));
vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ isAuthenticated: true, user: { id: "u" } }) }));
const categories = vi.fn();
vi.mock("@/lib/api", () => ({
    api: {
        getPodcastCategories: () => categories(),
        getPodcastChart: async () => [{ id: "1", itunesId: "1", title: "Comedy Bang Bang", author: "Earwolf", description: "", coverUrl: null, genres: [], chartRank: 1 }],
        getCoverArtUrl: (u: string) => u,
    },
}));

import PodcastCategoryPage from "@/app/podcasts/category/[id]/page";

let container: HTMLDivElement;
let root: Root;

afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
});

describe("/podcasts/category/:id", () => {
    it("keeps showing the chart when a refresh of the category list fails", async () => {
        categories.mockResolvedValueOnce([{ id: 1303, name: "Comedy", parentId: null }]);
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        container = document.body.appendChild(document.createElement("div"));
        root = createRoot(container);
        await act(async () => root.render(<QueryClientProvider client={client}><PodcastCategoryPage /></QueryClientProvider>));
        await act(async () => new Promise((r) => setTimeout(r, 50)));
        expect(container.textContent).toContain("Comedy Bang Bang");

        categories.mockRejectedValueOnce(new Error("Apple is down"));
        await act(async () => {
            await client.refetchQueries({ queryKey: ["podcasts", "categories"] }).catch(() => {});
        });
        expect(client.getQueryState(["podcasts", "categories"])?.status).toBe("error");
        // Let the page draw what it does with the failed refresh before looking.
        await act(async () => new Promise((r) => setTimeout(r, 50)));
        expect(container.textContent).toContain("Comedy Bang Bang");
        expect(container.textContent).not.toContain("couldn't reach apple podcasts");
    });
});
