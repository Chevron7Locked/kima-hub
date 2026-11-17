import { EventEmitter } from "events";
import stream from "stream";

import type {
  Download,
  DownloadWithToken,
  SlskDownloadEventEmitter,
} from "../downloads";
import {
  acceptTransferRequest,
  canBeDenied,
  FileTransferReader,
  findAwaitingDownload,
  findDownloadForOffer,
  findPendingDownload,
} from "../fileTransfer";

const TOKEN = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
const TOKEN_HEX = "deadbeef";

function makeDownload(
  totalBytes: bigint,
  streamOptions?: stream.TransformOptions,
): DownloadWithToken {
  return {
    status: "connected",
    username: "peer",
    filename: "a.flac",
    receivedBytes: 0n,
    stream: new stream.PassThrough(streamOptions),
    events: new EventEmitter() as SlskDownloadEventEmitter,
    requestQueuePosition: () => {},
    queuePosition: 0,
    token: TOKEN_HEX,
    totalBytes,
  } as DownloadWithToken;
}

function setup(download: DownloadWithToken, { consume = true } = {}) {
  const replies: Buffer[] = [];
  const settled: DownloadWithToken[] = [];
  const looked: string[] = [];
  let ended = 0;
  const flow: string[] = [];
  const reader = new FileTransferReader({
    findDownload: (token) => {
      looked.push(token);
      return token === TOKEN_HEX ? download : undefined;
    },
    reply: (b) => replies.push(b),
    end: () => {
      ended++;
    },
    settle: (d) => settled.push(d),
    pause: () => flow.push("pause"),
    resume: () => flow.push("resume"),
  });
  const received: Buffer[] = [];
  if (consume) download.stream.on("data", (b: Buffer) => received.push(b));
  const completes: bigint[] = [];
  download.events.on("complete", (n) => completes.push(n));
  return {
    reader,
    replies,
    settled,
    looked,
    received,
    completes,
    flow,
    ended: () => ended,
  };
}

