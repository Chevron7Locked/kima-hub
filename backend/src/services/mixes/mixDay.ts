/**
 * The day a mix holds for. Kima runs on many people's servers in many time zones and keeps no time zone per user, so
 * the day is the server's own calendar date; a mix's id, its seed and its weekday all come from that one value, so
 * they agree on every server.
 */

/** The server's calendar date in its own time zone, as YYYY-MM-DD. */
export function mixDay(now: Date = new Date()): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The day of the week (0 = Sunday) of the date a mix's `today` starts with; a refresh's reroll may follow it. */
export function weekdayOf(today: string): number {
    const date = /^(\d{4})-(\d{2})-(\d{2})/.exec(today);
    if (!date) throw new RangeError(`A mix's day must start with YYYY-MM-DD, got ${today}`);
    return new Date(Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3]))).getUTCDay();
}
