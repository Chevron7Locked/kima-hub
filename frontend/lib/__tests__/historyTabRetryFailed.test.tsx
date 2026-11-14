/**
 * A retry of a failed download that could not start answers a non-2xx status (404 when Soulseek has no files for the
 * song, 502 when it failed or is unavailable). The history row says "retry failed" with the server's reason, as it did
 * when the answer was a 200 with `success: false`, and nothing is thrown past the click. The row's replacement, which
 * the server made and failed, carries the same notice.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { mountHost } from "./helpers/dom";

const { retryFailedDownload, history } = vi.hoisted(() => ({
    retryFailedDownload: vi.fn(),
    history: { current: [] as unknown[] },
}));
vi.mock("@/lib/api", () => ({ api: { retryFailedDownload, clearDownloadFromHistory: vi.fn(), clearAllDownloadHistory: vi.fn() } }));
vi.mock("@/hooks/useNotifications", () => ({ useDownloadHistory: () => ({ history: history.current, isLoading: false }) }));
vi.mock("@/hooks/useQueries", () => ({ usePublicConfig: () => ({ canAcquire: true }) }));
vi.mock("@/components/activity/DownloadRow", () => ({
    DownloadRow: ({ item, notice, actions }: { item: { id: string; subject: string }; notice?: string; actions: React.ReactNode }) => (
        <div data-testid={`row-${item.id}`}>
            {item.subject}
            {notice && <p role="status">{notice}</p>}
            {actions}
        </div>
    ),
    RowAction: ({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) => (
        <button aria-label={label} onClick={onClick} disabled={disabled} />
    ),
}));

import { HistoryTab } from "@/components/activity/HistoryTab";

const dom = mountHost();
const failedItem = (id: string) => ({ id, subject: "low - sunflower", type: "track", status: "failed", createdAt: "2026-11-13T10:00:00Z" });

function failure(status: number, message: string, data: Record<string, unknown>) {
    return Object.assign(new Error(message), { status, data });
}

const queryClient = new QueryClient();

async function render() {
    await act(async () => {
        dom.root.render(
            <QueryClientProvider client={queryClient}>
                <HistoryTab />
            </QueryClientProvider>,
        );
    });
}

async function clickRetry(id: string) {
    history.current = [failedItem(id)];
    await render();
    const button = dom.host.querySelector<HTMLButtonElement>('[aria-label="retry low - sunflower"]')!;
    await act(async () => {
        button.click();
    });
}

const notice = (id: string) => dom.host.querySelector(`[data-testid="row-${id}"] [role="status"]`)?.textContent;

afterEach(() => retryFailedDownload.mockReset());

describe("history tab: a retry that could not start", () => {
    it("shows the reason on the row when Soulseek has no files (404)", async () => {
        retryFailedDownload.mockRejectedValue(failure(404, "No matching files found", { success: false, newJobId: "j2", error: "No matching files found" }));

        await clickRetry("j1");

        expect(notice("j1")).toBe("Retry failed: No matching files found");
    });

    it("shows the reason on the row when Soulseek failed or is unavailable (502)", async () => {
        retryFailedDownload.mockRejectedValue(failure(502, "Soulseek is turned off or not set up", { success: false, newJobId: "k2" }));

        await clickRetry("k1");

        expect(notice("k1")).toBe("Retry failed: Soulseek is turned off or not set up");
    });

    it("shows the same reason on the failed replacement that takes the row's place", async () => {
        retryFailedDownload.mockRejectedValue(failure(404, "No matching files found", { newJobId: "m2" }));
        await clickRetry("m1");

        history.current = [failedItem("m2")];
        await render();

        expect(notice("m2")).toBe("Retry failed: No matching files found");
    });
});
