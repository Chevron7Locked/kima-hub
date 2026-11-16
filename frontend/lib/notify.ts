import { api } from "@/lib/api";

interface NotifyOptions {
    message?: string;
    href?: string;
    /** What a repeat replaces. Without one, the title is the key. */
    groupKey?: string;
}

function send(type: "error" | "system", title: string, opts?: NotifyOptions) {
    api.createNotification({
        type,
        title: title.slice(0, 120),
        message: opts?.message?.slice(0, 500),
        href: opts?.href,
        groupKey: opts?.groupKey?.slice(0, 120),
    }).catch((err) => {
        console.error(`Could not record "${title}" in notifications:`, err);
    });
}

// Outcomes go to the notification tray: one row per group key (the title when none is given), so a repeat replaces it.
export const notify = {
    error: (title: string, opts?: NotifyOptions) => send("error", title, opts),
    info: (title: string, opts?: NotifyOptions) => send("system", title, opts),
};
