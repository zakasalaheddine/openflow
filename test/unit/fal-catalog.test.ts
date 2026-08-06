import { describe, test, expect } from 'vitest'
import { shortIdFor, capsFrom, priceFrom, formatFor, buildRow } from '@/models/fal-catalog'

describe('shortIdFor', () => {
  test.each([
    ['fal-ai/bytedance/seedream/v4/text-to-image', 'seedream-v4'],
    ['fal-ai/recraft/v3/text-to-image', 'recraft-v3'],
    ['fal-ai/minimax/hailuo-02/pro/image-to-video', 'hailuo-02-pro'],
    ['fal-ai/kling-video/v3/pro/image-to-video', 'kling-video-v3-pro'],
    ['fal-ai/bytedance/seedance/v1.5/pro/image-to-video', 'seedance-v1.5-pro'],
    ['fal-ai/nano-banana-pro', 'nano-banana-pro'],
    ['fal-ai/flux-2-pro/edit', 'flux-2-pro'],
    ['fal-ai/veo3.1/image-to-video', 'veo3.1'],
  ])('%s → %s', (slug, expected) => {
    expect(shortIdFor(slug)).toBe(expected)
  })

  test('never returns a bare version or tier, which would name nothing', () => {
    // Right-to-left until something is actually named: `v3` or `master` alone
    // would collide with every other model that has one.
    expect(shortIdFor('fal-ai/kling-video/v3/master/image-to-video')).toBe('kling-video-v3-master')
  })
})

describe('formatFor', () => {
  test('maps fal tasks onto the two node types that can run them', () => {
    expect(formatFor('text-to-image')).toBe('image')
    expect(formatFor('image-to-image')).toBe('image')
    expect(formatFor('image-to-video')).toBe('video')
    expect(formatFor('video-to-video')).toBe('video')
  })

  test('refuses anything with no node to live on', () => {
    // There is no speech node and no LLM node, and adding one as an "image"
    // would put it in a picker where every choice fails at render time.
    expect(formatFor('text-to-speech')).toBeNull()
    expect(formatFor('llm')).toBeNull()
    expect(formatFor(undefined)).toBeNull()
  })
})

describe('capsFrom', () => {
  test('reads a video model off its own schema', () => {
    // fal-ai/veo3.1/image-to-video, verbatim from its OpenAPI.
    expect(
      capsFrom({
        prompt: { type: 'string' },
        image_url: { type: 'string' },
        duration: { type: 'string', enum: ['4s', '6s', '8s'] },
        generate_audio: { type: 'boolean' },
      }),
    ).toEqual({
      refImages: 0,
      textRendering: false,
      startEndFrame: true,
      nativeAudio: true,
      maxDurationSec: 8,
    })
  })

  test('an edit endpoint that declares no limit gets one reference, not many', () => {
    // Conservative on purpose: too high drops the anchors past the real limit
    // at full price, too low refuses a wire you can fix by raising the number.
    expect(capsFrom({ image_urls: { type: 'array', maxItems: null } }).refImages).toBe(1)
    expect(capsFrom({ image_urls: { type: 'array', maxItems: 6 } }).refImages).toBe(6)
  })

  test('text rendering is never claimed, because no schema says it', () => {
    expect(capsFrom({ prompt: { type: 'string' } }).textRendering).toBe(false)
  })
})

describe('priceFrom', () => {
  test('reads the amount when it comes before the unit', () => {
    // fal-ai/nano-banana-pro, verbatim.
    expect(
      priceFrom('Your request will cost **$0.15** per image. For **$1.00**, you can run this model **7** times.'),
    ).toEqual({ unit: 'image', amount: 15 })
  })

  test('reads it when the unit comes first', () => {
    // fal-ai/veo3.1, verbatim.
    expect(
      priceFrom('For every second of video you generated, you will be charged **$0.084** (audio off).'),
    ).toEqual({ unit: 'second', amount: 8.4 })
  })

  test('keeps fractions of a cent rather than rounding them to free', () => {
    expect(priceFrom('Tentative pricing is **$0.0675** per image.')).toEqual({
      unit: 'image',
      amount: 6.75,
    })
  })

  test('refuses a figure that is not tied to a unit', () => {
    // Seedream v5, verbatim: this $0.0045 is a surcharge on extra INPUT images,
    // not the price of an output. A "first dollar figure wins" parse would file
    // it as the render price and under-quote every Run by two orders of
    // magnitude — so an unreadable price is a refusal, never a guess.
    expect(
      priceFrom(
        'You will be charged for both input and output images. The first input image is not charged, and every additional input image will cost **$0.0045**.',
      ),
    ).toBeNull()
  })

  test('refuses nothing at all', () => {
    expect(priceFrom(null)).toBeNull()
    expect(priceFrom('')).toBeNull()
    expect(priceFrom('Pricing varies. See the model page.')).toBeNull()
  })
})

