import { EventEmitter } from 'events'
import type { Socket } from 'net'
import net from 'net'
import type TypedEventEmitter from 'typed-emitter'

import { logger } from '../../utils/logger'
import type { Address } from './common'
import type { FromPeerMessage } from './messages/from/peer'
import { fromPeerMessageParser } from './messages/from/peer'
import type { MessageParser } from './messages/message-parser'
import { MessageStream } from './messages/message-stream'
import { toPeerMessage } from './messages/to/peer'

export type SlskPeerEvents = {
  connect: () => void
  error: (error: Error) => void
  close: (hadError: boolean) => void
  end: () => void
  message: (msg: FromPeerMessage) => void
}

export class SlskPeer extends (EventEmitter as new () => TypedEventEmitter<SlskPeerEvents>) {
  conn: Socket
  msgs: MessageStream
  username: string

  constructor(addressOrSocket: Address | Socket, username: string) {
    super()
    this.username = username

    if ('on' in addressOrSocket && typeof (addressOrSocket as Socket).write === 'function') {
      // Existing socket (inbound connection from listen server)
      this.conn = addressOrSocket as Socket
    } else {
      // New outbound connection
      this.conn = net.createConnection(addressOrSocket as Address)
    }

    this.msgs = new MessageStream()

    this.conn.on('connect', () => this.emit('connect'))
    this.conn.on('error', (error) => this.emit('error', error))
    this.conn.on('close', (hadError) => this.emit('close', hadError))
    this.conn.on('end', () => this.emit('end'))

    this.conn.on('data', (data) => {
      this.msgs.write(data)
    })

    this.msgs.on('message', (msg: MessageParser) => {
      try {
        const data = fromPeerMessageParser(msg)
        if (data) {
          this.emit('message', data)
        }
      } catch (error) {
        logger.error(`[Soulseek] Failed to parse peer message: ${error}`)
      }
    })
  }

  send<K extends keyof typeof toPeerMessage>(
    message: K,
    ...args: Parameters<(typeof toPeerMessage)[K]>
  ) {
    if (this.conn.destroyed || !this.conn.writable) return
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const result = toPeerMessage[message](...args)
    this.conn.write(result.getBuffer())
  }

  destroy() {
    this.conn.destroy()
  }
}
