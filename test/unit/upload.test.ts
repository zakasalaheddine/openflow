import { describe, test, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { storeUpload, kindFor, UploadRejected, MAX_BYTES } from '@/core/upload'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function store() {
  const dir = mkdtempSync(path.join(tmpdir(), 'openflow-up-'))
  dirs.push(dir)
  return dir
}

const png = Buffer.from('fake-png-bytes')

describe('storeUpload', () => {
  test('writes the file inside the store and references it by key', async () => {
    const root = store()
    const { key, reference } = await storeUpload(root, { mime: 'image/png', bytes: png })

    expect(existsSync(path.join(root, key))).toBe(true)
    // No hosted store configured, so the row keeps the key rather than a URL.
    expect(reference).toBe(key)
  })

  test('returns a relative key, not a filesystem path, for storage', async () => {
    // The row keeps the key so the database survives the store moving, and so a
    // URL is never derived from a filesystem location.
    const { key } = await storeUpload(store(), { mime: 'image/png', bytes: png })
    expect(key).toMatch(/^uploads\/[0-9a-f-]{36}\.png$/)
  })

  test('names the file itself rather than trusting the client', async () => {
    // The stored name comes from a UUID and the mime's extension. A filename is
    // attacker-controlled input, so it never reaches the path at all.
    const { key } = await storeUpload(store(), { mime: 'image/png', bytes: png })

    expect(path.basename(key)).toMatch(/^[0-9a-f-]{36}\.png$/)
    expect(path.dirname(key)).toBe('uploads')
  })

  test('gives two uploads of identical bytes separate files', async () => {
    // Replacing an asset must not overwrite the version still in use by a
    // cached run.
    const root = store()
    const a = await storeUpload(root, { mime: 'image/png', bytes: png })
    const b = await storeUpload(root, { mime: 'image/png', bytes: png })
    expect(a.key).not.toBe(b.key)
  })

  test('refuses a mime that is not on the allow-list', async () => {
    await expect(storeUpload(store(), { mime: 'application/x-sh', bytes: png })).rejects.toThrow(
      UploadRejected,
    )
  })

  test('refuses a file with no mime at all', async () => {
    await expect(storeUpload(store(), { mime: '', bytes: png })).rejects.toThrow(UploadRejected)
  })

  test('refuses an empty file', async () => {
    // An empty reference image would dispatch and be billed for nothing.
    await expect(
      storeUpload(store(), { mime: 'image/png', bytes: Buffer.alloc(0) }),
    ).rejects.toThrow(UploadRejected)
  })

  test('refuses a file over the size cap', async () => {
    const oversized = Buffer.alloc(MAX_BYTES + 1)
    await expect(storeUpload(store(), { mime: 'image/png', bytes: oversized })).rejects.toThrow(
      UploadRejected,
    )
  })

  test('says what was wrong, in words someone can act on', async () => {
    await expect(storeUpload(store(), { mime: 'application/pdf', bytes: png })).rejects.toThrow(/pdf/)
  })
})

describe('kindFor', () => {
  test('maps mime to source kind', () => {
    expect(kindFor('image/png')).toBe('image')
    expect(kindFor('video/mp4')).toBe('video')
    expect(kindFor('text/plain')).toBe('text')
  })
})
