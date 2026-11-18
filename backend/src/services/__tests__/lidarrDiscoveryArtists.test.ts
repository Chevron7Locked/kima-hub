/**
 * The clean-ups' list of Discover's artists: the artists carrying Discover's tag; none when Lidarr has no such tag,
 * without creating one just to look; null when Lidarr is not set up; an error when Lidarr cannot be read, never "none".
 * Lidarr's replies are stood in for.
 */
import { lidarrService } from "../lidarr";

const client = { get: jest.fn(), post: jest.fn() };
const service = lidarrService as any;

beforeEach(() => {
    jest.restoreAllMocks();
    client.get.mockReset();
    client.post.mockReset();
    jest.spyOn(service, "ensureInitialized").mockResolvedValue(undefined);
    service.enabled = true;
    service.client = client;
});

it("lists the artists carrying the tag", async () => {
    client.get.mockImplementation(async (url: string) =>
        url === "/api/v1/tag"
            ? { data: [{ id: 9, label: "lidify-discovery" }] }
            : { data: [{ id: 1, artistName: "Tagged", tags: [9] }, { id: 2, artistName: "Not", tags: [] }] },
    );
    expect((await lidarrService.readDiscoveryTaggedArtists())!.map((a) => a.artistName)).toEqual(["Tagged"]);
});

it("lists none and creates no tag when Lidarr has none", async () => {
    client.get.mockResolvedValue({ data: [] });
    expect(await lidarrService.readDiscoveryTaggedArtists()).toEqual([]);
    expect(client.post).not.toHaveBeenCalled();
});

it("throws when Lidarr cannot be read, so no caller takes it for no artists", async () => {
    client.get.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(lidarrService.readDiscoveryTaggedArtists()).rejects.toThrow("ECONNREFUSED");
});

it("answers null when Lidarr is not set up", async () => {
    service.enabled = false;
    expect(await lidarrService.readDiscoveryTaggedArtists()).toBeNull();
    expect(client.get).not.toHaveBeenCalled();
});
