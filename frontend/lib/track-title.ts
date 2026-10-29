/** A song's title as Kima shows it: the title edited in Kima when there is one, else the file's own. */
export function shownTitle(track: { title: string; displayTitle?: string | null }): string {
    return track.displayTitle || track.title;
}
