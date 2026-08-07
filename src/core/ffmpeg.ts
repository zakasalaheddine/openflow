import { execFile } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
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

/**
 * Several clips, end to end, in the order given.
 *
 * A cut when it can be and a re-encode when it must be. Every clip was already
 * normalised to the project's fps and codec as it landed, which is what the
 * concat demuxer needs — but `normalise` deliberately leaves *dimensions* alone,
 * and the demuxer's stream copy refuses inputs of different sizes. So the sizes
 * are probed first: all equal is a copy, which is instant and loses nothing;
 * anything else scales every clip to the first one's frame and re-encodes.
 *
 * ponytail: video only. A clip with native audio (veo-3-1 with `generate_audio`)
 * loses it here, in both paths, rather than producing a film whose sound cuts
 * in and out depending on which model rendered which shot. Mixing a real
 * soundtrack is its own feature.
 */
export async function concat(
  files: string[],
  out: string,
  settings: { fps: number; codec: string },
): Promise<void> {
  if (files.length === 0) throw new Error('Nothing to cut together.')
  if (files.length === 1) {
    await ffmpeg(['-i', files[0], '-c', 'copy', '-an', out])
    return
  }

  const probed = await Promise.all(files.map(probe))
  const [first] = probed

  if (probed.every((clip) => clip.width === first.width && clip.height === first.height)) {
    // The concat demuxer reads a list file rather than a filter graph, and
    // `-safe 0` is what lets that list hold absolute paths.
    const list = `${out}.concat.txt`
    // Single quotes are the demuxer's own escape, and a path containing one
    // would end the entry early — the store writes UUID filenames, so this is
    // belt and braces rather than a live risk.
    writeFileSync(list, files.map((file) => `file '${file.replaceAll("'", "'\\''")}'\n`).join(''))
    try {
      await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-an', out])
    } finally {
      rmSync(list, { force: true })
    }
    return
  }

  const inputs = files.flatMap((file) => ['-i', file])
  const scaled = probed
    .map((_, i) => `[${i}:v]scale=${first.width}:${first.height},setsar=1[v${i}]`)
    .join(';')
  const joined = probed.map((_, i) => `[v${i}]`).join('')
  await ffmpeg([
    ...inputs,
    '-filter_complex',
    `${scaled};${joined}concat=n=${files.length}:v=1:a=0[out]`,
    '-map', '[out]',
    '-r', String(settings.fps),
    '-c:v', encoderFor(settings.codec),
    '-pix_fmt', 'yuv420p',
    out,
  ])
}
