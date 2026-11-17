import type { DownloadWithToken } from './downloads'
import { makeDownloadStatusData } from './downloads'

const TOKEN_BYTES = 4

/** What a file-transfer connection lets the reader do, so the reader needs no socket. */
export type FileTransferPort = {
  /** The download this 4-byte token (hex) belongs to, if the peer's transfer is one we asked for. */
  findDownload: (tokenHex: string) => DownloadWithToken | undefined
  /** Bytes to send back to the peer. */
  reply: (data: Buffer) => void
  /** Close the connection. */
  end: () => void
  /** The download is complete: drop it from the client's list. */
  settle: (download: DownloadWithToken) => void
}

/**
 * Reads one inbound file-transfer connection: the peer sends a 4-byte transfer token, we answer
 * with the offset to resume from, then the peer sends the file bytes. TCP may cut the stream
 * anywhere, so bytes are held until the token is whole.
 */
export class FileTransferReader {
  download: DownloadWithToken | undefined
  private heldToken: Buffer = Buffer.alloc(0)
  private refused = false

  constructor(private readonly port: FileTransferPort) {}

  push(chunk: Buffer): void {
    if (this.refused) return
    if (this.download) {
      this.receiveFileData(this.download, chunk)
      return
    }

    const held = Buffer.concat([this.heldToken, chunk])
    if (held.length < TOKEN_BYTES) {
      this.heldToken = held
      return
    }
    this.heldToken = Buffer.alloc(0)

    const download = this.port.findDownload(held.toString('hex', 0, TOKEN_BYTES))
    if (!download) {
      this.refused = true
      this.port.end()
      return
    }
    this.download = download
    download.status = 'downloading'
    download.events.emit('status', 'downloading', makeDownloadStatusData(download))

    const fileOffsetBuffer = Buffer.alloc(8)
    fileOffsetBuffer.writeBigUInt64LE(download.receivedBytes, 0)
    this.port.reply(fileOffsetBuffer)

    // Whatever follows the token is file data. A file with no bytes is already whole.
    const rest = held.subarray(TOKEN_BYTES)
    if (rest.length > 0) this.receiveFileData(download, rest)
    else this.finishIfWhole(download)
  }

  /** File bytes from a peer go to its download; at the full size the transfer ends. */
  private receiveFileData(download: DownloadWithToken, data: Buffer): void {
    download.receivedBytes += BigInt(data.length)
    download.stream.write(data)
    download.events.emit('data', data)
    download.events.emit('progress', {
      receivedBytes: download.receivedBytes,
      totalBytes: download.totalBytes,
      progress:
        download.totalBytes > 0n
          ? Number((download.receivedBytes * 100n) / download.totalBytes) / 100
          : 0,
    })

    this.finishIfWhole(download)
  }

  private finishIfWhole(download: DownloadWithToken): void {
    if (download.receivedBytes < download.totalBytes) return
    this.port.end()
    download.stream.end()
    download.status = 'complete'
    download.events.emit('complete', download.receivedBytes)
    download.events.emit('status', 'complete', makeDownloadStatusData(download))
    this.port.settle(download)
  }
}
