/**
 * Format large numbers into compact notation (e.g., 5,100,000 → "5.1M")
 */
export function formatListeners(count: number | undefined): string {
    if (!count || count === 0) return "Artist";

    if (count >= 1000000) {
        return `${(count / 1000000).toFixed(1)}M listeners`;
    }

    if (count >= 1000) {
        return `${(count / 1000).toFixed(count >= 10000 ? 0 : 1)}K listeners`;
    }

    return `${count.toLocaleString()} listeners`;
}
