/**
 * In slskd mode a finished download is read from slskd's downloads folder, and a peer chooses the file name. Every
 * name and link case is tried once, at `findFinishedFile`. Below that, one case per layer: through the slskd client a
 * hostile name ends the download with an error and not a byte of an outside file is copied, and through the Soulseek
 * service the next source is tried. The folder, the files and the links are real; slskd is a local HTTP server
 * answering with its transfer reply shape.
 */
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import type { AddressInfo } from 'net'

import { prisma } from '../../../utils/db'
import { invalidateSystemSettingsCache } from '../../../utils/systemSettings'
import { soulseekService } from '../../../services/soulseek'
import { SlskdClient, configureSlskd, peekSlskdConfig } from '../slskd-client'
import { findFinishedFile } from '../finishedFile'

let base: string
let root: string

beforeEach(async () => {
  base = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'finished-file-')))
  root = path.join(base, 'downloads')
  await fs.promises.mkdir(root)
})

afterEach(async () => {
  await fs.promises.rm(base, { recursive: true, force: true })
})

async function put(file: string, contents = 'x'): Promise<string> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
  await fs.promises.writeFile(file, contents)
  return file
}

describe('a normal finished download', () => {
  it('is found at the path the peer named', async () => {
    const file = await put(path.join(root, 'Artist', 'Album', '01 - Song.flac'))
    expect(await findFinishedFile(root, 'Artist/Album/01 - Song.flac')).toEqual({ found: true, path: file })
  })

  it('is found from a Windows peer name, in the matching folder', async () => {
    const file = await put(path.join(root, 'Artist', 'Album', '01 - Song.flac'))
    expect(await findFinishedFile(root, '@@abc\\Music\\Artist\\Album\\01 - Song.flac')).toEqual({ found: true, path: file })
  })
})

describe('a name with a .. part', () => {
  it.each([
    ['../secret.flac'],
    ['..\\secret.flac'],
    ['Artist/../../secret.flac'],
    ['@@peer\\Music\\..\\..\\secret.flac'],
  ])('%s is refused, though it reaches a real file outside the folder', async (name) => {
    await put(path.join(base, 'secret.flac'), 'private')
    expect(await findFinishedFile(root, name)).toEqual({ found: false, reason: 'outside' })
  })
})

describe('a name that only contains dots', () => {
  it.each([
    ['Album.../01 - Song.flac'],
    ['Artist/..intro.flac'],
    ['Vol. 1../02 - Song.flac'],
    ['Artist\\Live..\\..hidden.flac'],
  ])('%s is still found', async (name) => {
    const real = await put(path.join(root, ...name.split(/[\\/]/)))
    expect(await findFinishedFile(root, name)).toEqual({ found: true, path: real })
  })
})

describe('a candidate that leads outside the folder through a link', () => {
  it('a file link pointing at a real file outside is refused', async () => {
    const secret = await put(path.join(base, 'secret.flac'), 'private')
    await fs.promises.mkdir(path.join(root, 'Artist'))
    await fs.promises.symlink(secret, path.join(root, 'Artist', 'song.flac'))
    expect(await findFinishedFile(root, 'Artist/song.flac')).toEqual({ found: false, reason: 'outside' })
  })

  it('a folder link pointing outside is refused', async () => {
    await put(path.join(base, 'elsewhere', 'song.flac'), 'private')
    await fs.promises.symlink(path.join(base, 'elsewhere'), path.join(root, 'Linked'))
    expect(await findFinishedFile(root, 'Linked/song.flac')).toEqual({ found: false, reason: 'outside' })
  })
})

