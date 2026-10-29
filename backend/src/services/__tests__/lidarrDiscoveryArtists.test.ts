/**
 * The clean-ups' list of Discover's artists: the artists carrying Discover's tag; none when Lidarr has no such tag,
 * without creating one just to look; none (logged) when Lidarr cannot be read. Lidarr's replies are stood in for.
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
    expect((await lidarrService.getDiscoveryArtists()).map((a) => a.artistName)).toEqual(["Tagged"]);
});

it("lists none and creates no tag when Lidarr has none", async () => {
    client.get.mockResolvedValue({ data: [] });
    expect(await lidarrService.getDiscoveryArtists()).toEqual([]);
    expect(client.post).not.toHaveBeenCalled();
});

it("lists none when Lidarr cannot be read", async () => {
    client.get.mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await lidarrService.getDiscoveryArtists()).toEqual([]);
});
