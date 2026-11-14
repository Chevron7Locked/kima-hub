/** Mark an error as "its entity was deleted while the job sat in the queue",
 * so the worker resolves silently instead of recording a failure against a
 * row that no longer exists. */
export function entityGoneError(kind: string, id: string): Error {
    const err = new Error(`ENTITY_NOT_FOUND: ${kind} ${id} deleted`);
    (err as Error & { entityNotFound?: boolean }).entityNotFound = true;
    return err;
}

/** True of errors from `entityGoneError`. */
export function isEntityGone(err: unknown): boolean {
    return (err as { entityNotFound?: boolean } | null | undefined)?.entityNotFound === true;
}
