/**
 * The shape a still is rendered at.
 *
 * A frame's aspect used to be whatever the endpoint felt like — square, for
 * every row in the catalog — while the project shipped 9:16 by default. Export
 * then refused the vertical every single time, correctly (`spec.ts` will not
 * upscale a square into a portrait), so a format the settings offered was a
 * format nothing in the app could ever satisfy.
 *
 * Four, not an open `{ w, h }`: these are placements, and a number someone
 * types is a number that has to be validated against every endpoint's own
 * bounds. Add one here when a placement needs it.
 */
export const ASPECTS = ['1:1', '4:5', '9:16', '16:9'] as const

export type Aspect = (typeof ASPECTS)[number]

export const DEFAULT_ASPECT: Aspect = '1:1'

/**
 * The pixels each aspect renders at, and the same numbers the estimate is
 * priced from.
 *
 * One table, read by both `buildModelInput` and `planRun`, because a per-
 * megapixel row bills what it renders: `flux-2-pro` at 9:16 is 1.83 MP against
 * 1.05 at 1:1, which is 5c rather than 3c. Two tables that agree today are two
 * tables that disagree the first time one is edited, and the card would go on
 * showing the old number — for the one figure this tool exists to be right
 * about.
 */
const PIXELS: Record<Aspect, { width: number; height: number }> = {
  '1:1': { width: 1024, height: 1024 },
  '4:5': { width: 1024, height: 1280 },
  '9:16': { width: 1024, height: 1792 },
  '16:9': { width: 1792, height: 1024 },
}

export const pixelsFor = (aspect: Aspect = DEFAULT_ASPECT) => PIXELS[aspect]