describe("FileTransferReader", () => {
  it("matches a token split over two chunks", () => {
    const d = makeDownload(10n);
    const t = setup(d);
    t.reader.push(TOKEN.subarray(0, 2));
    expect(t.looked).toEqual([]);
    expect(t.ended()).toBe(0);
    t.reader.push(Buffer.concat([TOKEN.subarray(2), Buffer.from("abc")]));
    expect(t.looked).toEqual([TOKEN_HEX]);
    expect(d.status).toBe("downloading");
    expect(t.replies).toHaveLength(1);
    expect(t.replies[0].readBigUInt64LE(0)).toBe(0n);
    expect(d.receivedBytes).toBe(3n);
    expect(Buffer.concat(t.received).toString()).toBe("abc");
    expect(t.ended()).toBe(0);
  });

  it("matches a token split over three chunks", () => {
    const d = makeDownload(10n);
    const t = setup(d);
    t.reader.push(TOKEN.subarray(0, 1));
    t.reader.push(TOKEN.subarray(1, 3));
    expect(t.looked).toEqual([]);
    expect(t.ended()).toBe(0);
    t.reader.push(TOKEN.subarray(3));
    expect(t.looked).toEqual([TOKEN_HEX]);
    expect(d.status).toBe("downloading");
    expect(t.replies).toHaveLength(1);
    expect(t.replies[0].readBigUInt64LE(0)).toBe(0n);
    expect(d.receivedBytes).toBe(0n);
    expect(t.ended()).toBe(0);
  });

  it("takes the token and file data from one chunk", () => {
    const d = makeDownload(10n);
    const t = setup(d);
    t.reader.push(Buffer.concat([TOKEN, Buffer.from("hello")]));
    expect(t.replies).toHaveLength(1);
    expect(d.receivedBytes).toBe(5n);
    expect(Buffer.concat(t.received).toString()).toBe("hello");
  });

  it("completes a 0-byte file as soon as the token has arrived", () => {
    const d = makeDownload(0n);
    const t = setup(d);
    t.reader.push(TOKEN);
    expect(t.replies).toHaveLength(1);
    expect(d.status).toBe("complete");
    expect(t.completes).toEqual([0n]);
    expect(t.settled).toEqual([d]);
    expect(t.ended()).toBe(1);
    expect(d.stream.writableEnded).toBe(true);
  });

  it("completes a file across chunks and ends the connection once", () => {
    const d = makeDownload(6n);
    const t = setup(d);
    const statuses: string[] = [];
    d.events.on("status", (s) => statuses.push(s));
    t.reader.push(Buffer.concat([TOKEN, Buffer.from("abc")]));
    expect(d.status).toBe("downloading");
    expect(t.settled).toEqual([]);
    t.reader.push(Buffer.from("de"));
    expect(t.ended()).toBe(0);
    t.reader.push(Buffer.from("f"));
    expect(d.status).toBe("complete");
    expect(t.completes).toEqual([6n]);
    expect(t.settled).toEqual([d]);
    expect(t.ended()).toBe(1);
    expect(Buffer.concat(t.received).toString()).toBe("abcdef");
    expect(statuses).toEqual(["downloading", "complete"]);
  });

  it("ends the connection on an unknown token and ignores what follows", () => {
    const d = makeDownload(10n);
    const t = setup(d);
    t.reader.push(Buffer.from([1, 2, 3, 4, 5, 6]));
    expect(t.ended()).toBe(1);
    expect(t.replies).toHaveLength(0);
    expect(d.status).toBe("connected");
    t.reader.push(Buffer.from("more"));
    expect(t.looked).toEqual(["01020304"]);
    expect(t.ended()).toBe(1);
  });

  it("ignores bytes that arrive after the transfer is complete", () => {
    const d = makeDownload(3n);
    const t = setup(d);
    t.reader.push(Buffer.concat([TOKEN, Buffer.from("abc")]));
    expect(d.status).toBe("complete");
    expect(() => t.reader.push(Buffer.from("zzz"))).not.toThrow();
    expect(d.receivedBytes).toBe(3n);
    expect(t.completes).toEqual([3n]);
    expect(t.ended()).toBe(1);
    expect(Buffer.concat(t.received).toString()).toBe("abc");
  });

  it("cuts an overshooting chunk at the full size", () => {
    const d = makeDownload(4n);
    const t = setup(d);
    t.reader.push(Buffer.concat([TOKEN, Buffer.from("ab")]));
    t.reader.push(Buffer.from("cdefgh"));
    expect(d.receivedBytes).toBe(4n);
    expect(d.status).toBe("complete");
    expect(Buffer.concat(t.received).toString()).toBe("abcd");
    expect(t.completes).toEqual([4n]);
  });

  it("pauses the connection when the stream is full and resumes on drain", () => {
    const d = makeDownload(100n, { highWaterMark: 4 });
    const t = setup(d, { consume: false });
    t.reader.push(Buffer.concat([TOKEN, Buffer.from("abcdef")]));
    expect(t.flow).toEqual(["pause"]);
    t.reader.push(Buffer.from("gh"));
    expect(t.flow).toEqual(["pause"]);
    d.stream.resume();
    return new Promise<void>((resolve) => setImmediate(resolve)).then(() => {
      expect(t.flow).toEqual(["pause", "resume"]);
    });
  });

  it("resumes when the stream closes while the connection is paused", () => {
    const d = makeDownload(100n, { highWaterMark: 4 });
    const t = setup(d, { consume: false });
    t.reader.push(Buffer.concat([TOKEN, Buffer.from("abcdef")]));
    expect(t.flow).toEqual(["pause"]);
    d.stream.destroy();
    return new Promise<void>((resolve) => setImmediate(resolve)).then(() => {
      expect(t.flow).toEqual(["pause", "resume"]);
    });
  });

  it("does not pause the connection for a stream that is already destroyed", () => {
    const d = makeDownload(100n, { highWaterMark: 4 });
    const t = setup(d, { consume: false });
    t.reader.push(TOKEN);
    d.stream.on("error", () => {});
    d.stream.destroy();
    return new Promise<void>((resolve) => setImmediate(resolve)).then(() => {
      expect(() => t.reader.push(Buffer.from("abcdef"))).not.toThrow();
      expect(t.flow).toEqual([]);
    });
  });

  it("writes nothing when a resumed offset is already past the full size", () => {
    const d = makeDownload(4n);
    d.receivedBytes = 6n;
    const t = setup(d);
    t.reader.push(Buffer.concat([TOKEN, Buffer.from("xyz")]));
    expect(d.receivedBytes).toBe(6n);
    expect(t.received).toEqual([]);
    expect(d.status).toBe("complete");
  });

  it("does not pause on the write that completes the file", () => {
    const d = makeDownload(6n, { highWaterMark: 4 });
    const t = setup(d, { consume: false });
    t.reader.push(Buffer.concat([TOKEN, Buffer.from("abcdef")]));
    expect(d.status).toBe("complete");
    expect(t.flow).toEqual([]);
  });

  describe("close", () => {
    it("destroys the stream of a transfer cut short, with no listener on the download or the stream", async () => {
      const d = makeDownload(10n);
      const t = setup(d);
      t.reader.push(Buffer.concat([TOKEN, Buffer.from("abc")]));
      expect(d.events.listenerCount("error")).toBe(0);
      expect(d.stream.listenerCount("error")).toBe(0);
      expect(() => t.reader.close()).not.toThrow();
      expect(t.settled).toEqual([d]);
      expect(d.stream.destroyed).toBe(true);
      // an unhandled 'error' on the stream would crash the run here
      await new Promise<void>((resolve) => setImmediate(resolve));
    });

    it("gives the stream the error when something is listening for it", async () => {
      const d = makeDownload(10n);
      const t = setup(d);
      const errors: Error[] = [];
      d.stream.on("error", (e) => errors.push(e));
      t.reader.push(Buffer.concat([TOKEN, Buffer.from("abc")]));
      t.reader.close();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(d.stream.destroyed).toBe(true);
      expect(errors.map((e) => e.message)).toEqual([
        "Connection closed before transfer completed",
      ]);
    });

    it("tells a listener that the transfer was cut short", () => {
      const d = makeDownload(10n);
      const t = setup(d);
      const errors: Error[] = [];
      d.events.on("error", (e) => errors.push(e));
      t.reader.push(Buffer.concat([TOKEN, Buffer.from("abc")]));
      t.reader.close();
      expect(errors.map((e) => e.message)).toEqual([
        "Connection closed before transfer completed",
      ]);
    });

    it("fail destroys the stream with the connection's error only if the stream has a listener", async () => {
      const d = makeDownload(10n);
      const t = setup(d);
      t.reader.push(Buffer.concat([TOKEN, Buffer.from("abc")]));
      expect(() => t.reader.fail(new Error("reset"))).not.toThrow();
      expect(d.stream.destroyed).toBe(true);
      await new Promise<void>((resolve) => setImmediate(resolve));

      const d2 = makeDownload(10n);
      const t2 = setup(d2);
      const errors: Error[] = [];
      d2.stream.on("error", (e) => errors.push(e));
      t2.reader.push(Buffer.concat([TOKEN, Buffer.from("abc")]));
      t2.reader.fail(new Error("reset"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(errors.map((e) => e.message)).toEqual(["reset"]);
    });

    it("a connection that failed keeps its real cause: close after fail adds no generic error", async () => {
      // stream with a listener: the stream carries the cause, the download's events are not told twice
      const d = makeDownload(10n);
      const t = setup(d);
      const streamErrors: Error[] = [];
      const eventErrors: Error[] = [];
      d.stream.on("error", (e) => streamErrors.push(e));
      d.events.on("error", (e) => eventErrors.push(e));
      t.reader.push(Buffer.concat([TOKEN, Buffer.from("abc")]));
      t.reader.fail(new Error("read ECONNRESET"));
      t.reader.close();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(streamErrors.map((e) => e.message)).toEqual(["read ECONNRESET"]);
      expect(eventErrors).toEqual([]);
      expect(t.settled).toEqual([d]);
    });

    it("a connection that failed tells the download's listeners the real cause when the stream has none", async () => {
      const d = makeDownload(10n);
      const t = setup(d);
      const eventErrors: Error[] = [];
      d.events.on("error", (e) => eventErrors.push(e));
      t.reader.push(Buffer.concat([TOKEN, Buffer.from("abc")]));
      t.reader.fail(new Error("read ECONNRESET"));
      t.reader.close();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(eventErrors.map((e) => e.message)).toEqual(["read ECONNRESET"]);
      expect(d.stream.destroyed).toBe(true);
    });

    it("an error after the transfer is whole changes nothing", async () => {
      const d = makeDownload(3n);
      const t = setup(d);
      const eventErrors: Error[] = [];
      d.events.on("error", (e) => eventErrors.push(e));
      d.stream.on("error", (e) => eventErrors.push(e));
      t.reader.push(Buffer.concat([TOKEN, Buffer.from("abc")]));
      t.reader.fail(new Error("read ECONNRESET"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(eventErrors).toEqual([]);
    });

    it("leaves a completed download alone", () => {
      const d = makeDownload(3n);
      const t = setup(d);
      const errors: Error[] = [];
      d.events.on("error", (e) => errors.push(e));
      t.reader.push(Buffer.concat([TOKEN, Buffer.from("abc")]));
      t.reader.close();
      expect(errors).toEqual([]);
      expect(t.settled).toEqual([d]);
    });

    it("does nothing for a connection that never matched a download", () => {
      const d = makeDownload(10n);
      const t = setup(d);
      t.reader.push(Buffer.from([1, 2, 3, 4]));
      t.reader.close();
      expect(t.settled).toEqual([]);
    });
  });
});

describe("findAwaitingDownload", () => {
  const make = (over: Partial<DownloadWithToken>): DownloadWithToken =>
    ({ ...makeDownload(5n), ...over }) as DownloadWithToken;

  it("matches a connected download by peer and token", () => {
    const d = make({});
    expect(findAwaitingDownload([d], "peer", TOKEN_HEX)).toBe(d);
  });

  it("does not match another peer or another token", () => {
    const d = make({});
    expect(findAwaitingDownload([d], "other", TOKEN_HEX)).toBeUndefined();
    expect(findAwaitingDownload([d], "peer", "00000000")).toBeUndefined();
  });

  it("does not match a download that is already downloading or complete", () => {
    expect(
      findAwaitingDownload(
        [make({ status: "downloading" })],
        "peer",
        TOKEN_HEX,
      ),
    ).toBeUndefined();
    expect(
      findAwaitingDownload([make({ status: "complete" })], "peer", TOKEN_HEX),
    ).toBeUndefined();
  });
});

describe("acceptTransferRequest", () => {
  const queued = (
    status: "requested" | "queued" | "downloading" | "complete",
  ) =>
    ({
      ...makeDownload(0n),
      status,
      token: undefined,
      totalBytes: undefined,
    }) as unknown as Download;

  it("connects a requested or queued download to the peer's offer", () => {
    for (const status of ["requested", "queued"] as const) {
      const d = queued(status);
      const statuses: string[] = [];
      d.events.on("status", (s) => statuses.push(s));
      expect(acceptTransferRequest(d, { token: TOKEN_HEX, size: 9n })).toBe(
        true,
      );
      expect(d.status).toBe("connected");
      expect((d as DownloadWithToken).token).toBe(TOKEN_HEX);
      expect((d as DownloadWithToken).totalBytes).toBe(9n);
      expect(statuses).toEqual(["connected"]);
    }
  });

  it("leaves a download alone once it is downloading or complete", () => {
    for (const status of ["downloading", "complete"] as const) {
      const d = { ...makeDownload(5n), status } as unknown as Download;
      const statuses: string[] = [];
      d.events.on("status", (s) => statuses.push(s));
      expect(acceptTransferRequest(d, { token: "00000001", size: 9n })).toBe(
        false,
      );
      expect(d.status).toBe(status);
      expect((d as DownloadWithToken).token).toBe(TOKEN_HEX);
      expect((d as DownloadWithToken).totalBytes).toBe(5n);
      expect(statuses).toEqual([]);
    }
  });

  it("takes a newer offer on a connected download that has received nothing", () => {
    const d = makeDownload(5n);
    const statuses: string[] = [];
    d.events.on("status", (s) => statuses.push(s));
    expect(acceptTransferRequest(d, { token: "00000001", size: 9n })).toBe(
      true,
    );
    expect(d.status).toBe("connected");
    expect(d.token).toBe("00000001");
    expect(d.totalBytes).toBe(9n);
    expect(statuses).toEqual(["connected"]);
  });

  it("leaves a connected download alone once it has received bytes", () => {
    const d = makeDownload(5n);
    d.receivedBytes = 2n;
    expect(acceptTransferRequest(d, { token: "00000001", size: 9n })).toBe(
      false,
    );
    expect(d.token).toBe(TOKEN_HEX);
    expect(d.totalBytes).toBe(5n);
  });
});

describe("findDownloadForOffer", () => {
  const make = (over: Record<string, unknown>): Download =>
    ({ ...makeDownload(5n), ...over }) as unknown as Download;

  it("finds the download for the peer and file, or nothing", () => {
    const d = make({});
    expect(findDownloadForOffer([d], "peer", "a.flac")).toBe(d);
    expect(findDownloadForOffer([d], "other", "a.flac")).toBeUndefined();
    expect(findDownloadForOffer([d], "peer", "b.flac")).toBeUndefined();
  });

  it("prefers a download that can take the offer over a stale one for the same file", () => {
    const stale = make({ status: "downloading" });
    const live = make({ status: "queued" });
    expect(findDownloadForOffer([stale, live], "peer", "a.flac")).toBe(live);
    const requested = make({ status: "requested" });
    expect(
      findDownloadForOffer(
        [make({ status: "complete" }), requested],
        "peer",
        "a.flac",
      ),
    ).toBe(requested);
  });

  it("counts a connected download with no bytes as able to take an offer", () => {
    const stale = make({ status: "complete" });
    const waiting = make({});
    expect(findDownloadForOffer([stale, waiting], "peer", "a.flac")).toBe(
      waiting,
    );
    const partial = make({ receivedBytes: 2n });
    expect(findDownloadForOffer([partial, waiting], "peer", "a.flac")).toBe(
      waiting,
    );
  });

  it("falls back to the first match when none can take it", () => {
    const first = make({ status: "complete" });
    const second = make({ status: "downloading" });
    expect(findDownloadForOffer([first, second], "peer", "a.flac")).toBe(first);
  });
});

describe("findPendingDownload", () => {
  const make = (over: Record<string, unknown>): Download =>
    ({ ...makeDownload(5n), ...over }) as unknown as Download;

  it("finds the download for the peer and file, or nothing", () => {
    const d = make({ status: "queued" });
    expect(findPendingDownload([d], "peer", "a.flac")).toBe(d);
    expect(findPendingDownload([d], "other", "a.flac")).toBeUndefined();
    expect(findPendingDownload([d], "peer", "b.flac")).toBeUndefined();
  });

  it("prefers a requested or queued entry over a stale one for the same file", () => {
    const stale = make({ status: "complete" });
    const connected = make({});
    const requested = make({ status: "requested" });
    const queued = make({ status: "queued" });
    expect(
      findPendingDownload([stale, connected, requested], "peer", "a.flac"),
    ).toBe(requested);
    expect(findPendingDownload([stale, queued], "peer", "a.flac")).toBe(queued);
  });

  it("falls back to the first match when none is requested or queued", () => {
    const first = make({ status: "downloading" });
    const second = make({});
    expect(findPendingDownload([first, second], "peer", "a.flac")).toBe(first);
  });
});

describe("canBeDenied", () => {
  const make = (over: Record<string, unknown>): Download =>
    ({ ...makeDownload(5n), ...over }) as unknown as Download;

  it("applies to a requested or queued download", () => {
    expect(canBeDenied(make({ status: "requested" }))).toBe(true);
    expect(canBeDenied(make({ status: "queued" }))).toBe(true);
  });

  it("applies to a connected download only while it has received nothing", () => {
    expect(canBeDenied(make({}))).toBe(true);
    expect(canBeDenied(make({ receivedBytes: 2n }))).toBe(false);
  });

  it("does not apply to a download that is downloading, complete or already denied", () => {
    expect(canBeDenied(make({ status: "downloading" }))).toBe(false);
    expect(canBeDenied(make({ status: "complete" }))).toBe(false);
    expect(canBeDenied(make({ status: "denied" }))).toBe(false);
  });
});
