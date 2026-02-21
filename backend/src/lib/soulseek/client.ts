import crypto from 'crypto'
import EventEmitter from 'events'
import net from 'net'
import stream from 'stream'
import type TypedEventEmitter from 'typed-emitter'

import type { Address } from './common'
import type {
  CompleteDownload,
  ConnectedDownload,
  Download,
  DownloadingDownload,
  DownloadWithToken,
  RequestedDownload,
  SlskDownloadEventEmitter,
} from './downloads'
import { downloadHasToken, makeDownloadStatusData } from './downloads'
import type { SlskListenEvents } from './listen'
import { SlskListen } from './listen'
import { ConnectionType, TransferDirection, UserStatus } from './messages/common'
import type { FileSearchResponse, FromPeerMessage } from './messages/from/peer'
import type { PierceFirewall } from './messages/from/peer-init'
import type { FromServerMessage, GetPeerAddress, Login } from './messages/from/server'
import { toPeerMessage } from './messages/to/peer'
import { SlskPeer } from './peer'
import { SlskServer } from './server'

const DEFAULT_LOGIN_TIMEOUT = 10 * 1000
const DEFAULT_SEARCH_TIMEOUT = 10 * 1000
const DEFAULT_GET_PEER_ADDRESS_TIMEOUT = 10 * 1000
const DEFAULT_GET_PEER_BY_USERNAME_TIMEOUT = 10 * 1000

export type SlskClientEvents = {
  'server-error': (error: Error) => void
  'listen-error': (error: Error) => void
  'peer-error': (error: Error, peer: SlskPeer) => void
  'client-error': (error: unknown) => void
}

export type SlskPeersEvents = {
  message: (msg: FromPeerMessage, peer: SlskPeer) => void
}

export class SlskClient extends (EventEmitter as new () => TypedEventEmitter<SlskClientEvents>) {
  server: SlskServer
  listen: SlskListen
  peers: Map<string, SlskPeer>
  peerMessages: TypedEventEmitter<SlskPeersEvents>
  fileTransferConnections: net.Socket[]
  username: string | undefined
  loggedIn = false
  downloads: Download[]

  private serverAddress: Address
  private listenPort: number
  private reconnectAttempts = 0
  private reconnectTimeout: NodeJS.Timeout | null = null
  private autoReconnect = true
  private credentials: { username: string; password: string } | null = null
  private readonly DOWNLOAD_TTL = 5 * 60 * 1000 // 5 minutes
  private downloadCleanupInterval: NodeJS.Timeout | null = null

  constructor({
    serverAddress = {
      host: 'server.slsknet.org',
      port: 2242,
    },
    listenPort = 2234,
  }: { serverAddress?: Address; listenPort?: number } = {}) {
    super()
    this.serverAddress = serverAddress
    this.listenPort = listenPort
    this.server = new SlskServer(serverAddress)
    this.listen = new SlskListen(listenPort)
    this.peers = new Map()
    this.peerMessages = new EventEmitter() as TypedEventEmitter<SlskPeersEvents>
    this.downloads = []
    this.fileTransferConnections = []

    this.wireServerHandlers()

    this.listen.on('error', (error) => this.emit('listen-error', error))

    this.listen.on('message', (msg, _address, socket) => {
      const handler = async () => {
        switch (msg.kind) {
          case 'peerInit': {
            const existingPeer = this.peers.get(msg.username)
            if (existingPeer) {
              socket.destroy()
              return
            }

            // Reuse the inbound socket -- the peer already connected to us,
            // no need to open a new outbound connection
            const peer = new SlskPeer(socket, msg.username)

            peer.once('close', () => {
              peer.destroy()
              this.peers.delete(msg.username)
            })

            peer.on('message', (msg) => this.peerMessages.emit('message', msg, peer))
            peer.on('error', (error) => this.emit('peer-error', error, peer))

            this.peers.set(msg.username, peer)

            break
          }
        }
      }

      handler().catch((error) => {
        this.emit('client-error', error)
      })
    })

    this.wirePeerMessageHandlers()

    // Start download cleanup interval
    this.downloadCleanupInterval = setInterval(() => {
      this.cleanupStuckDownloads()
    }, 60000) // Check every minute
  }

