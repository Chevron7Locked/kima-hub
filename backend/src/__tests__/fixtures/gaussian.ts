/** A standard normal number from `rng` by the Box-Muller transform. */
export function gaussian(rng: () => number): number {
    return Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
}
