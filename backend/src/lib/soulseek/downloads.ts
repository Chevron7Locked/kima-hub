import type stream from 'stream'
import type TypedEventEmitter from 'typed-emitter'

import type { DistributiveOmit } from './utils/types'
import { distributiveOmit } from './utils/types'

export type Download =
  | RequestedDownload
  | QueuedDownload
  | ConnectedDownload
  | DownloadingDownload
  | CompleteDownload
  | DeniedDownload

export type SlskDownloadEvents = {
  status: (status: Download['status'], data: DownloadStatusData) => void
  data?: (data: Buffer) => void
  progress?: (metadata: { totalBytes: bigint; receivedBytes: bigint; progress: number }) => void
  complete?: (receivedBytes: bigint) => void
}
export type SlskDownloadEventEmitter = TypedEventEmitter<SlskDownloadEvents>

export type RequestedDownload = {
  status: 'requested'
  username: string
  filename: string
  receivedBytes: bigint
  stream: stream.PassThrough
  events: SlskDownloadEventEmitter
  requestQueuePosition: () => void
}
export const isRequestedDownload = (download: Download): download is RequestedDownload =>
  download.status === 'requested'

export type QueuedDownload = Omit<RequestedDownload, 'status'> & {
  status: 'queued'
  queuePosition: number
}
export const isQueuedDownload = (download: Download): download is QueuedDownload =>
  download.status === 'queued'

export type ConnectedDownload = Omit<QueuedDownload, 'status'> & {
  status: 'connected'
  token: string
  totalBytes: bigint
}
export const isConnectedDownload = (download: Download): download is ConnectedDownload =>
  download.status === 'connected'

export type DownloadingDownload = Omit<ConnectedDownload, 'status'> & {
  status: 'downloading'
}
export const isDownloadingDownload = (download: Download): download is DownloadingDownload =>
  download.status === 'downloading'

export type CompleteDownload = Omit<DownloadingDownload, 'status'> & {
  status: 'complete'
}
export const isCompleteDownload = (download: Download): download is CompleteDownload =>
  download.status === 'complete'

export type DeniedDownload = Omit<RequestedDownload, 'status'> & {
  status: 'denied'
  reason: string
}
export const isDeniedDownload = (download: Download): download is DeniedDownload =>
  download.status === 'denied'

export type DownloadWithToken = ConnectedDownload | DownloadingDownload | CompleteDownload
export const downloadHasToken = (download: Download): download is DownloadWithToken =>
  isConnectedDownload(download) || isDownloadingDownload(download) || isCompleteDownload(download)

export type DownloadStatusData = DistributiveOmit<
  Download,
  'stream' | 'events' | 'requestQueuePosition'
>

export const makeDownloadStatusData = <T extends Download>(obj: T): DownloadStatusData =>
  distributiveOmit(obj, ['stream', 'events', 'requestQueuePosition'])
