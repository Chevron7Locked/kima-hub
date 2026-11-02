import type { SidebarItem } from "./components/ui";

export type SettingsPageSlug = "you" | "library" | "sources" | "server" | "people";

export interface SettingsPage {
    slug: SettingsPageSlug;
    label: string;
    href: string;
    /** One line under the page title, saying what the page holds. */
    description: string;
    adminOnly: boolean;
    /** The page's sections, in order, by the id of each SettingsSection. */
    sections: SidebarItem[];
}

/** Settings in five pages: a member sees only their own. */
export const SETTINGS_PAGES: SettingsPage[] = [
    {
        slug: "you",
        label: "You",
        href: "/settings",
        description: "Your account, your apps and how your music plays.",
        adminOnly: false,
        sections: [
            { id: "account", label: "Account" },
            { id: "subsonic", label: "Apps" },
            { id: "playback", label: "Playback" },
            { id: "scrobbling", label: "Scrobbling" },
        ],
    },
    {
        slug: "library",
        label: "Library",
        href: "/settings/library",
        description: "What Kima has worked out about your music, and the work that keeps it current.",
        adminOnly: true,
        sections: [
            { id: "cache", label: "Status" },
            { id: "library-actions", label: "Actions" },
            { id: "corrupt-tracks", label: "Corrupt tracks" },
            { id: "library-performance", label: "Performance" },
            { id: "library-start-over", label: "Start over" },
        ],
    },
    {
        slug: "sources",
        label: "Sources",
        href: "/settings/sources",
        description: "Where new music, audiobooks and podcasts come from.",
        adminOnly: true,
        sections: [
            { id: "download-preferences", label: "Downloads" },
            { id: "lidarr", label: "Lidarr" },
            { id: "soulseek", label: "Soulseek" },
            { id: "audiobookshelf", label: "Audiobookshelf" },
            { id: "podcasts", label: "Podcasts" },
        ],
    },
    {
        slug: "server",
        label: "Server",
        href: "/settings/server",
        description: "How this server is reached, where your music lives, and where artwork comes from.",
        adminOnly: true,
        sections: [
            { id: "storage", label: "Address and storage" },
            { id: "artwork", label: "Artwork" },
        ],
    },
    {
        slug: "people",
        label: "People",
        href: "/settings/people",
        description: "Who can use this server.",
        adminOnly: true,
        sections: [{ id: "users", label: "Users" }],
    },
];

export const settingsPage = (slug: SettingsPageSlug): SettingsPage => SETTINGS_PAGES.find((p) => p.slug === slug)!;

/**
 * Where an old single-page link (/settings#lidarr, kept in notifications and release notes) now goes: the page that
 * holds that section, at the section. Undefined when the section is on the "you" page, or unknown.
 */
export function addressForOldSection(id: string): string | undefined {
    const page = SETTINGS_PAGES.find((p) => p.slug !== "you" && p.sections.some((s) => s.id === id));
    if (page) return `${page.href}#${id}`;
    if (id === "enrichment-failures") return "/settings/library#enrichment-failures";
    return undefined;
}
