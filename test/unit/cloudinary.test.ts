import { describe, test, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  parseCloudinaryUrl,
  signature,
  resourceKind,
  publicIdFor,
  cloudinaryStore,
} from '@/core/cloudinary'
import { localStore, storeFor } from '@/core/assets'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

function root() {
  const dir = mkdtempSync(path.join(tmpdir(), 'openflow-cd-'))
  dirs.push(dir)
  return dir
}

const config = { cloudName: 'acme', apiKey: 'key', apiSecret: 'secret' }

describe('parseCloudinaryUrl', () => {
  test('reads the variable Cloudinary hands you', () => {
    expect(parseCloudinaryUrl('cloudinary://123:abc@my-cloud')).toEqual({
      apiKey: '123',
      apiSecret: 'abc',
      cloudName: 'my-cloud',
    })
  })

  test('refuses anything else, by name', () => {
    // Silently accepting a malformed value would upload nowhere and record a
    // URL nobody can fetch.
    expect(() => parseCloudinaryUrl('https://cloudinary.com/acme')).toThrow(/CLOUDINARY_URL/)
  })
})

describe('signature', () => {
  test('signs parameters in alphabetical order', () => {
    // Cloudinary sorts before hashing. Wrong order is a 401 that reads exactly
    // like a bad key, so this is worth pinning.
    expect(signature({ b: '2', a: '1' }, 'x')).toBe(signature({ a: '1', b: '2' }, 'x'))
  })

  test('a different secret gives a different signature', () => {
    expect(signature({ a: '1' }, 'one')).not.toBe(signature({ a: '1' }, 'two'))
  })
})

describe('resourceKind', () => {
  test('routes media to its own endpoint and everything else to raw', () => {
    // Cloudinary refuses a .txt under `image`, which is how a brand-tone note
    // would fail an upload for reasons that look nothing like the cause.
    expect(resourceKind('uploads/a.mp4')).toBe('video')
    expect(resourceKind('uploads/a.png')).toBe('image')
    expect(resourceKind('uploads/a.txt')).toBe('raw')
  })
})

describe('publicIdFor', () => {
  test('keeps our key, minus the extension', () => {
    // Same render, same public id: a retry overwrites rather than paying to
    // store a second copy of the same frame.
    expect(publicIdFor('uploads/abc.png')).toBe('uploads/abc')
  })
})

describe('cloudinaryStore', () => {
  const okFetch = () =>
    vi.fn(
      async (_url: string, init: RequestInit) =>
        ({
          ok: true,
          status: 200,
          // Handed back so the assertion below can read what was actually sent.
          json: async () => ({
            secure_url: 'https://res.cloudinary.com/acme/image/upload/uploads/a.png',
            sent: init.body,
          }),
        }) as unknown as Response,
    )

  test('returns the hosted url and still leaves the bytes on disk', async () => {
    // The local copy is what ffmpeg and sharp read at export time. Dropping it
    // would make every export download its own inputs.
    const dir = root()
    vi.stubGlobal('fetch', okFetch())

    const store = cloudinaryStore(config, localStore(dir))
    const url = await store.put('uploads/a.png', Buffer.from('bytes'))

    expect(url).toBe('https://res.cloudinary.com/acme/image/upload/uploads/a.png')
    expect(existsSync(path.join(dir, 'uploads/a.png'))).toBe(true)
    expect(readFileSync(path.join(dir, 'uploads/a.png')).toString()).toBe('bytes')
  })

  test('signs the upload without ever sending the secret', async () => {
    const fetchMock = okFetch()
    vi.stubGlobal('fetch', fetchMock)

    await cloudinaryStore(config, localStore(root())).put('uploads/a.png', Buffer.from('b'))

    const form = fetchMock.mock.calls[0]![1].body as FormData
    expect(form.get('api_key')).toBe('key')
    expect(form.get('signature')).toEqual(expect.any(String))
    expect([...form.keys()]).not.toContain('api_secret')
  })

  test('a refused upload throws rather than recording a url that fetches nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 401,
        json: async () => ({ error: { message: 'Invalid Signature' } }),
      }) as unknown as Response),
    )

    await expect(
      cloudinaryStore(config, localStore(root())).put('uploads/a.png', Buffer.from('b')),
    ).rejects.toThrow(/Invalid Signature/)
  })
})

describe('storeFor', () => {
  test('is local disk when nothing is configured', () => {
    vi.stubEnv('CLOUDINARY_URL', '')
    expect(storeFor(root()).hosted).toBe(false)
  })

  test('is hosted the moment CLOUDINARY_URL is set', () => {
    vi.stubEnv('CLOUDINARY_URL', 'cloudinary://123:abc@my-cloud')
    expect(storeFor(root()).hosted).toBe(true)
  })

  test('refuses a malformed CLOUDINARY_URL instead of quietly using local disk', () => {
    // Falling back would mean a machine storing assets somewhere other than
    // where its operator configured, and never saying so.
    vi.stubEnv('CLOUDINARY_URL', 'not-a-cloudinary-url')
    expect(() => storeFor(root())).toThrow(/CLOUDINARY_URL/)
  })
})
