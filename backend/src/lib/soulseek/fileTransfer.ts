import type {
  ConnectedDownload,
  Download,
  DownloadWithToken,
} from "./downloads";
import { makeDownloadStatusData } from "./downloads";

const TOKEN_BYTES = 4;

/** What a file-transfer connection lets the reader do, so the reader needs no socket. */
export type FileTransferPort = {
  /** The download this 4-byte token (hex) belongs to, if the peer's transfer is one we asked for. */
  findDownload: (tokenHex: string) => DownloadWithToken | undefined;
  /** Bytes to send back to the peer. */
  reply: (data: Buffer) => void;
  /** Close the connection. */
  end: () => void;
  /** The download is complete: drop it from the client's list. */
  settle: (download: DownloadWithToken) => void;
  /** Stop reading from the peer until `resume`. */
  pause: () => void;
  resume: () => void;
};

/**
 * Whether a download still waits for the peer's offer. A connected download that has received
 * nothing counts: the peer offering again means its earlier file connection failed.
 */
function awaitsOffer(download: Download): boolean {
  return (
    download.status === "requested" ||
    download.status === "queued" ||
    (download.status === "connected" && download.receivedBytes === 0n)
  );
}

/**
 * The peer's transfer offer for a download. Only a download still waiting for one takes it: requested,
 * queued, or connected with nothing received (a re-offer replaces the token). A repeat once bytes
 * are arriving must not reset it.
 */
export function acceptTransferRequest(
  download: Download,
  offer: { token: string; size: bigint },
): boolean {
  if (!awaitsOffer(download)) return false;
  const dl = download as unknown as ConnectedDownload;
  dl.status = "connected";
  dl.queuePosition = 0;
  dl.token = offer.token;
  dl.totalBytes = offer.size;
  dl.events.emit("status", "connected", makeDownloadStatusData(dl));
  return true;
}

/** The download a peer's offer is for: one that can take it before a stale one for the same file. */
export function findDownloadForOffer(
  downloads: Download[],
  username: string,
  filename: string,
): Download | undefined {
  const named = downloads.filter(
    (d) => d.username === username && d.filename === filename,
  );
  return named.find(awaitsOffer) ?? named[0];
}

/** The download a peer's queue place or denial is for: a requested or queued one before a stale one for the same file. */
export function findPendingDownload(
  downloads: Download[],
  username: string,
  filename: string,
): Download | undefined {
  const named = downloads.filter(
    (d) => d.username === username && d.filename === filename,
  );
  return (
    named.find((d) => d.status === "requested" || d.status === "queued") ??
    named[0]
  );
}

/**
 * Whether a peer's denial applies to this download. Once the peer has allowed the transfer (connected
 * and on) a denial is stale, unless nothing has arrived yet: then it is the peer changing its mind.
 */
export function canBeDenied(download: Download): boolean {
  return awaitsOffer(download);
}

/** The download a peer's transfer token belongs to: only one still waiting for its transfer. */
export function findAwaitingDownload(
  downloads: Download[],
  username: string,
  tokenHex: string,
): ConnectedDownload | undefined {
  return downloads.find(
    (d): d is ConnectedDownload =>
      d.username === username &&
      d.status === "connected" &&
      d.token === tokenHex,
  );
}

/**
 * Reads one inbound file-transfer connection: the peer sends a 4-byte transfer token, we answer
 * with the offset to resume from, then the peer sends the file bytes. TCP may cut the stream
 * anywhere, so bytes are held until the token is whole.
 */
export class FileTransferReader {
  download: DownloadWithToken | undefined;
  private heldToken: Buffer = Buffer.alloc(0);
  private refused = false;
  private done = false;
  private paused = false;
  private failed = false;

  constructor(private readonly port: FileTransferPort) {}

  push(chunk: Buffer): void {
    if (this.refused || this.done) return;
    if (this.download) {
      this.receiveFileData(this.download, chunk);
      return;
    }

    const held = Buffer.concat([this.heldToken, chunk]);
    if (held.length < TOKEN_BYTES) {
      this.heldToken = held;
      return;
    }
    this.heldToken = Buffer.alloc(0);

    const download = this.port.findDownload(
      held.toString("hex", 0, TOKEN_BYTES),
    );
    if (!download) {
      this.refused = true;
      this.port.end();
      return;
    }
    this.download = download;
    download.status = "downloading";
    download.events.emit(
      "status",
      "downloading",
      makeDownloadStatusData(download),
    );

    const fileOffsetBuffer = Buffer.alloc(8);
    fileOffsetBuffer.writeBigUInt64LE(download.receivedBytes, 0);
    this.port.reply(fileOffsetBuffer);

    // Whatever follows the token is file data. A file with no bytes is already whole.
    const rest = held.subarray(TOKEN_BYTES);
    if (rest.length > 0) this.receiveFileData(download, rest);
    else this.finishIfWhole(download);
  }

