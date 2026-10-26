/**
 * Changes that reach the address one after another, faster than the page re-renders it (arrow keys in the
 * collection's Refine panel). Each change builds on the last one asked for, not on the last one rendered.
 */

/** The view a change builds on: the last one asked for that has not rendered yet, else the one on screen. */
export function viewToChange<V>(requested: V[], rendered: V): V {
    return requested.length > 0 ? requested[requested.length - 1] : rendered;
}

/**
 * The views still on their way once `rendered` is on screen. A render of one asked for means the ones after it are
 * still coming; a render of anything else (Back, a link) means the address moved on without them.
 */
export function stillRequested<V>(requested: V[], rendered: V, same: (a: V, b: V) => boolean): V[] {
    const at = requested.findIndex((v) => same(v, rendered));
    return at === -1 ? [] : requested.slice(at + 1);
}
