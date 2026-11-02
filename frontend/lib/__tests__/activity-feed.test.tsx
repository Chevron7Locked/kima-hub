/**
 * The "all" activity list: failures that share one reason fold into one row that opens their list, and a clear button
 * empties the finished part of the list (alerts and download history) without touching anything still running.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { mountHost } from "./helpers/dom";

const { state, clearAll, clearHistory } = vi.hoisted(() => ({
    state: { notifications: [] as unknown[], downloads: [] as unknown[], history: [] as unknown[] },
    clearAll: vi.fn(),
    clearHistory: vi.fn(async () => ({ success: true })),
}));
vi.mock("@/hooks/useNotifications", () => ({
    useNotifications: () => ({ notifications: state.notifications, isLoading: false, clearAll }),
    useActiveDownloads: () => ({ downloads: state.downloads }),
    useDownloadHistory: () => ({ history: state.history }),
}));
vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ isAuthenticated: false }) }));
vi.mock("@/lib/api", () => ({ api: { clearAllDownloadHistory: clearHistory } }));

import { ActivityFeed } from "@/components/activity/ActivityFeed";

const NO_SOURCE = "no download sources configured. please configure soulseek or lidarr";
const failed = (id: string, subject: string, error: string, minutesAgo: number) => ({
    id, subject, status: "failed", error, createdAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
});

const dom = mountHost();
let onOpen: ReturnType<typeof vi.fn<(kind: string) => void>>;

beforeEach(() => {
    onOpen = vi.fn<(kind: string) => void>();
    clearAll.mockReset();
    clearHistory.mockClear();
    state.notifications = [];
    state.downloads = [];
    state.history = [];
});

function render() {
    const client = new QueryClient();
    act(() =>
        dom.root.render(
            <QueryClientProvider client={client}>
                <ActivityFeed onOpen={onOpen} />
            </QueryClientProvider>,
        ),
    );
}
const rows = () => [...dom.host.querySelectorAll("li button")].map((b) => b.textContent ?? "");

describe("the all activity list", () => {
    it("folds failures that share one reason into one row, and keeps a different failure on its own", () => {
        state.history = [
            failed("h1", "daft punk - homework", NO_SOURCE, 5),
            failed("h2", "the police - reggatta de blanc", NO_SOURCE, 6),
            failed("h3", "emery - revival", NO_SOURCE, 7),
            failed("h4", "upsahl - lady jesus", "lidarr refused the album", 8),
        ];
        render();
        const list = rows();
        expect(list).toHaveLength(2);
        expect(list[0]).toContain("3 downloads failed");
        expect(list[0]).toContain(NO_SOURCE);
        expect(list[1]).toContain("upsahl - lady jesus");
        (dom.host.querySelector("li button") as HTMLButtonElement).click();
        expect(onOpen).toHaveBeenCalledWith("history");
    });

    it("leaves a single failure as it is", () => {
        state.history = [failed("h1", "daft punk - homework", NO_SOURCE, 5)];
        render();
        expect(rows()).toEqual([expect.stringContaining("daft punk - homework")]);
    });

    it("clears the alerts and the download history from one button, not what is still running", async () => {
        state.history = [failed("h1", "daft punk - homework", NO_SOURCE, 5)];
        state.downloads = [{ id: "d1", subject: "muse - absolution", createdAt: new Date().toISOString() }];
        render();
        const clear = [...dom.host.querySelectorAll("button")].find((b) => b.textContent === "clear notifications")!;
        expect(clear).toBeTruthy();
        await act(async () => clear.click());
        expect(clearAll).toHaveBeenCalledTimes(1);
        expect(clearHistory).toHaveBeenCalledTimes(1);
    });

    it("puts the download history back when clearing it fails", async () => {
        state.history = [failed("h1", "daft punk - homework", NO_SOURCE, 5)];
        clearHistory.mockRejectedValueOnce(new Error("offline"));
        const client = new QueryClient();
        client.setQueryData(["download-history"], state.history);
        act(() =>
            dom.root.render(
                <QueryClientProvider client={client}>
                    <ActivityFeed onOpen={onOpen} />
                </QueryClientProvider>,
            ),
        );
        const clear = [...dom.host.querySelectorAll("button")].find((b) => b.textContent === "clear notifications")!;
        await act(async () => clear.click());
        expect(client.getQueryData(["download-history"])).toEqual(state.history);
    });

    it("clears once however often the button is pressed while it works", async () => {
        state.history = [failed("h1", "daft punk - homework", NO_SOURCE, 5)];
        render();
        const clear = [...dom.host.querySelectorAll("button")].find((b) => b.textContent === "clear notifications")!;
        await act(async () => {
            clear.click();
            clear.click();
        });
        expect(clearHistory).toHaveBeenCalledTimes(1);
    });

    it("has nothing to clear when only running work is listed", () => {
        state.downloads = [{ id: "d1", subject: "muse - absolution", createdAt: new Date().toISOString() }];
        render();
        expect([...dom.host.querySelectorAll("button")].some((b) => b.textContent === "clear notifications")).toBe(false);
    });
});
