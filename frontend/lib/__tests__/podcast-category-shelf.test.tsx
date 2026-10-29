/**
 * A podcast category row waiting on its chart shows placeholder cards at a full row's height, marked busy. Apple is
 * asked one chart every 3 s, so a row can wait a minute; blank, it looked broken, and rows filling in above pushed the
 * rest down and out of reach.
 */
import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";

const PENDING = { data: undefined as unknown, isError: false, refetch: () => {}, isFetching: true };
const chart = vi.hoisted(() => ({ value: { data: undefined as unknown, isError: false, refetch: () => {}, isFetching: true } }));
vi.mock("@/hooks/useQueries", () => ({ usePodcastChartQuery: () => chart.value }));
vi.mock("next/link", () => ({
    default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

import { CategoryShelf } from "@/features/podcast/components/CategoryShelf";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    chart.value = { ...PENDING };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

it("shows placeholder cards, marked busy, while its chart is on its way", () => {
    act(() => root.render(<CategoryShelf category={{ id: 1301, name: "Arts" }} enabled />));
    const busy = host.querySelector('[aria-busy="true"]');
    expect(busy).not.toBeNull();
    expect(busy!.querySelectorAll("[data-placeholder-card]").length).toBeGreaterThan(0);
});

it("drops the placeholder once the chart is in", () => {
    chart.value = { ...chart.value, data: [{ itunesId: "1", title: "Show", author: "A", coverUrl: null }], isFetching: false };
    act(() => root.render(<CategoryShelf category={{ id: 1301, name: "Arts" }} enabled />));
    expect(host.querySelector('[aria-busy="true"]')).toBeNull();
    expect(host.querySelector("[data-placeholder-card]")).toBeNull();
    expect(host.textContent).toContain("Show");
});