  private wireServerHandlers() {
    this.server.on('error', (error) => this.emit('server-error', error))

    this.server.on('message', (msg) => {
      const handler = () => {
        switch (msg.kind) {
          case 'login': {
            this.server.send('setWaitPort', { port: this.listenPort })
            this.server.send('sharedFoldersFiles', { dirs: 1, files: 1 })
            this.server.send('haveNoParents', { haveNoParents: true })
            this.server.send('setStatus', { status: UserStatus.Online })
            break
          }
          case 'possibleParents': {
            for (const parent of msg.parents) {
              this.server.send('searchParent', { host: parent.host })
            }
            break
          }
          case 'connectToPeer': {
            switch (msg.type) {
              case ConnectionType.PeerToPeer: {
                const existingPeer = this.peers.get(msg.username)
                if (existingPeer) {
                  return
                }

                const peer = new SlskPeer(
                  {
                    host: msg.host,
                    port: msg.port,
                  },
                  msg.username
                )

                peer.once('connect', () => {
                  peer.send('pierceFirewall', { token: msg.token })
                })

                peer.once('error', () => {
                  this.server.send('cantConnectToPeer', {
                    token: msg.token,
                    username: msg.username,
                  })
                })

                peer.once('close', () => {
                  peer.destroy()
                  this.peers.delete(msg.username)
                })

                peer.on('message', (msg) => this.peerMessages.emit('message', msg, peer))
                peer.on('error', (error) => this.emit('peer-error', error, peer))

                this.peers.set(msg.username, peer)

                break
              }
              case ConnectionType.FileTransfer: {
                const conn = net.createConnection({
                  host: msg.host,
                  port: msg.port,
                })

                this.fileTransferConnections.push(conn)

                let download: DownloadWithToken | undefined

                conn.on('error', (error) => {
                  if (download) {
                    download.stream.destroy(error)
                  }
                })
                conn.on('close', () => {
                  if (download && download.status !== 'complete') {
                    download.events.emit(
                      'error',
                      new Error('Connection closed before transfer completed')
                    )
                    this.downloads = this.downloads.filter((d) => d !== download)
                  }
                  if (download && !download.stream.destroyed) {
                    download.stream.end()
                  }
                  this.fileTransferConnections = this.fileTransferConnections.filter(
                    (c) => c !== conn
                  )
                })

                conn.once('connect', () => {
                  conn.write(toPeerMessage.pierceFirewall({ token: msg.token }).getBuffer())
                })

                conn.on('data', (data) => {
                  if (download === undefined) {
                    const token = data.toString('hex', 0, 4)
                    const download_ = this.downloads.find(
                      (d): d is ConnectedDownload | DownloadingDownload | CompleteDownload =>
                        d.username === msg.username && downloadHasToken(d) && d.token === token
                    )
                    if (!download_) {
                      console.error('No download found for', msg)
                      conn.end()
                      return
                    }
                    download = download_
                    download.status = 'downloading'
                    download.events.emit('status', 'downloading', makeDownloadStatusData(download))

                    // send file offset message
                    const fileOffsetBuffer = Buffer.alloc(8)
                    fileOffsetBuffer.writeBigUInt64LE(download.receivedBytes, 0)
                    conn.write(fileOffsetBuffer)

                    // Process any remaining file data in this chunk beyond the 4-byte token
                    if (data.length > 4) {
                      const fileData = data.slice(4)
                      download.receivedBytes += BigInt(fileData.length)
                      download.stream.write(fileData)
                      download.events.emit('data', fileData)
                      download.events.emit('progress', {
                        receivedBytes: download.receivedBytes,
                        totalBytes: download.totalBytes,
                        progress:
                          download.totalBytes > 0n
                            ? Number((download.receivedBytes * 100n) / download.totalBytes) / 100
                            : 0,
                      })

                      const isComplete = download.receivedBytes >= download.totalBytes
                      if (isComplete) {
                        conn.end()
                        download.stream.end()
                        download.status = 'complete'
                        download.events.emit('complete', download.receivedBytes)
                        download.events.emit(
                          'status',
                          'complete',
                          makeDownloadStatusData(download)
                        )
                        this.downloads = this.downloads.filter((d) => d !== download)
                      }
                    }
                  } else {
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

                    const isComplete = download.receivedBytes >= download.totalBytes
                    if (isComplete) {
                      conn.end()
                      download.stream.end()
                      download.status = 'complete'
                      download.events.emit('complete', download.receivedBytes)
                      download.events.emit('status', 'complete', makeDownloadStatusData(download))

                      // remove from this.downloads
                      this.downloads = this.downloads.filter((d) => d !== download)
                    }
                  }
                })

                break
              }
              case ConnectionType.Distributed: {
                break
              }
            }
          }
        }
      }

      try {
        handler()
      } catch (error) {
        this.emit('client-error', error)
      }
    })
  }