describe('buildRow', () => {
  const candidate = {
    slug: 'fal-ai/bytedance/seedream/v4/text-to-image',
    entry: {
      id: 'fal-ai/bytedance/seedream/v4/text-to-image',
      category: 'text-to-image',
      pricingInfoOverride: 'Your request will cost **$0.03** per image.',
    },
    schema: { prompt: { type: 'string' } },
  }

  test('builds a row from what fal published', () => {
    const built = buildRow(candidate)
    expect(built).toMatchObject({
      ok: true,
      row: {
        id: 'seedream-v4',
        format: 'image',
        falEndpoint: 'fal-ai/bytedance/seedream/v4/text-to-image',
        cost: { unit: 'image', amount: 3 },
        // Read off a schema and a sentence, not off a render.
        verifiedOn: null,
      },
    })
  })

  test('keeps the sentence the price was read out of', () => {
    // The regex cannot see "4K outputs are charged at double" — the note is
    // what you check the number against.
    const built = buildRow(candidate)
    expect(built).toMatchObject({ ok: true, row: { pricingNote: /cost \$0.03 per image/ } as never })
  })

  test('adds a model fal does not price, with a null amount rather than a zero', () => {
    // fal publishes no readable price for roughly half its catalogue. Dropping
    // those would make "add the models you want" quietly mean "add the ones fal
    // wrote a sentence about". Zero would be worse still: it quotes nothing
    // before a Run and the spend cap cannot see it.
    expect(buildRow({ ...candidate, entry: { ...candidate.entry, pricingInfoOverride: null } })).toMatchObject({
      ok: true,
      row: { id: 'seedream-v4', cost: { amount: null } },
    })
  })

  test('an unreadable price is unpriced too, not a guess at the first figure', () => {
    const built = buildRow({
      ...candidate,
      entry: {
        ...candidate.entry,
        pricingInfoOverride: 'Each 720p 5 second video with audio costs roughly $0.26.',
      },
    })
    expect(built).toMatchObject({ ok: true, row: { cost: { amount: null } } })
    // And the sentence rides along, so the number you have to write down is one
    // you can read off the row rather than go hunting for.
    expect(built).toMatchObject({ ok: true, row: { pricingNote: /costs roughly \$0.26/ } as never })
  })

  test('refuses a deprecated model, and one with no node to live on', () => {
    expect(buildRow({ ...candidate, entry: { ...candidate.entry, deprecated: true } })).toMatchObject({
      ok: false,
      reason: /deprecated/,
    })
    expect(buildRow({ ...candidate, entry: { ...candidate.entry, category: 'llm' } })).toMatchObject({
      ok: false,
      reason: /neither an image nor a video/,
    })
  })

  test('says when the reference limit is ours rather than fal\'s', () => {
    // The wiring gate enforces this number. A second reference refused against
    // an assumed 1 reads as the model's limit, not as a line you can raise.
    expect(
      buildRow({ ...candidate, editSlug: 'x/edit', editSchema: { image_urls: { type: 'array' } } }),
    ).toMatchObject({ ok: true, assumedRefLimit: true })

    expect(
      buildRow({
        ...candidate,
        editSlug: 'x/edit',
        editSchema: { image_urls: { type: 'array', maxItems: 6 } },
      }),
    ).toMatchObject({ ok: true, assumedRefLimit: false })

    // A model with no reference field at all assumes nothing.
    expect(buildRow(candidate)).toMatchObject({ ok: true, assumedRefLimit: false })
  })

  test('takes the reference limit from whichever endpoint accepts references', () => {
    // fal splits these: the plain endpoint has no image_urls field at all, and
    // the /edit one requires it. The row keeps one id and both URLs.
    const built = buildRow({
      ...candidate,
      editSlug: 'fal-ai/bytedance/seedream/v4/edit',
      editSchema: { image_urls: { type: 'array', maxItems: 4 } },
    })
    expect(built).toMatchObject({
      ok: true,
      row: {
        editEndpoint: 'fal-ai/bytedance/seedream/v4/edit',
        caps: { refImages: 4 },
      },
    })
  })
})
