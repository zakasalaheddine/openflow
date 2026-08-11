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

export type AudioStream = { codec: string; sampleRate: number; channels: number }

/**
 * The clip's first audio stream, or null when it is silent.
 *
 * Its own ffprobe rather than a wider `probe`: that one selects `v:0`, and its
 * width and height are what asset rows and the export crop are computed from.
 * Widening its stream selection to notice audio risks handing a caller the
 * dimensions of a stream that has none.
 */
export async function audioOf(file: string): Promise<AudioStream | null> {
  const stdout = await call('ffprobe', [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name,sample_rate,channels',
    '-of', 'json',
    file,
  ])
  const parsed = JSON.parse(stdout) as {
    streams?: { codec_name?: string; sample_rate?: string; channels?: number }[]
  }
  const stream = parsed.streams?.[0]
  if (!stream) return null
  return {
    codec: stream.codec_name ?? 'unknown',
    sampleRate: Number(stream.sample_rate ?? 0),
    channels: stream.channels ?? 0,
  }
}

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
 * Sound comes along. A clip rendered with native audio (veo-3-1 with
 * `generate_audio`) keeps it, and a silent clip in the same film becomes
 * silence of its own length rather than dropping the whole soundtrack — so the
 * cut is quiet only where the shot was.
 */
export async function concat(
  files: string[],
  out: string,
  settings: { fps: number; codec: string },
): Promise<void> {
  if (files.length === 0) throw new Error('Nothing to cut together.')

  // `0:a?` is the optional audio map: it carries the sound through when there
  // is any, and does not fail the command when there is none.
  const copy = ['-map', '0:v:0', '-map', '0:a?', '-c', 'copy']
  if (files.length === 1) {
    await ffmpeg(['-i', files[0], ...copy, out])
    return
  }

  const probed = await Promise.all(files.map(probe))
  const sound = await Promise.all(files.map(audioOf))
  const [first] = probed

  // Audio has to match as strictly as the frame does: a stream copy cannot
  // reconcile two AAC streams recorded at different rates any more than it can
  // two frame sizes.
  const same = (clip: Probe, i: number) =>
    clip.width === first.width &&
    clip.height === first.height &&
    JSON.stringify(sound[i]) === JSON.stringify(sound[0])

  if (probed.every(same)) {
    // The concat demuxer reads a list file rather than a filter graph, and
    // `-safe 0` is what lets that list hold absolute paths.
    const list = `${out}.concat.txt`
    // Single quotes are the demuxer's own escape, and a path containing one
    // would end the entry early — the store writes UUID filenames, so this is
    // belt and braces rather than a live risk.
    writeFileSync(list, files.map((file) => `file '${file.replaceAll("'", "'\\''")}'\n`).join(''))
    try {
      await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, ...copy, out])
    } finally {
      rmSync(list, { force: true })
    }
    return
  }

  const audible = sound.some(Boolean)
  const inputs = files.flatMap((file) => ['-i', file])
  const chains = probed.map((_, i) => `[${i}:v]scale=${first.width}:${first.height},setsar=1[v${i}]`)
  if (audible) {
    // Both branches end in the same `aformat`, sample format included: the
    // concat filter refuses segments whose audio does not agree, and generated
    // silence agrees with a decoded AAC stream on none of it by default.
    chains.push(
      ...probed.map((clip, i) =>
        sound[i]
          ? `[${i}:a:0]${AUDIO_FORMAT}[a${i}]`
          : `anullsrc=r=48000:cl=stereo,atrim=0:${(clip.durationMs / 1000).toFixed(3)},${AUDIO_FORMAT}[a${i}]`,
      ),
    )
  }
  const joined = probed.map((_, i) => (audible ? `[v${i}][a${i}]` : `[v${i}]`)).join('')
  await ffmpeg([
    ...inputs,
    '-filter_complex',
    `${chains.join(';')};${joined}concat=n=${files.length}:v=1:a=${audible ? 1 : 0}[out]${audible ? '[aout]' : ''}`,
    '-map', '[out]',
    ...(audible ? ['-map', '[aout]', '-c:a', 'aac'] : []),
    '-r', String(settings.fps),
    '-c:v', encoderFor(settings.codec),
    '-pix_fmt', 'yuv420p',
    out,
  ])
}

const AUDIO_FORMAT = 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo'
