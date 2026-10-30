import { execFileSync } from "node:child_process";

/**
 * SQL against the database of the stack under test, run inside its all-in-one container (KIMA_CONTAINER, on this
 * machine's Docker) with that container's own psql. Returns null when no container is named: the caller records what did not run.
 * Only for state no request can create, such as play history written by an older version.
 */
export function stackSql(sql: string): string | null {
    const container = process.env.KIMA_CONTAINER;
    if (!container) return null;
    return execFileSync(
        "docker",
        ["exec", container, "psql", "-U", "kima", "-d", "kima", "-v", "ON_ERROR_STOP=1", "-At", "-c", sql],
        { encoding: "utf8", timeout: 30_000 },
    ).trim();
}
