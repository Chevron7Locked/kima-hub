/**
 * A peer's messages about a download, driven through a client that has no sockets: the server and listen
 * connections are stubbed and the peer is a stand-in.
 */
import { logger } from "../../../utils/logger";
import { SlskClient } from "../p2p-client";

jest.mock("../server");
jest.mock("../listen");

function setup() {
  const client = new SlskClient();
  const peer = { username: "peer", send: jest.fn(), destroy: jest.fn() };
  client.peers.set("peer", peer as never);
  const peerSends = (msg: Record<string, unknown>) =>
    client.peerMessages.emit("message", msg as never, peer as never);
  return { client, peerSends };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("a queue place for a file with no download", () => {
  it("is logged at debug, not as an error", () => {
    const { client, peerSends } = setup();
    const debug = jest.spyOn(logger, "debug").mockImplementation(() => {});
    const error = jest.spyOn(logger, "error").mockImplementation(() => {});
    peerSends({ kind: "placeInQueueResponse", filename: "gone.flac", place: 3 });
    expect(debug).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    client.destroy();
  });
});

describe("a denial", () => {
  it("is logged at debug and changes nothing when the peer already allowed the transfer", async () => {
    const { client, peerSends } = setup();
    const debug = jest.spyOn(logger, "debug").mockImplementation(() => {});
    const download = await client.download("peer", "a.flac");
    peerSends({
      kind: "transferRequest",
      direction: 1,
      filename: "a.flac",
      token: "abcd",
      size: 5n,
    });
    (download as { status: string }).status = "downloading";
    (download as { receivedBytes: bigint }).receivedBytes = 2n;
    debug.mockClear();

    peerSends({ kind: "uploadDenied", filename: "a.flac", reason: "Banned" });

    expect(client.downloads).toEqual([download]);
    expect(download.stream.destroyed).toBe(false);
    expect(debug).toHaveBeenCalledTimes(1);
    client.destroy();
  });

  it("kept on the stream when it lands before anyone listens, and it does not throw", async () => {
    const { client, peerSends } = setup();
    const download = await client.download("peer", "a.flac");

    peerSends({ kind: "uploadDenied", filename: "a.flac", reason: "Banned" });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(download.streamError?.message).toBe("Upload denied: Banned");
    expect(client.downloads).toHaveLength(0);
    client.destroy();
  });
});
