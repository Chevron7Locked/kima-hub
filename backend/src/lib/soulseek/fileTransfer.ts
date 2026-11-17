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

  /** The connection closed: a transfer cut short fails, and the download's stream ends. */
  close(): void {
    const download = this.download;
    if (download && download.status !== "complete") {
      // An EventEmitter throws on 'error' with no listener; a closing connection must not.
      if (download.events.listenerCount("error") > 0) {
        download.events.emit(
          "error",
          new Error("Connection closed before transfer completed"),
        );
      }
      this.port.settle(download);
    }
    if (download && !download.stream.destroyed) download.stream.end();
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
