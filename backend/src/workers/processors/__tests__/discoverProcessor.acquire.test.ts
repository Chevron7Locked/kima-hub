/**
 * Building Discover Weekly downloads albums, so the job follows the download rule whoever queued it: the button is
 * gated, but the Monday run queues every user who turned Discover on. Real database; the generator itself is
 * watched, not run, since it would reach the outside world.
 */
import type { Job } from "bullmq";
import { prisma } from "../../../utils/db";
import { invalidateSystemSettingsCache } from "../../../utils/systemSettings";
import { discoverWeeklyService } from "../../../services/discoverWeekly";
import { processDiscoverWeekly, type DiscoverJobData } from "../discoverProcessor";

const MEMBER = "u_disc_member";
const ADMIN = "u_disc_admin";

const job = (userId: string) => ({ id: `t-${userId}`, data: { userId }, updateProgress: jest.fn() }) as unknown as Job<DiscoverJobData>;

const setToggle = async (allowMemberAcquire: boolean) => {
    await prisma.systemSettings.upsert({ where: { id: "default" }, create: { id: "default", allowMemberAcquire }, update: { allowMemberAcquire } });
    invalidateSystemSettingsCache();
};

let generate: jest.SpyInstance;

beforeAll(async () => {
    await prisma.user.createMany({
        data: [
            { id: MEMBER, username: MEMBER, passwordHash: "x", role: "user", tokenVersion: 0 },
            { id: ADMIN, username: ADMIN, passwordHash: "x", role: "admin", tokenVersion: 0 },
        ],
        skipDuplicates: true,
    });
});

beforeEach(() => {
    generate = jest.spyOn(discoverWeeklyService, "generatePlaylist").mockResolvedValue({ success: true, playlistName: "Discover", songCount: 0 } as never);
});

afterEach(() => generate.mockRestore());

afterAll(async () => {
    await setToggle(false);
    await prisma.user.deleteMany({ where: { id: { in: [MEMBER, ADMIN] } } });
});

it("skips a member while member downloads are off, without generating anything", async () => {
    await setToggle(false);
    const result = await processDiscoverWeekly(job(MEMBER));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/operator-only/);
    expect(generate).not.toHaveBeenCalled();
});

it("builds a member's playlist once the operator allows member downloads, and an admin's always", async () => {
    await setToggle(true);
    await processDiscoverWeekly(job(MEMBER));
    await setToggle(false);
    await processDiscoverWeekly(job(ADMIN));
    expect(generate.mock.calls.map((c) => c[0])).toEqual([MEMBER, ADMIN]);
});
