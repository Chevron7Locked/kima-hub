import { execFileSync, spawnSync } from "node:child_process";

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

/**
 * The named container's log, both streams (the analyzers write to stderr), every line stamped by Docker, from `since`
 * or from the container's start. Throws when no container is named or Docker fails.
 */
export function stackLog(since?: Date): string {
    const container = process.env.KIMA_CONTAINER;
    if (!container) throw new Error("KIMA_CONTAINER is not set");
    const out = spawnSync("docker", ["logs", "-t", ...(since ? ["--since", since.toISOString()] : []), container], {
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 512 * 1024 * 1024,
    });
    if (out.status !== 0) throw new Error(`docker logs failed: ${out.stderr.slice(0, 300)}`);
    return `${out.stdout}\n${out.stderr}`;
}

/** When the named container was created (epoch ms), from `docker inspect`. Throws when no container is named or Docker fails. */
export function stackCreatedAt(): number {
    const container = process.env.KIMA_CONTAINER;
    if (!container) throw new Error("KIMA_CONTAINER is not set");
    const out = spawnSync("docker", ["inspect", "--format", "{{.Created}}", container], { encoding: "utf8", timeout: 30_000 });
    if (out.status !== 0) throw new Error(`docker inspect failed: ${out.stderr.slice(0, 300)}`);
    const at = Date.parse(out.stdout.trim());
    if (!Number.isFinite(at)) throw new Error(`docker inspect gave no creation time: ${out.stdout.slice(0, 100)}`);
    return at;
}