  private wirePeerMessageHandlers() {
    this.peerMessages.on('message', (msg, peer) => {
      const handler = () => {
        switch (msg.kind) {
          case 'transferRequest': {
            if (msg.direction === TransferDirection.Upload) {
              const existingDownloadIndex = this.downloads.findIndex(
                (d) => d.username === peer.username && d.filename === msg.filename
              )

              if (existingDownloadIndex === -1) {
                console.error('No download found for', msg)
                return
              }

              const dl = this.downloads[existingDownloadIndex] as any
              dl.status = 'connected'
              dl.queuePosition = 0
              dl.token = msg.token
              dl.totalBytes = msg.size
              dl.events.emit('status', 'connected', makeDownloadStatusData(dl))

              peer.send('transferResponse', {
                token: msg.token,
                allowed: true,
              })
            }

            break
          }
          case 'placeInQueueResponse': {
            const existingDownloadIndex = this.downloads.findIndex(
              (d) => d.username === peer.username && d.filename === msg.filename
            )

            if (existingDownloadIndex === -1) {
              console.error('No download found for', msg)
              return
            }

            const download = this.downloads[existingDownloadIndex] as any
            if (download.status === 'requested') {
              download.status = 'queued'
              download.queuePosition = msg.place
              download.events.emit(
                'status',
                'queued',
                makeDownloadStatusData(download)
              )
            } else if (download.status === 'queued') {
              download.queuePosition = msg.place
            }

            break
          }
          case 'uploadDenied': {
            const existingDownloadIndex = this.downloads.findIndex(
              (d) => d.username === peer.username && d.filename === msg.filename
            )

            if (existingDownloadIndex !== -1) {
              const download = this.downloads[existingDownloadIndex]
              download.stream.destroy(new Error(`Upload denied: ${msg.reason}`))
              const denied = {
                ...download,
                status: 'denied' as const,
                reason: msg.reason,
              }
              download.events.emit('status', 'denied', makeDownloadStatusData(denied))
              this.downloads = this.downloads.filter((_, i) => i !== existingDownloadIndex)
            }
            break
          }
        }
      }

      try {
        handler()
      } catch (error) {
        this.emit('client-error', error)
      }
    })
  }

  async getPeerAddress(username: string, timeout = DEFAULT_GET_PEER_ADDRESS_TIMEOUT) {
    const result = await new Promise<GetPeerAddress>((resolve, reject) => {
      const timeout_ = setTimeout(() => {
        this.server.off('message', listener)
        reject(new Error('getPeerAddress timed out'))
      }, timeout)

      const listener = (msg: FromServerMessage) => {
        if (msg.kind === 'getPeerAddress' && msg.username === username) {
          clearTimeout(timeout_)
          this.server.off('message', listener)
          resolve(msg)
        }
      }

      this.server.on('message', listener)
      this.server.send('getPeerAddress', { username })
    })

    return result
  }

