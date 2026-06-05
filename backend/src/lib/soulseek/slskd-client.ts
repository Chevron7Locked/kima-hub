/**
 * slskd HTTP adapter — drop-in replacement for the vendored soulseek-ts SlskClient.
 *
 * Routes all Soulseek operations through slskd's REST API instead of opening
 * a direct P2P connection. Keeps slskd as the network-facing Soulseek citizen
 * (file sharing, uploads, port forwarding) while Kima drives search + download
 * via HTTP.
 *
 * Activated when the SLSKD_URL environment variable is set. The main client
 * module (client.ts) conditionally re-exports from this file.
 */

import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import http from 'http'
import fs from 'fs'
import path from 'path'

import type { Download, SlskDownloadEventEmitter } from './downloads'
import type { FileSearchResponse } from './messages/from/peer'
import type { FileAttribute } from './messages/common'

// Defaults come from the environment; configureSlskd() lets the app override
// them at runtime from user settings (so slskd is configurable in the UI, not
// only via env vars). Kept as module-level `let`s so existing references below
// pick up the configured values without threading config through every call.
let SLSKD_URL = process.env.SLSKD_URL || 'http://gluetun-slsk:5030'
let SLSKD_API_KEY = process.env.SLSKD_API_KEY || ''
let SLSKD_DOWNLOADS = process.env.SLSKD_DOWNLOADS || '/soulseek-downloads'

/** Override slskd connection settings (e.g. from SystemSettings). Empty/undefined
 *  values are ignored so an unset field never clobbers a working env default. */
export function configureSlskd(opts: { url?: string | null; apiKey?: string | null; downloads?: string | null }): void {
  if (opts.url) SLSKD_URL = opts.url
  if (opts.apiKey != null) SLSKD_API_KEY = opts.apiKey
  if (opts.downloads) SLSKD_DOWNLOADS = opts.downloads
}

// ── HTTP helpers ──────────────────────────────────────────────────────

function slskdRequest(method: string, urlPath: string, body?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const base = new URL(SLSKD_URL)
    const opts: http.RequestOptions = {
      hostname: base.hostname,
      port: base.port || 80,
      path: urlPath,
      method,
      headers: { 'Content-Type': 'application/json' } as Record<string, string>,
      timeout: 30000,
    }
    if (SLSKD_API_KEY) (opts.headers as Record<string, string>)['X-API-Key'] = SLSKD_API_KEY

    const req = http.request(opts, (res) => {
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

// ── FakeServerConn ────────────────────────────────────────────────────

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

// ── SlskdClient ──────────────────────────────────────────────────────

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
}

interface SlskdTransferDirectory {
  files?: SlskdTransferFile[]
}

interface SlskdTransferUserBlock {
  username: string
  directories?: SlskdTransferDirectory[]
}

/**
 * Drop-in replacement for the vendored SlskClient that routes through
 * slskd's REST API. Implements the same public surface that
 * SoulseekService depends on: login, search, download, removeDownload,
 * destroy, server.conn, loggedIn, downloads.
 */
export class SlskdClient extends EventEmitter {
  loggedIn = false
  downloads: Download[] = []
  server: { conn: FakeServerConn }

  private _fileSizeCache = new Map<string, number>()

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

  // ── Search ────────────────────────────────────────────────────────

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
          if (sz > 0) this._fileSizeCache.set(`${resp.username}\0${fname}`, sz)
          return {
            filename: fname,
            size: BigInt(sz),
            attrs,
          }
        }),
    }
  }

  // ── Download ──────────────────────────────────────────────────────

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

      const state = (file.state || '').toLowerCase()

      if (state.includes('completed') && state.includes('succeeded')) {
        ;(dl as any).status = 'downloading'
        await this._pipeCompletedFile(dl, username, filename)
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

  private async _pipeCompletedFile(dl: Download, _username: string, filename: string): Promise<void> {
    const parts = filename.replace(/\\/g, '/').split('/')

    let filePath: string | null = null
    for (let i = 0; i < parts.length; i++) {
      const candidate = path.join(SLSKD_DOWNLOADS, ...parts.slice(i))
      try {
        await fs.promises.access(candidate, fs.constants.R_OK)
        filePath = candidate
        break
      } catch {
        continue
      }
    }

    if (!filePath) {
      const basename = parts[parts.length - 1]
      filePath = await this._findFileRecursive(SLSKD_DOWNLOADS, basename)
    }

    if (!filePath) {
      dl.events.emit(
        'error',
        new Error('Completed file not found under ' + SLSKD_DOWNLOADS + ' for ' + filename)
      )
      return
    }

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

  private async _findFileRecursive(dir: string, basename: string): Promise<string | null> {
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true })
      for (const e of entries) {
        const full = path.join(dir, e.name)
        if (e.isFile() && e.name === basename) return full
        if (e.isDirectory()) {
          const found = await this._findFileRecursive(full, basename)
          if (found) return found
        }
      }
    } catch {
      /* permission errors, etc */
    }
    return null
  }

  // ── Cleanup ───────────────────────────────────────────────────────

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
