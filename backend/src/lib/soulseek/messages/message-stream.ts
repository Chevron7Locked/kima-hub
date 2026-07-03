import stream from 'stream'

import { MessageParser } from './message-parser'

// Real Soulseek protocol messages are small (well under 1 MB); a declared length
// beyond this is either a corrupt frame or a hostile peer trying to make us
// buffer unbounded data while we wait for the rest of a "message" that will
// never legitimately arrive. Bound it to avoid an OOM.
const MAX_MESSAGE_SIZE = 8 * 1024 * 1024

export class MessageStream extends stream.Writable {
  rest: Buffer | undefined

  _write(chunk: Buffer, enc: BufferEncoding, next: (error?: Error | null) => void) {
    this.read(this.rest ? Buffer.concat([this.rest, chunk]) : chunk)
    next()
  }

  read(data: Buffer) {
    while (true) {
      if (data.length < 4) {
        this.rest = data.length > 0 ? data : undefined
        return
      }

      const size = data.readUInt32LE()
      if (size > MAX_MESSAGE_SIZE) {
        this.rest = undefined
        this.emit('error', new Error(`Soulseek message size ${size} exceeds max ${MAX_MESSAGE_SIZE}`))
        return
      }

      if (size + 4 <= data.length) {
        this.emit('message', new MessageParser(data.slice(0, size + 4)))
        data = data.slice(size + 4)
      } else {
        this.rest = data
        return
      }
    }
  }

  reset() {
    this.rest = undefined
  }
}
