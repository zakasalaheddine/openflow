import { writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

/**
 * Three methods, on purpose. A hosted demo swaps local disk for S3 without any
 * node code changing.
 */
export type AssetStore = {
  put(key: string, bytes: Buffer): string
  get(key: string): Buffer
  url(key: string): string
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
    put(key, bytes) {
      const full = resolve(key)
      mkdirSync(path.dirname(full), { recursive: true })
      writeFileSync(full, bytes)
      return full
    },
    get: (key) => readFileSync(resolve(key)),
    url: (key) => `/assets/${key}`,
  }
}
