export function formatDate(dateString: string): string {
    const date = new Date(dateString);
    return date.toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
    });
}

export type ShowSort = "title" | "author" | "latest";

/** Followed shows in the chosen order: by title, by author, or the show that published most recently first. */
export function sortShows<T extends { title?: string; author?: string; latestEpisodeAt?: string | null }>(shows: T[], by: ShowSort): T[] {
    const time = (date: string | null | undefined) => (date ? new Date(date).getTime() : 0);
    const sorted = [...shows];
    if (by === "title") sorted.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
    if (by === "author") sorted.sort((a, b) => (a.author || "").localeCompare(b.author || ""));
    if (by === "latest") sorted.sort((a, b) => time(b.latestEpisodeAt) - time(a.latestEpisodeAt));
    return sorted;
}
