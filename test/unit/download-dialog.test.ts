import { describe, test, expect } from 'vitest'
import { passingFormats } from '@/app/download-dialog'
import type { DownloadPreview } from '@/app/state'

const preview = (verdicts: DownloadPreview['verdicts']): DownloadPreview => ({
  verdicts,
  stale: [],
  formats: [{ name: '1:1', w: 1080, h: 1080 }],
})

describe('passingFormats', () => {
  // The per-card dialog's regression: a ticked scope with no verdict of its
  // own (the node has not rendered under this hash) must not read as
  // passing. `[].every()` is `true`, so without a length guard a scope with
  // zero verdicts in it counted every format as shippable.
  test('a format with no verdict in the ticked scope does not pass', () => {
    const p = preview([{ nodeId: 'other', format: '1:1', pass: true, reasons: [] }])

    expect(passingFormats(p, new Set(['marble']))).toEqual(new Set())
  })

  test('a format still passes when every verdict in scope passes', () => {
    const p = preview([{ nodeId: 'marble', format: '1:1', pass: true, reasons: [] }])

    expect(passingFormats(p, new Set(['marble']))).toEqual(new Set(['1:1']))
  })

  test('a format fails when any verdict in scope fails', () => {
    const p = preview([{ nodeId: 'marble', format: '1:1', pass: false, reasons: ['too small'] }])

    expect(passingFormats(p, new Set(['marble']))).toEqual(new Set())
  })
})
