import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { storeFor } from './assets'

/** What the canvas is allowed to accept. Anything else is refused at the door. */
export const ALLOWED_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'text/plain': '.txt',
}

/** 200 MB. A video reference is large; a runaway upload should still be refused. */
export const MAX_BYTES = 200 * 1024 * 1024

export class UploadRejected extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UploadRejected'
  }
}

export const kindFor = (mime: string): 'image' | 'video' | 'text' =>
  mime.startsWith('video/') ? 'video' : mime.startsWith('text/') ? 'text' : 'image'

/**
 * Writes an uploaded file into the store under a generated name.
 *
 * The caller's filename is never used for the path — only for the extension
 * lookup, and even that comes from the mime type. A name is attacker-controlled
 * input; deriving the path from a UUID means it cannot traverse anywhere.
 */
export async function storeUpload(
  storeRoot: string,
  file: { mime: string; bytes: Buffer },
): Promise<{ key: string; reference: string; kind: 'image' | 'video' | 'text' }> {
  const ext = ALLOWED_MIME[file.mime]
  if (!ext) throw new UploadRejected(`Cannot use a ${file.mime || 'file of unknown type'} here.`)
  if (file.bytes.byteLength === 0) throw new UploadRejected('That file is empty.')
  if (file.bytes.byteLength > MAX_BYTES) {
    throw new UploadRejected(`That file is over ${Math.round(MAX_BYTES / 1024 / 1024)} MB.`)
  }

  const store = storeFor(storeRoot)
  const name = `${randomUUID()}${ext}`
  const key = path.join('uploads', name)
  const location = await store.put(key, file.bytes)

  // The row stores the key, not the absolute path: the database should survive
  // the store moving, and a URL is derived from the key rather than from a
  // filesystem location that would then be attacker-adjacent. A *hosted* store
  // is the exception — its URL is the whole point, since it is what fal fetches
  // instead of having the file base64'd into the request.
  return {
    key,
    reference: location.startsWith('http') ? location : key,
    kind: kindFor(file.mime),
  }
}
