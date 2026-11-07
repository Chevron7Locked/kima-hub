/**
 * In slskd mode a finished download is read from slskd's downloads folder. A peer chooses the file name, so a name that
 * leads outside the folder must end that download with an error and never copy a byte of what it reaches. slskd is a
 * local HTTP server answering with its transfer reply shape; the folder, the files and the links are real.
 */
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import type { AddressInfo } from 'net'

import { SlskdClient, configureSlskd, peekSlskdConfig } from '../slskd-client'

const PEER = 'peer1'
const SECRET = 'TOP-SECRET-BYTES'

let base: string
let root: string
let server: http.Server
let client: SlskdClient
let saved: ReturnType<typeof peekSlskdConfig>
let finishedName = ''

function transferReply() {
  return [
    {
      username: PEER,
      directories: [
        {
          directory: 'Music\\Album',
          fileCount: 1,
          files: [
            {
              id: '3b6a0c77-1d4e-4b0e-9c61-5e0f1c2a7d11',
              username: PEER,
              direction: 'Download',
              filename: finishedName,
              size: 16,
              state: 'Completed, Succeeded',
              bytesTransferred: 16,
              percentComplete: 100,
            },
          ],
        },
      ],
    },
  ]
}

beforeAll(async () => {
  saved = peekSlskdConfig()
  server = http.createServer((req, res) => {
    const json = (status: number, body?: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(body === undefined ? undefined : JSON.stringify(body))
    }
    if (req.method === 'GET' && req.url === '/api/v0/application') return json(200, { server: { isConnected: true } })
    if (req.method === 'POST' && req.url === `/api/v0/transfers/downloads/${PEER}`) {
      return json(201, { enqueued: [{ filename: finishedName }], failed: [] })
    }
    if (req.method === 'GET' && req.url === '/api/v0/transfers/downloads') return json(200, transferReply())
    if (req.method === 'DELETE') return json(204)
    return json(404, {})
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
})

afterAll(async () => {
  configureSlskd({ url: saved.url, apiKey: saved.apiKey, downloads: saved.downloads })
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(async () => {
  base = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'slskd-finished-')))
  root = path.join(base, 'downloads')
  await fs.promises.mkdir(root)
  configureSlskd({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, apiKey: 'k', downloads: root })
  client = new SlskdClient()
})

afterEach(async () => {
  client.destroy()
  await fs.promises.rm(base, { recursive: true, force: true })
})

/** Runs one download to its end: the bytes copied, and the error or the completion that ended it. */
async function run(name: string): Promise<{ bytes: string; error?: string; completed: boolean }> {
  finishedName = name
  const dl = await client.download(PEER, name)
  const chunks: Buffer[] = []
  dl.stream.on('data', (c: Buffer) => chunks.push(c))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('download did not end')), 15000)
    dl.events.on('error', (err: Error) => {
      clearTimeout(timer)
      resolve({ bytes: Buffer.concat(chunks).toString(), error: err.message, completed: false })
    })
    dl.events.on('complete', () => {
      clearTimeout(timer)
      resolve({ bytes: Buffer.concat(chunks).toString(), completed: true })
    })
  })
}

async function put(file: string, contents: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
  await fs.promises.writeFile(file, contents)
}

describe('a finished slskd download', () => {
  it('with a name that climbs out of the folder ends in an error and copies nothing', async () => {
    await put(path.join(base, 'secret.flac'), SECRET)
    const result = await run('../secret.flac')
    expect(result).toEqual({
      bytes: '',
      completed: false,
      error: 'Soulseek peer peer1 sent a file name outside the downloads folder: ../secret.flac',
    })
  }, 20000)

  it('whose name reaches a file outside the folder through a link ends in an error and copies nothing', async () => {
    await put(path.join(base, 'secret.flac'), SECRET)
    await fs.promises.mkdir(path.join(root, 'Artist'))
    await fs.promises.symlink(path.join(base, 'secret.flac'), path.join(root, 'Artist', 'song.flac'))
    const result = await run('@@peer1\\Music\\Artist\\song.flac')
    expect(result).toEqual({
      bytes: '',
      completed: false,
      error: 'Soulseek peer peer1 sent a file name outside the downloads folder: @@peer1\\Music\\Artist\\song.flac',
    })
  }, 20000)

  it('with a normal Windows peer name is copied from the matching folder', async () => {
    await put(path.join(root, 'Artist', 'Album', '01 - Song.flac'), 'song-bytes')
    const result = await run('@@abc\\Music\\Artist\\Album\\01 - Song.flac')
    expect(result).toEqual({ bytes: 'song-bytes', completed: true })
  }, 20000)
})
