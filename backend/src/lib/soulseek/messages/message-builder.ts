export class MessageBuilder {
  chunks: Buffer[]

  constructor() {
    this.chunks = []
  }

  int8(value: number) {
    const b = Buffer.alloc(1)
    b.writeUInt8(value, 0)
    this.chunks.push(b)
    return this
  }

  int32(value: number) {
    const b = Buffer.alloc(4)
    b.writeUInt32LE(value, 0)
    this.chunks.push(b)
    return this
  }

  int64(value: number | bigint) {
    const b = Buffer.alloc(8)
    b.writeBigUInt64LE(BigInt(value), 0)
    this.chunks.push(b)
    return this
  }

  str(value: string) {
    const b = Buffer.from(value, 'utf8')
    const s = Buffer.alloc(4)
    s.writeUInt32LE(b.length, 0)
    this.chunks.push(s, b)
    return this
  }

  rawHexStr(value: string) {
    this.chunks.push(Buffer.from(value, 'hex'))
    return this
  }

  buffer(value: Buffer) {
    this.chunks.push(value)
    return this
  }

  getBuffer() {
    const data = Buffer.concat(this.chunks)
    const b = Buffer.alloc(4)
    b.writeUInt32LE(data.length, 0)
    return Buffer.concat([b, data])
  }
}
