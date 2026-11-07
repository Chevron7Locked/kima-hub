/**
 * slskd REST adapter implementing ISlskClient: Kima drives search and download
 * over HTTP while slskd handles the Soulseek network. Selected by client.ts.
 */

import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import http from 'http'
import https from 'https'
import fs from 'fs'

import { findFinishedFile } from './finishedFile'
import type { Download, SlskDownloadEventEmitter } from './downloads'
import type { FileSearchResponse } from './messages/from/peer'
import type { FileAttribute } from './messages/common'

// Defaults come from the environment; configureSlskd() overrides them from user settings.
let SLSKD_URL = process.env.SLSKD_URL || 'http://gluetun-slsk:5030'
let SLSKD_API_KEY = process.env.SLSKD_API_KEY || ''
let SLSKD_DOWNLOADS = process.env.SLSKD_DOWNLOADS || '/soulseek-downloads'

/** Overrides the slskd connection settings; an empty url or downloads path is ignored so it never clobbers a working default. */
export function configureSlskd(opts: { url?: string | null; apiKey?: string | null; downloads?: string | null }): void {
  if (opts.url) SLSKD_URL = opts.url
  if (opts.apiKey != null) SLSKD_API_KEY = opts.apiKey
  if (opts.downloads) SLSKD_DOWNLOADS = opts.downloads
}

/** The current slskd connection settings, so the connection test can restore them after probing a candidate URL. */
export function peekSlskdConfig(): { url: string; apiKey: string; downloads: string } {
  return { url: SLSKD_URL, apiKey: SLSKD_API_KEY, downloads: SLSKD_DOWNLOADS }
}

function slskdRequest(method: string, urlPath: string, body?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const base = new URL(SLSKD_URL)
    // An https:// slskd goes over TLS, never plaintext, which would leak the API key
    const isHttps = base.protocol === 'https:'
    const transport = isHttps ? https : http
    const opts: http.RequestOptions = {
      hostname: base.hostname,
      port: base.port || (isHttps ? 443 : 80),
      path: urlPath,
      method,
      headers: { 'Content-Type': 'application/json' } as Record<string, string>,
      timeout: 30000,
    }
    if (SLSKD_API_KEY) (opts.headers as Record<string, string>)['X-API-Key'] = SLSKD_API_KEY

    const req = transport.request(opts, (res) => {
      let data = ''
      res.on('data', (chunk: string) => (data += chunk))
      res.on('end', () => {
        if (res.statusCode! >= 400) {
          reject(new Error(`slskd ${method} ${urlPath}: ${res.statusCode} ${data.slice(0, 200)}`))
          return
        }
        if (res.statusCode === 204 || !data) {
          resolve(null)
          return
        }
        try {
          resolve(JSON.parse(data))
        } catch {
          resolve(data)
        }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error(`slskd ${method} ${urlPath} timed out`))
    })
    if (body != null) req.write(JSON.stringify(body))
    req.end()
  })
}

const slskdGet = (p: string) => slskdRequest('GET', p)
const slskdPost = (p: string, b?: unknown) => slskdRequest('POST', p, b)
const slskdDelete = (p: string) => slskdRequest('DELETE', p)
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

class FakeServerConn extends EventEmitter {
  destroyed = false
  writable = true
  private _healthInterval: ReturnType<typeof setInterval> | null = null

  markConnected(): void {
    this.destroyed = false
    this.writable = true
    process.nextTick(() => this.emit('connect'))
    this._startHealthPoll()
  }

  markDisconnected(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.writable = false
    this._stopHealthPoll()
    this.emit('close')
  }

  private _startHealthPoll(): void {
    this._stopHealthPoll()
    this._healthInterval = setInterval(async () => {
      try {
        const app = await slskdGet('/api/v0/application')
        if (!app.server || !app.server.isConnected) this.markDisconnected()
      } catch {
        this.markDisconnected()
      }
    }, 30000)
    if (this._healthInterval.unref) this._healthInterval.unref()
  }

  private _stopHealthPoll(): void {
    if (this._healthInterval) {
      clearInterval(this._healthInterval)
      this._healthInterval = null
    }
  }

  destroy(): void {
    this.markDisconnected()
  }
}

interface SlskdSearchFile {
  filename: string
  size: number
  length?: number
  sampleRate?: number
  bitDepth?: number
  isLocked?: boolean
}

interface SlskdSearchResponse {
  username: string
  hasFreeUploadSlot: boolean
  uploadSpeed?: number
  queueLength?: number
  token?: number
  files?: SlskdSearchFile[]
}

interface SlskdTransferFile {
  filename: string
  size?: number
  bytesTransferred?: number
  state?: string
  placeInQueue?: number
}

interface SlskdTransferDirectory {
  files?: SlskdTransferFile[]
}