describe('what counts as inside the folder', () => {
  it('a sibling folder that shares the folder name as a prefix is outside', async () => {
    await put(`${root}-evil/song.flac`, 'private')
    await fs.promises.symlink(`${root}-evil`, path.join(root, 'link'))
    expect(await findFinishedFile(root, 'link/song.flac')).toEqual({ found: false, reason: 'outside' })
  })

  it('a link that stays inside the folder gives the real path of the file', async () => {
    const real = await put(path.join(root, 'Real', 'song.flac'))
    await fs.promises.symlink(real, path.join(root, 'alias.flac'))
    expect(await findFinishedFile(root, 'alias.flac')).toEqual({ found: true, path: real })
  })

  it('a downloads folder that is itself a link is judged by where it really is', async () => {
    const realFolder = path.join(base, 'real-downloads')
    const file = await put(path.join(realFolder, 'Artist', 'song.flac'))
    const linked = path.join(base, 'linked-downloads')
    await fs.promises.symlink(realFolder, linked)
    expect(await findFinishedFile(linked, 'Artist/song.flac')).toEqual({ found: true, path: file })
  })

  it('the folder itself is not a finished file', async () => {
    expect(await findFinishedFile(root, '.')).toEqual({ found: false, reason: 'missing' })
    expect(await findFinishedFile(root, '')).toEqual({ found: false, reason: 'missing' })
  })

  it('a folder is not a finished file', async () => {
    await fs.promises.mkdir(path.join(root, 'Artist', 'Album'), { recursive: true })
    expect(await findFinishedFile(root, 'Artist/Album')).toEqual({ found: false, reason: 'missing' })
  })

  it('a missing file is reported as missing', async () => {
    expect(await findFinishedFile(root, 'Artist/none.flac')).toEqual({ found: false, reason: 'missing' })
  })
})

describe('a finished download found by its file name alone', () => {
  it('is found under any folder inside the downloads folder', async () => {
    const real = await put(path.join(root, 'Deep', 'Nested', 'song.flac'))
    expect(await findFinishedFile(root, '@@peer\\Music\\Other\\song.flac')).toEqual({ found: true, path: real })
  })

  it('does not follow a folder link out of the downloads folder', async () => {
    await put(path.join(base, 'elsewhere', 'song.flac'), 'private')
    await fs.promises.symlink(path.join(base, 'elsewhere'), path.join(root, 'Linked'))
    expect(await findFinishedFile(root, 'Nope/song.flac')).toEqual({ found: false, reason: 'missing' })
  })

  it('a file link carrying the same name is refused, not skipped', async () => {
    const secret = await put(path.join(base, 'secret.flac'), 'private')
    await fs.promises.symlink(secret, path.join(root, 'song.flac'))
    expect(await findFinishedFile(root, 'Nope/song.flac')).toEqual({ found: false, reason: 'outside' })
  })

  it('does not take a file link deeper down as the match', async () => {
    const secret = await put(path.join(base, 'secret.flac'), 'private')
    await fs.promises.mkdir(path.join(root, 'Deep'))
    await fs.promises.symlink(secret, path.join(root, 'Deep', 'other.flac'))
    expect(await findFinishedFile(root, 'Nope/other.flac')).toEqual({ found: false, reason: 'missing' })
  })
})

describe('a refused name', () => {
  it('does not fall back to a shorter ending of the same name', async () => {
    const secret = await put(path.join(base, 'secret.flac'), 'private')
    await put(path.join(root, 'song.flac'))
    await fs.promises.mkdir(path.join(root, 'b'))
    await fs.promises.symlink(secret, path.join(root, 'b', 'song.flac'))
    expect(await findFinishedFile(root, 'a/b/song.flac')).toEqual({ found: false, reason: 'outside' })
  })

  it('does not fall back to a file of the same name elsewhere in the folder', async () => {
    await put(path.join(root, 'Deep', 'song.flac'))
    expect(await findFinishedFile(root, '../x/song.flac')).toEqual({ found: false, reason: 'outside' })
    expect(await findFinishedFile(root, 'x\\..\\song.flac')).toEqual({ found: false, reason: 'outside' })
  })
})

