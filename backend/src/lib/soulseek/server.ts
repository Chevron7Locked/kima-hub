import { EventEmitter } from 'events'
import type { Socket } from 'net'
import net from 'net'
import type TypedEventEmitter from 'typed-emitter'

import type { Address } from './common'
import type { FromServerMessage } from './messages/from/server'
import { fromServerMessageParser } from './messages/from/server'
import type { MessageParser } from './messages/message-parser'
import { MessageStream } from './messages/message-stream'
import { toServerMessage } from './messages/to/server'

export type SlskServerEvents = {
  message: (msg: FromServerMessage) => void
  error: (error: Error) => void
}

export class SlskServer extends (EventEmitter as new () => TypedEventEmitter<SlskServerEvents>) {
  conn: Socket
  msgs: MessageStream

  constructor(address: Address) {
    super()
    this.conn = net.createConnection(address)

    // Enable TCP keepalive to detect dead connections (matches slskd/Nicotine+)
    this.conn.once('connect', () => {
      this.conn.setKeepAlive(true, 15000)
    })

    this.msgs = new MessageStream()

    this.conn.on('error', (error) => {
      this.emit('error', error)
    })

    this.conn.on('data', (data) => {
      this.msgs.write(data)
    })

    this.msgs.on('message', (msg: MessageParser) => {
      try {
        const data = fromServerMessageParser(msg)
        if (data) {
          this.emit('message', data)
        }
      } catch (error) {
        console.error('Failed to parse server message', error)
      }
    })
  }

  send<K extends keyof typeof toServerMessage>(
    message: K,
    ...args: Parameters<(typeof toServerMessage)[K]>
  ) {
    if (this.conn.destroyed || !this.conn.writable) return
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const result = toServerMessage[message](...args)
    this.conn.write(result.getBuffer())
  }

  destroy() {
    this.conn.destroy()
  }
}
