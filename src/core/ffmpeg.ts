import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/**
 * System ffmpeg, not a bundled one.
 *
 * `ffmpeg-static` is ~80MB in every install of a tool whose whole pitch is that
 * it runs on your machine without ceremony. The cost of not bundling is one
 * setup step, and it is paid once, loudly, with the command to fix it — the
 * same bargain scripts/check-node.mjs already makes for the Node version.
 */
export class FfmpegMissingError extends Error {
  constructor(binary: string) {
    super(
      `OpenFlow needs ${binary} on your PATH to handle video.\n\n` +
        `  macOS:  brew install ffmpeg\n` +
        `  Debian: sudo apt install ffmpeg\n\n` +
        `Image-only flows work without it.`,
    )
    this.name = 'FfmpegMissingError'
  }
}

const isMissing = (error: unknown) =>
  (error as NodeJS.ErrnoException)?.code === 'ENOENT'

async function call(binary: 'ffmpeg' | 'ffprobe', args: string[]): Promise<string> {
  try {
    const { stdout } = await exec(binary, args, { maxBuffer: 32 * 1024 * 1024 })
    return stdout
  } catch (error) {
    if (isMissing(error)) throw new FfmpegMissingError(binary)
    throw error
  }
}

export type Probe = {
  width: number
  height: number
  durationMs: number
  fps: number
  codec: string
}

/**
 * What the file actually is, never what the model said it would be.
 *
 * A row that records the requested duration rather than the delivered one turns
 * every downstream length check into a check of our own optimism.
 */
export async function probe(file: string): Promise<Probe> {
  const stdout = await call('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate,codec_name',
    '-show_entries', 'format=duration',
    '-of', 'json',
    file,
  ])

  const parsed = JSON.parse(stdout) as {
    streams?: { width?: number; height?: number; r_frame_rate?: string; codec_name?: string }[]
    format?: { duration?: string }
  }
  const stream = parsed.streams?.[0]
  if (!stream?.width || !stream.height) {
    throw new Error(`ffprobe found no video stream in ${file}`)
  }

  const [num, den] = (stream.r_frame_rate ?? '0/1').split('/').map(Number)
  return {
    width: stream.width,
    height: stream.height,
    durationMs: Math.round(Number(parsed.format?.duration ?? 0) * 1000),
    // Rounded: 30000/1001 is 29.97, and an fps column that stores 29.97 as a
    // float compares unequal to itself across a re-probe.
    fps: den ? Math.round(num / den) : 0,
    codec: stream.codec_name ?? 'unknown',
  }
}

export const ffmpeg = (args: string[]) => call('ffmpeg', ['-v', 'error', '-y', ...args])

/**
 * Project settings name a codec the way a person does; ffmpeg wants an encoder.
 * An unknown name passes through, so a user can name an encoder directly.
 */
const ENCODERS: Record<string, string> = { h264: 'libx264', h265: 'libx265', vp9: 'libvpx-vp9' }
export const encoderFor = (codec: string) => ENCODERS[codec] ?? codec
