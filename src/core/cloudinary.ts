import { createHash } from 'node:crypto'
import path from 'node:path'
import type { AssetStore } from './assets'

/**
 * Cloudinary as an asset store.
 *
 * The reason it exists is not disk space: fal fetches its inputs over the
 * network, and a local file has to be base64'd into the request body to get
 * there. That is fine for a still and absurd for a 200 MB video reference. A
 * hosted asset is a URL fal simply fetches.
 *
 * No SDK. Cloudinary's upload endpoint is a signed multipart POST, and the
 * dependency would be larger than the code it replaces.
 */

export type CloudinaryConfig = { cloudName: string; apiKey: string; apiSecret: string }

/** `cloudinary://<api_key>:<api_secret>@<cloud_name>`, the variable their dashboard hands you. */
export function parseCloudinaryUrl(url: string): CloudinaryConfig {
  const match = /^cloudinary:\/\/([^:]+):([^@]+)@(.+)$/.exec(url.trim())
  if (!match) {
    throw new Error(
      'CLOUDINARY_URL must look like cloudinary://<api_key>:<api_secret>@<cloud_name>.',
    )
  }
  return { apiKey: match[1], apiSecret: match[2], cloudName: match[3] }
}

/**
 * Cloudinary signs the alphabetically-sorted parameters, minus the file itself,
 * with the API secret appended. Getting the order wrong is a 401 that reads like
 * a bad key, so the sort is not incidental.
 */
export function signature(params: Record<string, string>, apiSecret: string): string {
  const payload = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&')
  return createHash('sha1').update(payload + apiSecret).digest('hex')
}

/** Cloudinary files anything non-media under `raw`, and refuses it under `image`. */
export const resourceKind = (key: string): 'image' | 'video' | 'raw' => {
  const ext = path.extname(key).toLowerCase()
  if (['.mp4', '.webm', '.mov'].includes(ext)) return 'video'
  if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) return 'image'
  return 'raw'
}

/**
 * The store's key, minus its extension, becomes the Cloudinary public id.
 *
 * Keeping our own key means the same render always lands on the same public id,
 * so a retry overwrites rather than accumulating a second copy of a file we are
 * already paying to store.
 */
export const publicIdFor = (key: string) =>
  path.join(path.dirname(key), path.basename(key, path.extname(key))).replaceAll('\\', '/')

export function cloudinaryStore(config: CloudinaryConfig, fallback: AssetStore): AssetStore {
  return {
    async put(key, bytes) {
      const timestamp = String(Math.floor(Date.now() / 1000))
      const publicId = publicIdFor(key)
      const signed = { public_id: publicId, timestamp, overwrite: 'true' }

      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(bytes)]), path.basename(key))
      form.append('api_key', config.apiKey)
      for (const [name, value] of Object.entries(signed)) form.append(name, value)
      form.append('signature', signature(signed, config.apiSecret))

      const response = await fetch(
        `https://api.cloudinary.com/v1_1/${config.cloudName}/${resourceKind(key)}/upload`,
        { method: 'POST', body: form },
      )
      const body = (await response.json()) as { secure_url?: string; error?: { message: string } }
      if (!response.ok || !body.secure_url) {
        throw new Error(`Cloudinary upload failed for ${key}: ${body.error?.message ?? response.status}`)
      }

      // The local copy is kept deliberately. ffmpeg and sharp read files, not
      // URLs, so the export path would otherwise have to download every asset it
      // was about to resize. The hosted URL is what gets recorded and shared;
      // the file on disk is the working copy that makes the rest of the tool
      // work unchanged.
      //
      // ponytail: writes twice and stores twice. Drop the local write and
      // download on demand in `exporter` if the disk cost ever outweighs the
      // simplicity.
      await fallback.put(key, bytes)
      return body.secure_url
    },

    // Reads stay local: everything written through this store was written to
    // disk as well, and a read that went over the network would make the
    // export path depend on connectivity.
    get: (key) => fallback.get(key),
    url: (key) => `https://res.cloudinary.com/${config.cloudName}/image/upload/${publicIdFor(key)}`,
    hosted: true,
  }
}
