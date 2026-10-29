/** An error and what it wraps through `cause`, outermost first, at most five deep. */
export function* errorChain(error: unknown): Generator<unknown> {
    for (let e = error, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) yield e;
}
