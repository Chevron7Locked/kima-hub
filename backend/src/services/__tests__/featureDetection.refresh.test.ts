/**
 * `refresh()` forgets the last answer for good: a feature check that began before it must not write its (older)
 * answer into the cache once it finishes. The four checks are stood in for.
 */
jest.mock("../../utils/redis", () => ({ redisClient: { get: jest.fn().mockResolvedValue(null) } }));

import { featureDetection } from "../featureDetection";

const checks = featureDetection as any;
let audiobookshelf: jest.SpyInstance;

beforeEach(() => {
    jest.spyOn(checks, "checkMusicCNN").mockResolvedValue(true);
    jest.spyOn(checks, "checkCLAP").mockResolvedValue(true);
    jest.spyOn(checks, "checkFpcalc").mockResolvedValue(true);
    audiobookshelf = jest.spyOn(checks, "checkAudiobookshelf");
    featureDetection.refresh();
});

afterEach(() => jest.restoreAllMocks());

it("a check that started before a refresh does not fill the cache with its old answer", async () => {
    let finishOld!: (on: boolean) => void;
    audiobookshelf.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finishOld = resolve; }));
    const old = featureDetection.getFeatures();
    await new Promise((resolve) => setImmediate(resolve));

    featureDetection.refresh();
    audiobookshelf.mockResolvedValue(true);
    finishOld(false);

    expect((await old).audiobookshelfEnabled).toBe(false);
    expect((await featureDetection.getFeatures()).audiobookshelfEnabled).toBe(true);
});

it("an answer is still cached when no refresh came in between", async () => {
    audiobookshelf.mockResolvedValue(true);

    await featureDetection.getFeatures();
    await featureDetection.getFeatures();

    expect(audiobookshelf).toHaveBeenCalledTimes(1);
});
