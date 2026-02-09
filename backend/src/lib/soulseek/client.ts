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

    this.listen.on('message', (msg) => {
      const handler = async () => {
        switch (msg.kind) {
          case 'peerInit': {
            const existingPeer = this.peers.get(msg.username)
            if (existingPeer) {
              return
            }

            const peerAddress = await this.getPeerAddress(msg.username)

            const peer = new SlskPeer(
              {
                host: peerAddress.host,
                port: peerAddress.port,
              },
              msg.username
            )

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
  }

  private wireServerHandlers() {
    this.server.on('error', (error) => this.emit('server-error', error))

    this.server.on('message', (msg) => {
      const handler = () => {
        switch (msg.kind) {
          case 'login': {
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

                conn.write(toPeerMessage.pierceFirewall({ token: msg.token }).getBuffer())

                let download: DownloadWithToken | undefined
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

                conn.on('error', (error) => download?.stream.emit('error', error))
                conn.on('close', () => {
                  download?.stream.end()
                  this.fileTransferConnections = this.fileTransferConnections.filter(
                    (c) => c !== conn
                  )
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

              this.downloads[existingDownloadIndex] = {
                ...this.downloads[existingDownloadIndex],
                status: 'connected',
                queuePosition: 0,
                token: msg.token,
                totalBytes: msg.size,
              }
              this.downloads[existingDownloadIndex].events.emit(
                'status',
                'connected',
                makeDownloadStatusData(this.downloads[existingDownloadIndex])
              )

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

            const download = this.downloads[existingDownloadIndex]
            if (download.status === 'requested') {
              this.downloads[existingDownloadIndex] = {
                ...download,
                status: 'queued',
                queuePosition: msg.place,
              }
              this.downloads[existingDownloadIndex].events.emit(
                'status',
                'queued',
                makeDownloadStatusData(this.downloads[existingDownloadIndex])
              )
            } else if (download.status === 'queued') {
              this.downloads[existingDownloadIndex] = {
                ...download,
                queuePosition: msg.place,
              }
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
    this.server.send('getPeerAddress', { username })

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
    })

    return result
  }

  async login(username: string, password: string, timeout = DEFAULT_LOGIN_TIMEOUT) {
    this.server.send('login', { username, password })

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
    }: {
      timeout?: number
      onResult?: (result: FileSearchResponse) => void
    } = {}
  ) {
    const token = getRandomToken()

    this.server.send('fileSearch', { token, query })

    const results: FileSearchResponse[] = []
    const listener = (msg: FromPeerMessage) => {
      if (msg.kind === 'fileSearchResponse' && msg.token === token) {
        onResult?.(msg)
        results.push(msg)
      }
    }
    this.peerMessages.on('message', listener)

    return new Promise<FileSearchResponse[]>((resolve) => {
      setTimeout(() => {
        this.peerMessages.off('message', listener)
        resolve(results)
      }, timeout)
    })
  }

  async download(username: string, filename: string, receivedBytes?: bigint | number) {
    const peer = await this.getPeerByUsername(username)

    peer.send('queueUpload', { filename })

    const download: RequestedDownload = {
      status: 'requested',
      username,
      filename,
      receivedBytes: BigInt(receivedBytes ?? 0),
      stream: new stream.PassThrough(),
      events: new EventEmitter() as SlskDownloadEventEmitter,
      requestQueuePosition: () => peer.send('placeInQueueRequest', { filename }),
    }

    this.downloads.push(download)
    download.events.emit('status', 'requested', makeDownloadStatusData(download))

    peer.send('placeInQueueRequest', { filename })

    return download
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

      const { address } = await new Promise<{
        msg: PierceFirewall
        address: Address
      }>((resolve, reject) => {
        const timeout_ = setTimeout(() => {
          this.listen.off('message', listener)
          reject(new Error('getPeerByUsername timed out'))
        }, timeout)

        const listener: SlskListenEvents['message'] = (msg, address) => {
          if (msg.kind === 'pierceFirewall' && msg.token === token) {
            clearTimeout(timeout_)
            this.listen.off('message', listener)
            resolve({ msg, address })
          }
        }

        this.listen.on('message', listener)
      })

      const peer = new SlskPeer(
        {
          host: address.host,
          port: address.port,
        },
        username
      )

      await new Promise<void>((resolve, reject) => {
        peer.once('connect', () => resolve())
        peer.once('error', (error) => reject(error))
      })

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
        peer.once('error', (error) => reject(error))
        peer.once('connect', () => {
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
    this.server.destroy()
    this.listen.destroy()
    for (const peer of this.peers.values()) {
      peer.destroy()
    }
    for (const fileTransferConnection of this.fileTransferConnections) {
      fileTransferConnection.destroy()
    }
  }
}

const getRandomToken = () => crypto.randomBytes(4).toString('hex')
