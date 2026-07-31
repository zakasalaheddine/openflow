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
  test('writes the file inside the store and returns its path', () => {
    const root = store()
    const { path: written } = storeUpload(root, { mime: 'image/png', bytes: png })

    expect(written.startsWith(root)).toBe(true)
    expect(existsSync(written)).toBe(true)
  })

  test('returns a relative key, not a filesystem path, for storage', () => {
    // The row keeps the key so the database survives the store moving, and so a
    // URL is never derived from a filesystem location.
    const { key } = storeUpload(store(), { mime: 'image/png', bytes: png })
    expect(key).toMatch(/^uploads\/[0-9a-f-]{36}\.png$/)
  })

  test('names the file itself rather than trusting the client', () => {
    // The stored name comes from a UUID and the mime's extension. A filename is
    // attacker-controlled input, so it never reaches the path at all.
    const root = store()
    const { path: written } = storeUpload(root, { mime: 'image/png', bytes: png })

    expect(path.basename(written)).toMatch(/^[0-9a-f-]{36}\.png$/)
    expect(path.dirname(written)).toBe(path.join(root, 'uploads'))
  })

  test('gives two uploads of identical bytes separate files', () => {
    // Replacing an asset must not overwrite the version still in use by a
    // cached run.
    const root = store()
    const a = storeUpload(root, { mime: 'image/png', bytes: png })
    const b = storeUpload(root, { mime: 'image/png', bytes: png })
    expect(a.path).not.toBe(b.path)
  })

  test('refuses a mime that is not on the allow-list', () => {
    expect(() => storeUpload(store(), { mime: 'application/x-sh', bytes: png })).toThrow(UploadRejected)
  })

  test('refuses a file with no mime at all', () => {
    expect(() => storeUpload(store(), { mime: '', bytes: png })).toThrow(UploadRejected)
  })

  test('refuses an empty file', () => {
    // An empty reference image would dispatch and be billed for nothing.
    expect(() => storeUpload(store(), { mime: 'image/png', bytes: Buffer.alloc(0) })).toThrow(
      UploadRejected,
    )
  })

  test('refuses a file over the size cap', () => {
    const oversized = Buffer.alloc(MAX_BYTES + 1)
    expect(() => storeUpload(store(), { mime: 'image/png', bytes: oversized })).toThrow(UploadRejected)
  })

  test('says what was wrong, in words someone can act on', () => {
    expect(() => storeUpload(store(), { mime: 'application/pdf', bytes: png })).toThrow(/pdf/)
  })
})

describe('kindFor', () => {
  test('maps mime to source kind', () => {
    expect(kindFor('image/png')).toBe('image')
    expect(kindFor('video/mp4')).toBe('video')
    expect(kindFor('text/plain')).toBe('text')
  })
})
