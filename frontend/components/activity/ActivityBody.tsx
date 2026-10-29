"use client";

import { useNotifications, useActiveDownloads } from "@/hooks/useNotifications";
import { PanelOptions } from "@/components/layout/panelChrome";
import { ActivityFeed } from "./ActivityFeed";
import { NotificationsTab } from "./NotificationsTab";
import { ActiveDownloadsTab } from "./ActiveDownloadsTab";
import { ImportsTab } from "./ImportsTab";
import { HistoryTab } from "./HistoryTab";

/** One kind of activity, with its own list and actions. */
export type ActivityKind = "notifications" | "downloads" | "imports" | "history";
/** What an activity area shows: everything merged, or one kind. */
export type ActivityView = "all" | ActivityKind;

export const ACTIVITY_VIEWS: readonly ActivityView[] = ["all", "notifications", "downloads", "imports", "history"];

export const isActivityView = (value: unknown): value is ActivityView =>
    ACTIVITY_VIEWS.includes(value as ActivityView);

/** Unread alerts and running downloads: what a closed panel or its toggle marks with a dot. */
export function useActivityCounts() {
    const { unreadCount } = useNotifications();
    const { downloads } = useActiveDownloads();
    return { unread: unreadCount, downloads: downloads.length, any: unreadCount > 0 || downloads.length > 0 };
}

/** The activity options, the same words and counts on every panel. */
export function ActivityOptions({
    value,
    onChange,
    controls,
}: {
    /** Null while the region shows something none of them names (a page's settings). */
    value: ActivityView | null;
    onChange: (view: ActivityView) => void;
    controls: string;
}) {
    const counts = useActivityCounts();
    return (
        <PanelOptions<ActivityView>
            label="activity"
            controls={controls}
            value={value}
            onChange={onChange}
            options={[
                { key: "all", label: "all" },
                { key: "notifications", label: "alerts", count: counts.unread, urgent: true },
                { key: "downloads", label: "downloads", count: counts.downloads, urgent: true },
                { key: "imports", label: "imports" },
                { key: "history", label: "history" },
            ]}
        />
    );
}

/** The list for a view; a row of the merged list opens its own kind through `onOpen`. */
export function ActivityPane({ view, onOpen }: { view: ActivityView; onOpen: (kind: ActivityKind) => void }) {
    switch (view) {
        case "all": return <ActivityFeed onOpen={onOpen} />;
        case "notifications": return <NotificationsTab />;
        case "downloads": return <ActiveDownloadsTab />;
        case "imports": return <ImportsTab />;
        case "history": return <HistoryTab />;
    }
}
