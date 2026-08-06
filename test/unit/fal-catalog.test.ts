import { describe, test, expect } from 'vitest'
import { shortIdFor, capsFrom, priceFrom, formatFor, buildRow, parseListLine } from '@/models/fal-catalog'

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
    // fal puts the tier AFTER the task here. Stripping only the tail left this
    // one as the bare word `draft`, which names nothing and collides with every
    // other model's draft tier.
    ['blackforestlabs/flux-3/image-to-video/draft', 'flux-3-draft'],
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

  test('reads the dollar sign after the number, which fal also writes', () => {
    // blackforestlabs/flux-3/image-to-video/draft, verbatim. A real, published,
    // unambiguous price that went unread because the regex wanted the $ first.
    expect(
      priceFrom('Your request will be charged at **0.06** $ per second of generated draft video (720p).'),
    ).toEqual({ unit: 'second', amount: 6 })
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

  test('leaves a token-priced model unpriced, because it has no per-image number', () => {
    // openai/gpt-image-2, verbatim. Everything here is per million tokens, and
    // fal publishes no per-image figure anywhere — inventing one from $30/1M
    // would need a token count per image that nobody published.
    expect(
      priceFrom(
        'Text tokens (per 1M): **$5.00** input, **$1.25** cached, **$10.00** output.\nImage tokens (per 1M): **$8.00** input, **$2.00** cached, **$30.00** output.',
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

  test('refuses a model it cannot price, naming the line that would fix it', () => {
    // Every row that lands has a price. A model in the picker that Run then
    // refuses is a worse answer than one line telling you what to type.
    expect(buildRow({ ...candidate, entry: { ...candidate.entry, pricingInfoOverride: null } })).toMatchObject({
      ok: false,
      reason: /0\.12\/image/,
    })
  })

  test('takes the price you wrote when fal has none, and only then', () => {
    // openai/gpt-image-2 is priced per million tokens. No arithmetic turns that
    // into a per-image figure without a token count nobody publishes.
    const tokenPriced = { ...candidate.entry, pricingInfoOverride: 'Image tokens (per 1M): **$30.00** output.' }
    expect(
      buildRow({ ...candidate, entry: tokenPriced, priceOverride: { unit: 'image', amount: 12 } }),
    ).toMatchObject({ ok: true, row: { cost: { unit: 'image', amount: 12 } } })

    // fal's own price still wins when there is one, so a stale number in the
    // list file cannot quietly override what you are actually charged.
    expect(
      buildRow({ ...candidate, priceOverride: { unit: 'image', amount: 999 } }),
    ).toMatchObject({ ok: true, row: { cost: { amount: 3 } } })
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

describe('parseListLine', () => {
  test('a bare slug asks fal for everything', () => {
    expect(parseListLine('openai/gpt-image-2')).toEqual({ slug: 'openai/gpt-image-2' })
  })

  test('a slug with a price carries it, dollars per unit', () => {
    expect(parseListLine('openai/gpt-image-2  0.12/image')).toEqual({
      slug: 'openai/gpt-image-2',
      price: { unit: 'image', amount: 12 },
    })
    expect(parseListLine('fal-ai/x  $0.28 / second')).toEqual({
      slug: 'fal-ai/x',
      price: { unit: 'second', amount: 28 },
    })
  })

  test('trailing noise is not read as a price, so a typo cannot invent one', () => {
    expect(parseListLine('fal-ai/x 0.12')).toEqual({ slug: 'fal-ai/x' })
    expect(parseListLine('fal-ai/x per image')).toEqual({ slug: 'fal-ai/x' })
  })
})