describe('with slskd answering', () => {
  const PEER = 'badpeer'
  const SECRET = 'TOP-SECRET-BYTES'
  const SETTINGS = { id: 'default' }

  let server: http.Server
  let savedClient: ReturnType<typeof peekSlskdConfig>
  let savedRow: Awaited<ReturnType<typeof prisma.systemSettings.findUnique>>
  let files: Record<string, string> = {}
  let enqueued: unknown[] = []

  const url = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  function transfers() {
    return Object.entries(files).map(([username, filename], i) => ({
      username,
      directories: [
        {
          directory: 'Music\\Album',
          fileCount: 1,
          files: [
            {
              id: `00000000-0000-4000-8000-00000000000${i}`,
              username,
              direction: 'Download',
              filename,
              size: 16,
              state: 'Completed, Succeeded',
              bytesTransferred: 16,
              percentComplete: 100,
            },
          ],
        },
      ],
    }))
  }

  beforeAll(async () => {
    savedClient = peekSlskdConfig()
    savedRow = await prisma.systemSettings.findUnique({ where: SETTINGS })
    server = http.createServer((req, res) => {
      const json = (status: number, body?: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(body === undefined ? undefined : JSON.stringify(body))
      }
      if (req.method === 'GET' && req.url === '/api/v0/application') {
        return json(200, { server: { isConnected: true, isLoggedIn: true } })
      }
      if (req.method === 'POST' && req.url?.startsWith('/api/v0/transfers/downloads/')) {
        return json(201, { enqueued, failed: [] })
      }
      if (req.method === 'GET' && req.url === '/api/v0/transfers/downloads') return json(200, transfers())
      if (req.method === 'DELETE') return json(204)
      return json(404, {})
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  })

  afterAll(async () => {
    configureSlskd({ url: savedClient.url, apiKey: savedClient.apiKey, downloads: savedClient.downloads })
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  describe('through the slskd client', () => {
    let client: SlskdClient

    beforeEach(() => {
      configureSlskd({ url: url(), apiKey: 'k', downloads: root })
      client = new SlskdClient()
    })

    afterEach(() => {
      client.destroy()
    })

    /** Runs one download to its end: the bytes copied, and the error or the completion that ended it. */
    async function run(name: string): Promise<{ bytes: string; error?: string; completed: boolean }> {
      files = { [PEER]: name }
      enqueued = [{ filename: name }]
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

    it('ends a download whose name leaves the folder in an error naming the peer, and copies nothing', async () => {
      await put(path.join(base, 'secret.flac'), SECRET)
      expect(await run('../secret.flac')).toEqual({
        bytes: '',
        completed: false,
        error: 'Soulseek peer badpeer sent a file name outside the downloads folder: ../secret.flac',
      })
    }, 20000)
  })

  describe('through the Soulseek service', () => {
    let library: string

    const match = (username: string, fullPath: string, filename: string) => ({
      username,
      filename,
      fullPath,
      size: 10,
      quality: 'FLAC',
      score: 10,
    })

    beforeEach(async () => {
      library = path.join(base, 'library')
      await fs.promises.mkdir(library)
      const data = {
        soulseekEnabled: true,
        soulseekMode: 'slskd',
        slskdUrl: url(),
        soulseekDownloadPath: root,
      }
      await prisma.systemSettings.upsert({ where: SETTINGS, update: data, create: { ...SETTINGS, ...data } })
      invalidateSystemSettingsCache()
    })

    afterEach(async () => {
      soulseekService.disconnect()
      if (savedRow) {
        await prisma.systemSettings.update({ where: SETTINGS, data: savedRow })
      } else {
        await prisma.systemSettings.deleteMany({ where: SETTINGS })
      }
      invalidateSystemSettingsCache()
    })

    it('fails with an error naming the peer when the only source sends a name leaving the folder, and writes nothing', async () => {
      await put(path.join(base, 'secret.flac'), SECRET)
      files = { badpeer: '../secret.flac' }
      enqueued = []

      const result = await soulseekService.downloadBestMatch(
        'A',
        'T',
        'Alb',
        [match('badpeer', '../secret.flac', 'secret.flac')],
        library,
      )

      expect(result).toEqual({
        success: false,
        error:
          'All 1 attempts failed: badpeer: Soulseek peer badpeer sent a file name outside the downloads folder: ../secret.flac',
      })
      const written = (await fs.promises.readdir(library, { recursive: true })).filter((f) => f.endsWith('.flac'))
      expect(written).toEqual([])
    }, 30000)

    it('tries the next source after one whose name leaves the folder, and keeps the outside file out', async () => {
      await put(path.join(base, 'secret.flac'), SECRET)
      await put(path.join(root, 'Artist', 'Album', 'good.flac'), 'good-bytes')
      files = { badpeer: '../secret.flac', goodpeer: 'Artist\\Album\\good.flac' }
      enqueued = []

      const result = await soulseekService.downloadBestMatch(
        'A',
        'T',
        'Alb',
        [match('badpeer', '../secret.flac', 'secret.flac'), match('goodpeer', 'Artist\\Album\\good.flac', 'good.flac')],
        library,
      )

      expect(result.success).toBe(true)
      expect(await fs.promises.readFile(result.filePath!, 'utf8')).toBe('good-bytes')
      const written = (await fs.promises.readdir(library, { recursive: true })).filter((f) => f.endsWith('.flac'))
      expect(written).toHaveLength(1)
    }, 40000)
  })
})