interface SlskdTransferUserBlock {
  username: string
  directories?: SlskdTransferDirectory[]
}

/**
 * The vendored SlskClient's surface (login, search, download, removeDownload,
 * destroy, server.conn, loggedIn, downloads) served through slskd's REST API.
 */
export class SlskdClient extends EventEmitter {
  loggedIn = false
  downloads: Download[] = []
  server: { conn: FakeServerConn }

  private _fileSizeCache = new Map<string, number>()
  // Evicts the oldest entry (Map keeps insertion order) so the cache stays bounded
  private static readonly FILE_SIZE_CACHE_MAX = 10000

  private _cacheFileSize(key: string, size: number): void {
    if (this._fileSizeCache.size >= SlskdClient.FILE_SIZE_CACHE_MAX) {
      const oldest = this._fileSizeCache.keys().next().value
      if (oldest !== undefined) this._fileSizeCache.delete(oldest)
    }
    this._fileSizeCache.set(key, size)
  }

  constructor() {
    super()
    this.server = { conn: new FakeServerConn() }
    this._initConnection()
  }

  private async _initConnection(): Promise<void> {
    try {
      const app = await slskdGet('/api/v0/application')
      if (app && app.server) {
        this.server.conn.markConnected()
      } else {
        this.server.conn.emit('error', new Error('slskd returned unexpected application state'))
      }
    } catch (err: any) {
      this.server.conn.emit('error', new Error('slskd unreachable: ' + err.message))
    }
  }

  async login(_username: string, _password: string, _timeout?: number): Promise<void> {
    const app = await slskdGet('/api/v0/application')
    if (!app.server || !app.server.isConnected || !app.server.isLoggedIn) {
      throw new Error('slskd is not connected to Soulseek network')
    }
    this.loggedIn = true
  }

  async search(
    query: string,
    { timeout = 10000, onResult, maxResponses = 100 }: {
      timeout?: number
      onResult?: (result: FileSearchResponse) => void
      maxResponses?: number
    } = {}
  ): Promise<FileSearchResponse[]> {
    const searchResult = await slskdPost('/api/v0/searches', {
      searchText: query,
      responseLimit: maxResponses,
    })
    const searchId = searchResult.id

    const results: FileSearchResponse[] = []
    const seenUsers = new Set<string>()
    const deadline = Date.now() + timeout
    const POLL_INTERVAL = 1000

    try {
      while (Date.now() < deadline) {
        await sleep(POLL_INTERVAL)

        let responses: SlskdSearchResponse[]
        try {
          responses = await slskdGet(`/api/v0/searches/${searchId}/responses`)
        } catch {
          continue
        }
        if (!Array.isArray(responses)) continue

        for (const resp of responses) {
          if (seenUsers.has(resp.username)) continue
          seenUsers.add(resp.username)
          if (results.length >= maxResponses) break

          const mapped = this._mapSearchResponse(resp)
          results.push(mapped)
          if (onResult) onResult(mapped)
        }

        try {
          const meta = await slskdGet(`/api/v0/searches/${searchId}`)
          if (meta.isComplete) break
        } catch {
          /* keep polling */
        }

        if (results.length >= maxResponses) break
      }
    } finally {
      slskdDelete(`/api/v0/searches/${searchId}`).catch(() => {})
    }
    return results
  }

  private _mapSearchResponse(resp: SlskdSearchResponse): FileSearchResponse {
    return {
      kind: 'fileSearchResponse' as const,
      username: resp.username,
      slotsFree: resp.hasFreeUploadSlot,
      avgSpeed: resp.uploadSpeed || 0,
      queueLength: resp.queueLength || 0,
      token: String(resp.token || ''),
      files: (resp.files || [])
        .filter((f) => !f.isLocked)
        .map((f) => {
          const attrs = new Map<FileAttribute, number>()
          const dur = f.length || 0
          const sz = f.size || 0
          if (dur > 0 && sz > 0) {
            attrs.set(0, Math.round((sz * 8) / (dur * 1000)))
          }
          if (dur) attrs.set(1, dur)
          if (f.sampleRate) attrs.set(4, f.sampleRate)
          if (f.bitDepth) attrs.set(5, f.bitDepth)
          const fname = f.filename || ''
          if (sz > 0) this._cacheFileSize(`${resp.username}\0${fname}`, sz)
          return {
            filename: fname,
            size: BigInt(sz),
            attrs,
          }
        }),
    }
  }

  async download(username: string, filename: string, _receivedBytes?: bigint | number): Promise<Download> {
    const stream = new PassThrough()
    const events = new EventEmitter() as SlskDownloadEventEmitter
    events.on('error', () => {})

    const dl: Download & { startedAt: number } = {
      status: 'requested' as const,
      username,
      filename,
      receivedBytes: BigInt(0),
      stream,
      events,
      // No peer to ask: queuePosition is set while polling
      requestQueuePosition: () => {},
      startedAt: Date.now(),
    }
    this.downloads.push(dl)

    this._runDownload(dl, username, filename).catch((err) => {
      events.emit('error', err)
    })

    return dl
  }