  /**
   * The connection failed with `error`, the real cause. The stream carries it when something
   * listens there (`services/soulseek.ts` sorts failures on the stream's error, and a download's own
   * 'error' handler would reach it first and skip the sorting); otherwise the download's own
   * listeners are told. Either way the close that
   * follows adds no generic error over it. A whole transfer is not failed by a late error.
   */
  fail(error: Error): void {
    const download = this.download;
    // Before the token is read there is no download to tie the error to. Left as is: the consumer's
    // timeout ends the wait, and the peer's re-offer takes a connected download that has nothing.
    if (!download || this.failed || this.done) return;
    this.failed = true;
    this.port.settle(download);
    if (download.stream.listenerCount("error") === 0)
      this.tell(download, error);
    this.destroyStream(download, error);
  }

  /** The connection closed: a transfer cut short fails, and a whole one's stream ends. */
  close(): void {
    const download = this.download;
    if (!download || this.failed) return;
    if (download.status === "complete") {
      if (!download.stream.destroyed) download.stream.end();
      return;
    }
    // A plain close mid-transfer (no error from the socket) is left as is: the download's listeners get
    // this generic message, and the peer is not put on cooldown.
    const error = new Error("Connection closed before transfer completed");
    this.port.settle(download);
    this.tell(download, error);
    // A destroyed stream, not an ended one: a consumer must not take the cut-short file as whole.
    this.destroyStream(download, error);
  }

  /** An EventEmitter throws on 'error' with no listener; a failing connection must not. */
  private tell(download: DownloadWithToken, error: Error): void {
    if (download.events.listenerCount("error") > 0)
      download.events.emit("error", error);
  }

  /** A stream with no 'error' listener would throw the error as an uncaught exception, so then it is destroyed bare. */
  private destroyStream(download: DownloadWithToken, error: Error): void {
    const stream = download.stream;
    stream.destroy(stream.listenerCount("error") > 0 ? error : undefined);
  }

  /** File bytes from a peer go to its download; at the full size the transfer ends. */
  private receiveFileData(download: DownloadWithToken, chunk: Buffer): void {
    // A peer that sends more than the file's size gets cut at the size.
    const room =
      download.totalBytes > download.receivedBytes
        ? download.totalBytes - download.receivedBytes
        : 0n;
    const data =
      BigInt(chunk.length) > room ? chunk.subarray(0, Number(room)) : chunk;
    if (data.length === 0) {
      this.finishIfWhole(download);
      return;
    }
    download.receivedBytes += BigInt(data.length);
    const flowing = download.stream.write(data);
    download.events.emit("data", data);
    download.events.emit("progress", {
      receivedBytes: download.receivedBytes,
      totalBytes: download.totalBytes,
      progress:
        download.totalBytes > 0n
          ? Number((download.receivedBytes * 100n) / download.totalBytes) / 100
          : 0,
    });

    this.finishIfWhole(download);
    if (!flowing && !this.done) this.pauseUntilDrained(download);
  }

  /** The stream is full: stop reading from the peer until it drains (or goes away). */
  private pauseUntilDrained(download: DownloadWithToken): void {
    // Nothing will drain a stream that is gone; keep reading so the connection can close.
    if (this.paused || download.stream.destroyed) return;
    this.paused = true;
    this.port.pause();
    const resume = () => {
      download.stream.off("drain", resume);
      download.stream.off("close", resume);
      this.paused = false;
      this.port.resume();
    };
    download.stream.once("drain", resume);
    download.stream.once("close", resume);
  }

  private finishIfWhole(download: DownloadWithToken): void {
    if (download.receivedBytes < download.totalBytes) return;
    this.done = true;
    this.port.end();
    download.stream.end();
    download.status = "complete";
    download.events.emit("complete", download.receivedBytes);
    download.events.emit(
      "status",
      "complete",
      makeDownloadStatusData(download),
    );
    this.port.settle(download);
  }
}
