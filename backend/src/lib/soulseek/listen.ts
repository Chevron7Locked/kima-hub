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

export class SlskListen extends (EventEmitter as new () => TypedEventEmitter<SlskListenEvents>) {
  server: Server

  constructor(port: number) {
    super()
    this.server = net.createServer((c) => {
      const host = c.remoteAddress
      const port = c.remotePort
      if (!host || !port) {
        return
      }

      const msgs = new MessageStream()

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

    this.server.listen(port, '0.0.0.0')
  }

  destroy() {
    this.server.close()
  }
}
