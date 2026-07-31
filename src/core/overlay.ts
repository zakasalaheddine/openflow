import type { AdFormat, TextBox, TextOverlay } from './types'
import { DEFAULT_TEXT_BOX } from './spec'

/** The declared box, in fractions of the frame. What the spec check measures. */
export const boxOf = (overlay: TextOverlay | undefined): TextBox | undefined =>
  hasText(overlay) ? (overlay!.box ?? DEFAULT_TEXT_BOX) : undefined

export const hasText = (overlay: TextOverlay | undefined): boolean =>
  Boolean(overlay?.headline?.trim() || overlay?.cta?.trim())

const escapeXml = (text: string) =>
  text.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`)

/**
 * The overlay as an SVG sized to the frame, ready for sharp to composite.
 *
 * Type is fitted to the declared box by arithmetic rather than measurement:
 * font size follows the box height, and the box — not the glyphs — is what the
 * spec check validates. That is the whole reason this project places the text
 * instead of asking a model to draw it.
 *
 * ponytail: no line wrapping and no real text metrics, so a long headline can
 * overflow the box it was checked against. Measure with a font metrics library
 * if headlines start arriving from briefs rather than from a person typing one.
 */
export function overlaySvg(overlay: TextOverlay, format: AdFormat): string {
  const box = overlay.box ?? DEFAULT_TEXT_BOX
  const x = box.x * format.w
  const y = box.y * format.h
  const w = box.w * format.w
  const h = box.h * format.h

  const headline = overlay.headline?.trim()
  const cta = overlay.cta?.trim()
  const headlineSize = Math.round(h * (cta ? 0.42 : 0.6))
  const ctaSize = Math.round(h * 0.26)

  const lines = [
    headline
      ? `<text x="${x + w / 2}" y="${y + h * (cta ? 0.42 : 0.62)}" font-size="${headlineSize}" font-weight="700">${escapeXml(headline)}</text>`
      : '',
    cta
      ? `<text x="${x + w / 2}" y="${y + h * 0.88}" font-size="${ctaSize}" font-weight="500">${escapeXml(cta)}</text>`
      : '',
  ].join('')

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${format.w}" height="${format.h}">
  <g fill="#ffffff" font-family="Helvetica, Arial, DejaVu Sans, sans-serif" text-anchor="middle"
     style="paint-order: stroke; stroke: rgba(0,0,0,0.55); stroke-width: ${Math.round(h * 0.05)}px">
    ${lines}
  </g>
</svg>`
}
