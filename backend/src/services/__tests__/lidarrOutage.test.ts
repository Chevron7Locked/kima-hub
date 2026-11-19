/**
 * A request to Lidarr that finds it down tells whoever listens for an outage (the Lidarr health check), so the check
 * runs at once instead of at its next turn. Lidarr here is a closed local port: the request gets no answer.
 */
import { lidarrService } from "../lidarr";

const service = lidarrService as any;

beforeEach(() => {
    service.client = service.createClient("http://127.0.0.1:1", "key");
});

it("tells each outage listener when a request gets no answer, until it is removed", async () => {
    const listener = jest.fn();
    const remove = lidarrService.onOutage(listener);

    await expect(service.client.get("/api/v1/system/status")).rejects.toThrow();
    expect(listener).toHaveBeenCalledTimes(1);

    remove();
    await expect(service.client.get("/api/v1/system/status")).rejects.toThrow();
    expect(listener).toHaveBeenCalledTimes(1);
});
