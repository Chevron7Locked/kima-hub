import type { ConnectionType } from '../common'
import type { MessageParser } from '../message-parser'

export type FromServerMessage = ReturnType<
  (typeof fromServerMessage)[keyof typeof fromServerMessage]
>

export type Login =
  | { kind: 'login'; success: true; greet: string }
  | { kind: 'login'; success: false; reason: string }

export type GetPeerAddress = {
  kind: 'getPeerAddress'
  username: string
  host: string
  port: number
}

type GetUserStatus = {
  kind: 'getUserStatus'
  username: string
  status: number
}

type ConnectToPeer = {
  kind: 'connectToPeer'
  username: string
  type: ConnectionType
  host: string
  port: number
  token: string
}

type GetUserStats = {
  kind: 'getUserStats'
  username: string
  avgSpeed: number
  uploadNum: number
  files: number
  dirs: number
}

type RoomList = {
  kind: 'roomList'
  rooms: { name: string; users: number }[]
}

type PossibleParents = {
  kind: 'possibleParents'
  parents: { username: string; host: string; port: number }[]
}

const fromServerMessage = {
  login: (msg: MessageParser): Login => {
    const success = msg.int8()
    if (success === 1) {
      const greet = msg.str()
      return { kind: 'login', success: true, greet }
    } else {
      const reason = msg.str()
      return { kind: 'login', success: false, reason }
    }
  },
  getPeerAddress: (msg: MessageParser): GetPeerAddress => {
    const username = msg.str()
    const ip = [msg.int8(), msg.int8(), msg.int8(), msg.int8()] as const
    const host = `${ip[3]}.${ip[2]}.${ip[1]}.${ip[0]}`
    const port = msg.int32()
    return { kind: 'getPeerAddress', username: username, host, port }
  },
  getUserStatus: (msg: MessageParser): GetUserStatus => {
    const username = msg.str()
    const status = msg.int32()
    return { kind: 'getUserStatus', username, status }
  },
  connectToPeer: (msg: MessageParser): ConnectToPeer => {
    const username = msg.str()
    const type = msg.str() as ConnectionType
    const ip = [msg.int8(), msg.int8(), msg.int8(), msg.int8()] as const
    const host = `${ip[3]}.${ip[2]}.${ip[1]}.${ip[0]}`
    const port = msg.int32()
    const token = msg.rawHexStr(4)
    return { kind: 'connectToPeer', username, type, host, port, token }
  },
  getUserStats: (msg: MessageParser): GetUserStats => {
    const username = msg.str()
    const avgSpeed = msg.int32()
    const uploadNum = msg.int32()
    msg.int32() // something
    const files = msg.int32()
    const dirs = msg.int32()
    return {
      kind: 'getUserStats',
      username,
      avgSpeed,
      uploadNum,
      files,
      dirs,
    }
  },
  roomList: (msg: MessageParser): RoomList => {
    const numRooms = msg.int32()

    const names: string[] = []
    for (let i = 0; i < numRooms; i++) {
      names.push(msg.str())
    }

    const users: number[] = []
    for (let i = 0; i < numRooms; i++) {
      users.push(msg.int32())
    }

    const rooms = names.map((name, i) => ({ name, users: users[i] }))

    return { kind: 'roomList', rooms }
  },
  possibleParents: (msg: MessageParser): PossibleParents => {
    const numberOfParents = msg.int32()

    const parents: PossibleParents['parents'] = []
    for (let i = 0; i < numberOfParents; i++) {
      const username = msg.str()
      const ip = [msg.int8(), msg.int8(), msg.int8(), msg.int8()] as const
      const host = `${ip[3]}.${ip[2]}.${ip[1]}.${ip[0]}`
      const port = msg.int32()
      parents.push({ username, host, port })
    }

    return { kind: 'possibleParents', parents }
  },
}

export const fromServerMessageParser = (msg: MessageParser): FromServerMessage | undefined => {
  const size = msg.int32()
  if (size < 4) return

  const code = msg.int32()
  switch (code) {
    case 1:
      return fromServerMessage.login(msg)
    case 3:
      return fromServerMessage.getPeerAddress(msg)
    case 7:
      return fromServerMessage.getUserStatus(msg)
    case 18:
      return fromServerMessage.connectToPeer(msg)
    case 36:
      return fromServerMessage.getUserStats(msg)
    case 64:
      return fromServerMessage.roomList(msg)
    case 102:
      return fromServerMessage.possibleParents(msg)
  }
}
