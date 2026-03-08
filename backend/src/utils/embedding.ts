/**
 * Parse a pgvector embedding from its text representation "[0.1,0.2,...]" to a number array.
 */
export function parseEmbedding(text: string): number[] {
    return text.replace(/[\[\]]/g, "").split(",").map(Number);
}