  private async _runDownload(dl: Download & { startedAt: number }, username: string, filename: string): Promise<void> {
    const userEnc = encodeURIComponent(username)

    const cachedSize = this._fileSizeCache.get(`${username}\0${filename}`)
    const dlRequest = cachedSize ? { filename, size: cachedSize } : { filename }
    try {
      await slskdPost(`/api/v0/transfers/downloads/${userEnc}`, [dlRequest])
    } catch (err: any) {
      ;(dl as any).status = 'denied'
      dl.events.emit('error', new Error('slskd enqueue failed: ' + err.message))
      return
    }

    ;(dl as any).status = 'queued'

    const POLL_INTERVAL = 2000
    const MAX_POLLS = 300

    for (let i = 0; i < MAX_POLLS; i++) {
      await sleep(POLL_INTERVAL)
      if (dl.stream.destroyed) {
        slskdDelete(`/api/v0/transfers/downloads/${userEnc}`).catch(() => {})
        return
      }

      let transfers: SlskdTransferUserBlock[]
      try {
        transfers = await slskdGet('/api/v0/transfers/downloads')
      } catch {
        continue
      }

      const file = this._findTransfer(transfers, username, filename)
      if (!file) continue

      ;(dl as any).totalBytes = BigInt(file.size || 0)
      dl.receivedBytes = BigInt(file.bytesTransferred || 0)
      // Exposed on the download object, as the P2P backend does
      if (typeof file.placeInQueue === 'number') {
        ;(dl as any).queuePosition = file.placeInQueue
      }

      const state = (file.state || '').toLowerCase()

      if (state.includes('completed') && state.includes('succeeded')) {
        ;(dl as any).status = 'downloading'
        await this._pipeCompletedFile(dl, filename)
        return
      }

      if (
        state.includes('completed') ||
        state.includes('failed') ||
        state.includes('cancelled') ||
        state.includes('timedout') ||
        state.includes('errored')
      ) {
        dl.events.emit('error', new Error('slskd download ' + file.state))
        return
      }

      if (state.includes('queued')) {
        ;(dl as any).status = 'queued'
        continue
      }

      if (state.includes('inprogress')) {
        ;(dl as any).status = 'downloading'
        dl.events.emit('progress', {
          receivedBytes: dl.receivedBytes,
          totalBytes: (dl as any).totalBytes ?? BigInt(0),
          progress:
            (dl as any).totalBytes > 0n
              ? Number((dl.receivedBytes * 100n) / (dl as any).totalBytes) / 100
              : 0,
        })
      }
    }

    dl.events.emit('error', new Error('slskd download polling timed out'))
  }

  private _findTransfer(
    transfers: SlskdTransferUserBlock[],
    username: string,
    filename: string
  ): SlskdTransferFile | null {
    if (!Array.isArray(transfers)) return null
    for (const ub of transfers) {
      if (ub.username !== username) continue
      for (const dir of ub.directories || []) {
        for (const f of dir.files || []) {
          if (f.filename === filename) return f
        }
      }
    }
    return null
  }

  private async _pipeCompletedFile(dl: Download, filename: string): Promise<void> {
    const found = await findFinishedFile(SLSKD_DOWNLOADS, filename)

    if (!found.found) {
      dl.events.emit(
        'error',
        new Error(
          found.reason === 'outside'
            ? 'Soulseek peer ' + dl.username + ' sent a file name outside the downloads folder: ' + filename
            : 'Completed file not found under ' + SLSKD_DOWNLOADS + ' for ' + filename
        )
      )
      return
    }
    const filePath = found.path

    const stats = await fs.promises.stat(filePath)
    ;(dl as any).totalBytes = BigInt(stats.size)
    dl.receivedBytes = BigInt(0)

    const readStream = fs.createReadStream(filePath)

    readStream.on('data', (chunk: any) => {
      dl.receivedBytes += BigInt(chunk.length)
    })

    readStream.on('error', (err: Error) => {
      dl.events.emit('error', err)
    })

    readStream.pipe(dl.stream)

    dl.stream.on('end', () => {
      ;(dl as any).status = 'complete'
      dl.receivedBytes = (dl as any).totalBytes
      dl.events.emit('complete', dl.receivedBytes)
    })
  }

  removeDownload(dl: Download): void {
    this.downloads = this.downloads.filter((d) => d !== dl)
  }

  destroy(): void {
    this.loggedIn = false
    this.server.conn.destroy()
    for (const dl of this.downloads) dl.stream.destroy()
    this.downloads = []
    this.removeAllListeners()
  }
}
