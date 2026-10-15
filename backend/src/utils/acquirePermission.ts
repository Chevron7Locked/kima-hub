import { getSystemSettings } from "./systemSettings";

// Acquisition gate (issue #238): downloads cost money, hit peer networks and fill the disk, so they are
// operator-only unless the operator opens them to members in Settings.
export const ACQUIRE_REFUSED = "Acquisition is operator-only. An admin can allow member downloads in Settings.";

/** Whether this signed-in user may start downloads: an admin always, a member when the operator allows it. */
export async function mayAcquire(user: { role?: string | null }): Promise<boolean> {
    if (user.role === "admin") return true;
    return Boolean((await getSystemSettings())?.allowMemberAcquire);
}
