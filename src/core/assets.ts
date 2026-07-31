import { writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { cloudinaryStore, parseCloudinaryUrl } from './cloudinary'

/**
 * Three methods, on purpose. A hosted demo swaps local disk for S3 without any
 * node code changing.
 */
export type AssetStore = {
  /**
   * Writes the bytes and returns where they now live: an absolute path for the
   * local store, an https URL for a hosted one. Whatever comes back is what the
   * database records, and what the fal payload is built from.
   */
  put(key: string, bytes: Buffer): Promise<string>
  get(key: string): Buffer
  url(key: string): string
  /** True when `put` returns a public URL rather than a path on this machine. */
  hosted: boolean
}

export function localStore(root: string): AssetStore {
  const resolve = (key: string) => {
    const full = path.resolve(root, key)
    // A key is derived from a model-supplied URL. Without this, a crafted
    // filename escapes the assets directory and writes anywhere on disk.
    if (full !== root && !full.startsWith(root + path.sep)) {
      throw new Error(`Asset key escapes the store root: ${key}`)
    }
    return full
  }

  return {
    async put(key, bytes) {
      const full = resolve(key)
      mkdirSync(path.dirname(full), { recursive: true })
      writeFileSync(full, bytes)
      return full
    },
    get: (key) => readFileSync(resolve(key)),
    url: (key) => `/assets/${key}`,
    hosted: false,
  }
}

/**
 * The store this process should use.
 *
 * Local disk unless `CLOUDINARY_URL` is set, so the tool keeps working offline,
 * with no account, exactly as it does today — and a hosted store is one
 * environment variable away when references outgrow what can be inlined into a
 * fal request.
 *
 * Misconfiguration is loud. Falling back to local on a bad `CLOUDINARY_URL`
 * would mean a machine silently storing assets somewhere other than the one its
 * operator configured.
 */
export function storeFor(root: string): AssetStore {
  const configured = process.env.CLOUDINARY_URL
  if (!configured?.trim()) return localStore(root)
  return cloudinaryStore(parseCloudinaryUrl(configured), localStore(root))
}
