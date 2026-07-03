import { EventEmitter } from 'events'
import type { Server, Socket } from 'net'
import net from 'net'
import type TypedEventEmitter from 'typed-emitter'

import { logger } from '../../utils/logger'

import type { Address } from './common'
import type { FromPeerInitMessage } from './messages/from/peer-init'
import { fromPeerInitMessageParser } from './messages/from/peer-init'
import type { MessageParser } from './messages/message-parser'
import { MessageStream } from './messages/message-stream'

export type SlskListenEvents = {
  message: (msg: FromPeerInitMessage, address: Address, socket: Socket) => void
  error: (error: Error) => void
}

// Resource-exhaustion guards for the inbound P2P listen server. Peers are
// deduped by username elsewhere (see p2p-client.ts), so a legitimate session
// only ever holds a modest number of concurrent peer sockets — these are
// generous ceilings, not tuned limits.
const MAX_CONNECTIONS = 256
// Drop an accepted socket that sends/receives nothing for this long (covers
// a stalled handshake as well as a peer connection gone half-open). Any
// activity resets the timer, so active peers are unaffected.
const IDLE_TIMEOUT_MS = 60 * 1000

export class SlskListen extends (EventEmitter as new () => TypedEventEmitter<SlskListenEvents>) {
  server: Server

  constructor(port: number) {
    super()
    this.server = net.createServer((c) => {
      // Slowloris / half-open protection: this fires repeatedly whenever the
      // socket has been idle for the timeout window, whether that's before a
      // handshake completes or on an otherwise-established connection.
      c.setTimeout(IDLE_TIMEOUT_MS, () => c.destroy())

      const host = c.remoteAddress
      const port = c.remotePort
      if (!host || !port) {
        return
      }

      const msgs = new MessageStream()
      msgs.on('error', (error) => {
        logger.error(`[Soulseek] Listen message stream error: ${error}`)
        c.destroy()
      })

      c.on('data', (chunk) => msgs.write(chunk))
      c.on('error', (error) => this.emit('error', error))
      c.on('close', () => msgs.destroy())

      msgs.on('message', (msg: MessageParser) => {
        try {
          const data = fromPeerInitMessageParser(msg)
          if (data) {
            this.emit('message', data, { host, port }, c)
          }
        } catch (error) {
          logger.error(`[Soulseek] Failed to parse peer init message: ${error}`)
        }
      })
    })

    this.server.on('error', (error) => this.emit('error', error))

    // Resource-exhaustion guard: cap concurrent inbound sockets.
    this.server.maxConnections = MAX_CONNECTIONS

    this.server.listen(port, '0.0.0.0')
  }

  destroy() {
    this.server.close()
  }
}
