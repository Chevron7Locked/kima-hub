import { EventEmitter } from 'events'
import stream from 'stream'

import type { DownloadWithToken, SlskDownloadEventEmitter } from '../downloads'
import { FileTransferReader } from '../fileTransfer'

const TOKEN = Buffer.from([0xde, 0xad, 0xbe, 0xef])
const TOKEN_HEX = 'deadbeef'

function makeDownload(totalBytes: bigint): DownloadWithToken {
  return {
    status: 'connected',
    username: 'peer',
    filename: 'a.flac',
    receivedBytes: 0n,
    stream: new stream.PassThrough(),
    events: new EventEmitter() as SlskDownloadEventEmitter,
    requestQueuePosition: () => {},
    queuePosition: 0,
    token: TOKEN_HEX,
    totalBytes,
  } as DownloadWithToken
}

function setup(download: DownloadWithToken) {
  const replies: Buffer[] = []
  const settled: DownloadWithToken[] = []
  const looked: string[] = []
  let ended = 0
  const reader = new FileTransferReader({
    findDownload: (token) => {
      looked.push(token)
      return token === TOKEN_HEX ? download : undefined
    },
    reply: (b) => replies.push(b),
    end: () => {
      ended++
    },
    settle: (d) => settled.push(d),
  })
  const received: Buffer[] = []
  download.stream.on('data', (b: Buffer) => received.push(b))
  const completes: bigint[] = []
  download.events.on('complete', (n) => completes.push(n))
  return { reader, replies, settled, looked, received, completes, ended: () => ended }
}

describe('FileTransferReader', () => {
  it('matches a token split over two chunks', () => {
    const d = makeDownload(10n)
    const t = setup(d)
    t.reader.push(TOKEN.subarray(0, 2))
    expect(t.looked).toEqual([])
    expect(t.ended()).toBe(0)
    t.reader.push(Buffer.concat([TOKEN.subarray(2), Buffer.from('abc')]))
    expect(t.looked).toEqual([TOKEN_HEX])
    expect(d.status).toBe('downloading')
    expect(t.replies).toHaveLength(1)
    expect(t.replies[0].readBigUInt64LE(0)).toBe(0n)
    expect(d.receivedBytes).toBe(3n)
    expect(Buffer.concat(t.received).toString()).toBe('abc')
    expect(t.ended()).toBe(0)
  })

  it('matches a token split over three chunks', () => {
    const d = makeDownload(10n)
    const t = setup(d)
    t.reader.push(TOKEN.subarray(0, 1))
    t.reader.push(TOKEN.subarray(1, 3))
    expect(t.looked).toEqual([])
    expect(t.ended()).toBe(0)
    t.reader.push(TOKEN.subarray(3))
    expect(t.looked).toEqual([TOKEN_HEX])
    expect(d.status).toBe('downloading')
    expect(t.replies).toHaveLength(1)
    expect(d.receivedBytes).toBe(0n)
  })

  it('takes the token and file data from one chunk', () => {
    const d = makeDownload(10n)
    const t = setup(d)
    t.reader.push(Buffer.concat([TOKEN, Buffer.from('hello')]))
    expect(t.replies).toHaveLength(1)
    expect(d.receivedBytes).toBe(5n)
    expect(Buffer.concat(t.received).toString()).toBe('hello')
  })

  it('completes a 0-byte file as soon as the token has arrived', () => {
    const d = makeDownload(0n)
    const t = setup(d)
    t.reader.push(TOKEN)
    expect(t.replies).toHaveLength(1)
    expect(d.status).toBe('complete')
    expect(t.completes).toEqual([0n])
    expect(t.settled).toEqual([d])
    expect(t.ended()).toBe(1)
    expect(d.stream.writableEnded).toBe(true)
  })

  it('completes a file across chunks and ends the connection once', () => {
    const d = makeDownload(6n)
    const t = setup(d)
    const statuses: string[] = []
    d.events.on('status', (s) => statuses.push(s))
    t.reader.push(Buffer.concat([TOKEN, Buffer.from('abc')]))
    expect(d.status).toBe('downloading')
    expect(t.settled).toEqual([])
    t.reader.push(Buffer.from('de'))
    expect(t.ended()).toBe(0)
    t.reader.push(Buffer.from('f'))
    expect(d.status).toBe('complete')
    expect(t.completes).toEqual([6n])
    expect(t.settled).toEqual([d])
    expect(t.ended()).toBe(1)
    expect(Buffer.concat(t.received).toString()).toBe('abcdef')
    expect(statuses).toEqual(['downloading', 'complete'])
  })

  it('ends the connection on an unknown token and ignores what follows', () => {
    const d = makeDownload(10n)
    const t = setup(d)
    t.reader.push(Buffer.from([1, 2, 3, 4, 5, 6]))
    expect(t.ended()).toBe(1)
    expect(t.replies).toHaveLength(0)
    expect(d.status).toBe('connected')
    t.reader.push(Buffer.from('more'))
    expect(t.looked).toEqual(['01020304'])
    expect(t.ended()).toBe(1)
  })
})
