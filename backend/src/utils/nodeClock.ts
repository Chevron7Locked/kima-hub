/**
 * The time this process says it is, as a SQL value for a raw statement that stamps a timestamp column itself
 * (`updatedAt`, which Prisma only moves for its own writes, and `missingSince`). `now()` is the database's clock: a
 * container's can read milliseconds ahead of the host's, and a scan compares these columns with its own start time, so a
 * song flagged during a scan must not look newer or older than the scan because of where the database runs.
 *
 * Both columns are `timestamp(3)` in UTC. Use it inside a tagged `$executeRaw` or `$queryRaw`:
 * `` UPDATE "Track" SET "updatedAt" = ${nodeClock()} ``. One call per statement is one moment; pass `at` to stamp several
 * columns, or several statements, with the same one.
 */
import { Prisma } from "@prisma/client";

export function nodeClock(at: Date = new Date()): Prisma.Sql {
    return Prisma.sql`(${at.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
}