  async login(username: string, password: string, timeout = DEFAULT_LOGIN_TIMEOUT) {
    const loginResult = await new Promise<Login>((resolve, reject) => {
      const timeout_ = setTimeout(() => {
        this.server.off('message', listener)
        reject(new Error('Login timed out'))
      }, timeout)

      const listener = (msg: FromServerMessage) => {
        if (msg.kind === 'login') {
          clearTimeout(timeout_)
          this.server.off('message', listener)
          resolve(msg)
        }
      }

      this.server.on('message', listener)
      this.server.send('login', { username, password })
    })

    if (!loginResult.success) {
      throw new Error(`Login failed: ${loginResult.reason}`)
    }

    this.username = username
    this.loggedIn = true
  }

  async loginAndRemember(username: string, password: string, timeout?: number) {
    this.credentials = { username, password }
    await this.login(username, password, timeout)
    this.reconnectAttempts = 0
    this.wireCloseHandler()
  }

  private wireCloseHandler() {
    this.server.conn.once('close', () => {
      this.loggedIn = false
      if (this.autoReconnect && this.credentials) {
        this.scheduleReconnect()
      }
    })
  }

  private scheduleReconnect() {
    if (this.reconnectTimeout) return

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 60000)
    this.reconnectAttempts++

    this.reconnectTimeout = setTimeout(async () => {
      this.reconnectTimeout = null
      if (!this.credentials || !this.autoReconnect) return

      try {
        this.server.removeAllListeners()
        this.server.destroy()
        this.server = new SlskServer(this.serverAddress)
        this.wireServerHandlers()
        await this.login(this.credentials.username, this.credentials.password)
        this.reconnectAttempts = 0
        this.wireCloseHandler()
      } catch {
        this.scheduleReconnect()
      }
    }, delay)
  }

  search(
    query: string,
    {
      timeout = DEFAULT_SEARCH_TIMEOUT,
      onResult,
      maxResponses = 50,
    }: {
      timeout?: number
      onResult?: (result: FileSearchResponse) => void
      maxResponses?: number
    } = {}
  ) {
    const token = getRandomToken()

    this.server.send('fileSearch', { token, query })

    const results: FileSearchResponse[] = []
    let settled = false

    const cleanup = () => {
      if (!settled) {
        settled = true
        this.peerMessages.off('message', listener)
      }
    }

    const listener = (msg: FromPeerMessage) => {
      if (settled) return
      if (msg.kind === 'fileSearchResponse' && msg.token === token) {
        onResult?.(msg)
        results.push(msg)
        // Stop accumulating after enough responses to prevent memory exhaustion
        if (results.length >= maxResponses) {
          cleanup()
          resolvePromise?.(results)
        }
      }
    }
    this.peerMessages.on('message', listener)

    let resolvePromise: ((value: FileSearchResponse[]) => void) | null = null
    return new Promise<FileSearchResponse[]>((resolve) => {
      resolvePromise = resolve
      setTimeout(() => {
        cleanup()
        resolve(results)
      }, timeout)
    })
  }

  async download(username: string, filename: string, receivedBytes?: bigint | number) {
    const peer = await this.getPeerByUsername(username)

    peer.send('queueUpload', { filename })

    const download: RequestedDownload & { startedAt: number } = {
      status: 'requested',
      username,
      filename,
      receivedBytes: BigInt(receivedBytes ?? 0),
      stream: new stream.PassThrough(),
      events: new EventEmitter() as SlskDownloadEventEmitter,
      requestQueuePosition: () => peer.send('placeInQueueRequest', { filename }),
      startedAt: Date.now(),
    }

    this.downloads.push(download)
    download.events.emit('status', 'requested', makeDownloadStatusData(download))

    peer.send('placeInQueueRequest', { filename })

    return download
  }

  /**
   * Remove a specific download from the tracked downloads array.
   * Called by the service layer on timeout/error so that cleanupStuckDownloads()
   * does not redundantly find and re-log the same orphaned entry.
   */
  removeDownload(download: Download): void {
    this.downloads = this.downloads.filter((d) => d !== download)
  }

  private cleanupStuckDownloads(): void {
    const now = Date.now()
    const before = this.downloads.length

    this.downloads = this.downloads.filter((download) => {
      const downloadWithTime = download as RequestedDownload & { startedAt?: number }
      if (!downloadWithTime.startedAt) {
        return true // Keep downloads without timestamp (shouldn't happen)
      }

      const age = now - downloadWithTime.startedAt
      if (age > this.DOWNLOAD_TTL) {
        try {
          download.stream?.destroy()
        } catch {
          // Ignore cleanup errors
        }
        return false // Remove from array
      }
      return true // Keep in array
    })

    const cleaned = before - this.downloads.length
    if (cleaned > 0) {
      this.emit('client-error', new Error(`Cleaned up ${cleaned} stuck downloads`))
    }
  }

  async getPeerByUsername(username: string, timeout = DEFAULT_GET_PEER_BY_USERNAME_TIMEOUT) {
    const existingPeer = this.peers.get(username)
    if (existingPeer) {
      return existingPeer
    }

    const token = getRandomToken()

    const getByConnectToPeer = async () => {
      this.server.send('connectToPeer', {
        token,
        username,
        type: ConnectionType.PeerToPeer,
      })

      const { socket } = await new Promise<{
        msg: PierceFirewall
        socket: net.Socket
      }>((resolve, reject) => {
        const timeout_ = setTimeout(() => {
          this.listen.off('message', listener)
          reject(new Error('getPeerByUsername timed out'))
        }, timeout)

        const listener: SlskListenEvents['message'] = (msg, _address, socket) => {
          if (msg.kind === 'pierceFirewall' && msg.token === token) {
            clearTimeout(timeout_)
            this.listen.off('message', listener)
            resolve({ msg, socket })
          }
        }

        this.listen.on('message', listener)
      })

      // Reuse the inbound socket
      const peer = new SlskPeer(socket, username)

      peer.once('close', () => peer.destroy())

      return peer
    }

    const getByPeerInit = async () => {
      const peerAddress = await this.getPeerAddress(username)

      const peer = new SlskPeer(
        {
          host: peerAddress.host,
          port: peerAddress.port,
        },
        username
      )

      peer.once('close', () => peer.destroy())

      await new Promise<void>((resolve, reject) => {
        const connectTimeout = setTimeout(() => {
          peer.destroy()
          reject(new Error('getByPeerInit connect timed out'))
        }, timeout)

        peer.once('error', (error) => {
          clearTimeout(connectTimeout)
          reject(error)
        })
        peer.once('connect', () => {
          clearTimeout(connectTimeout)
          if (this.username === undefined) {
            reject(new Error('You are not logged in'))
            return
          }

          peer.send('peerInit', {
            username: this.username,
            type: ConnectionType.PeerToPeer,
            token,
          })

          resolve()
        })
      })

      return peer
    }

    const peerA = getByConnectToPeer()
    const peerB = getByPeerInit()

    let peer: SlskPeer
    try {
      peer = await Promise.any([peerA, peerB])
    } catch (error) {
      throw new Error(`Could not connect to ${username}`)
    }

    // Destroy the losing peer to prevent socket leak
    const cleanupLoser = async (loserPromise: Promise<SlskPeer>) => {
      try {
        const loser = await loserPromise
        if (loser !== peer) {
          loser.destroy()
        }
      } catch {
        // Already failed, nothing to clean up
      }
    }
    void cleanupLoser(peerA)
    void cleanupLoser(peerB)

    peer.once('close', () => this.peers.delete(username))
    peer.on('message', (msg) => this.peerMessages.emit('message', msg, peer))
    peer.on('error', (error) => this.emit('peer-error', error, peer))

    this.peers.set(username, peer)

    return peer
  }

  destroy() {
    this.autoReconnect = false
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }
    if (this.downloadCleanupInterval) {
      clearInterval(this.downloadCleanupInterval)
      this.downloadCleanupInterval = null
    }
    this.server.destroy()
    this.listen.destroy()
    for (const peer of this.peers.values()) {
      peer.destroy()
    }
    this.peers.clear()
    for (const fileTransferConnection of this.fileTransferConnections) {
      fileTransferConnection.destroy()
    }
    this.fileTransferConnections = []
    for (const download of this.downloads) {
      download.stream.destroy()
    }
    this.downloads = []
    this.peerMessages.removeAllListeners()
    this.removeAllListeners()
  }
}

const getRandomToken = () => crypto.randomBytes(4).toString('hex')
