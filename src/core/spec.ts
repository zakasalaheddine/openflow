import type { AdFormat, FormatSpec, TextBox } from './types'

/**
 * Ad-format validation: the depth the general canvases do not ship.
 *
 * Every rule here is a client rejection that would otherwise arrive after the
 * buy is booked. Failing loudly at export costs a re-render; failing silently
 * costs the placement.
 *
 * Deliberately arithmetic, never OCR. Text this project places is declared as a
 * box, so its position is known before a pixel is drawn. Text an image model
 * burned into its own output is invisible here and is not claimed to be checked.
 */
export const DEFAULT_FORMAT_SPEC: FormatSpec = {
  // Vertical placements put UI chrome top and bottom; the bottom margin is the
  // larger one because that is where the caption and CTA rail live.
  safeZone: { top: 0.14, right: 0.06, bottom: 0.2, left: 0.06 },
  // 1 = the source must already cover the placement. Upscaled output reads as a
  // cheap ad and no amount of prompt work fixes it after the fact.
  minScale: 1,
  maxDurationSec: 60,
  maxTextCoverage: 0.2,
}

/** Sits in the lower third, inside the default safe zone. */
export const DEFAULT_TEXT_BOX: TextBox = { x: 0.1, y: 0.55, w: 0.8, h: 0.15 }

export const specFor = (format: AdFormat): FormatSpec => ({
  ...DEFAULT_FORMAT_SPEC,
  ...format.spec,
  safeZone: { ...DEFAULT_FORMAT_SPEC.safeZone, ...format.spec?.safeZone },
})

export type SpecFinding = { rule: string; message: string }

export type SpecCheck = {
  pass: boolean
  format: string
  findings: SpecFinding[]
}

export type SpecInput = {
  format: AdFormat
  /** The source asset's real dimensions, before any resize. */
  sourceWidth: number
  sourceHeight: number
  durationSec?: number
  /** Only set when this project placed the text. */
  textBox?: TextBox
}

/**
 * Returns findings rather than throwing, and the caller records the result
 * either way — the record has to exist on a pass too, or "this export was
 * checked" is indistinguishable from "this export was never checked".
 */
export function checkSpec(input: SpecInput): SpecCheck {
  const { format, sourceWidth, sourceHeight, durationSec, textBox } = input
  const spec = specFor(format)
  const findings: SpecFinding[] = []

  const minW = Math.ceil(format.w * spec.minScale)
  const minH = Math.ceil(format.h * spec.minScale)
  if (sourceWidth < minW || sourceHeight < minH) {
    findings.push({
      rule: 'min_resolution',
      message: `${format.name} needs at least ${minW}x${minH}; the source is ${sourceWidth}x${sourceHeight}.`,
    })
  }

  if (durationSec !== undefined && durationSec > spec.maxDurationSec) {
    findings.push({
      rule: 'duration',
      message: `${format.name} allows at most ${spec.maxDurationSec}s; this is ${durationSec}s.`,
    })
  }

  if (textBox) {
    // Named, not just flagged: "text overlaps the safe zone" sends someone
    // hunting, "text overlaps the bottom safe zone" is one drag to fix.
    const { top, right, bottom, left } = spec.safeZone
    const breached = [
      textBox.y < top ? 'top' : null,
      textBox.x < left ? 'left' : null,
      textBox.x + textBox.w > 1 - right ? 'right' : null,
      textBox.y + textBox.h > 1 - bottom ? 'bottom' : null,
    ].filter((zone): zone is string => zone !== null)

    if (breached.length > 0) {
      findings.push({
        rule: 'safe_zone',
        message: `Text overlaps the ${breached.join(' and ')} safe zone of ${format.name}.`,
      })
    }

    const coverage = textBox.w * textBox.h
    if (coverage > spec.maxTextCoverage) {
      findings.push({
        rule: 'text_coverage',
        message: `Text covers ${(coverage * 100).toFixed(0)}% of ${format.name}; the limit is ${(spec.maxTextCoverage * 100).toFixed(0)}%.`,
      })
    }
  }

  return { pass: findings.length === 0, format: format.name, findings }
}

export type CropBox = { left: number; top: number; width: number; height: number }

/**
 * The crop that turns a source into a format, centred, without distortion.
 *
 * Rounding happens once, here, with `Math.round` on both axes — an export that
 * floors one dimension and rounds the other yields two different files for the
 * same input on different days, and nobody ever works out why the 1080 asset is
 * sometimes 1079.
 */
export function coverCrop(
  sourceWidth: number,
  sourceHeight: number,
  format: AdFormat,
): CropBox {
  const scale = Math.max(format.w / sourceWidth, format.h / sourceHeight)
  const width = Math.min(sourceWidth, Math.round(format.w / scale))
  const height = Math.min(sourceHeight, Math.round(format.h / scale))
  return {
    left: Math.round((sourceWidth - width) / 2),
    top: Math.round((sourceHeight - height) / 2),
    width,
    height,
  }
}
