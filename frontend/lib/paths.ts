/**
 * A page or request path that carries ids: each id is one path segment, so one holding `/`, `?` or `#` cannot reach another
 * route or cut the address short. `pathFor("/album", id)` is `/album/<id>`; further segments follow, `pathFor("/a", x, "cover")`.
 * `lib/api.ts` encodes its own ids the same way.
 */
export function pathFor(base: string, ...segments: Array<string | number>): string {
    return base + segments.map((segment) => `/${encodeURIComponent(String(segment))}`).join("");
}
