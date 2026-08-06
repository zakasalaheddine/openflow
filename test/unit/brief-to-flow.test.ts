import { describe, test, expect } from 'vitest'
import { buildFlowFromBrief, loadTemplates, BriefError, type FlowTemplate } from '@/core/brief'
import { flowSchema } from '@/core/schema'

// LLM output is untrusted input. It picks and fills a template; it never
// invents topology — a model that can emit arbitrary graphs can emit forty
// video nodes at hero prices, and the first anyone hears of it is the invoice.

const templates = loadTemplates()

describe('the shipped templates', () => {
  test('all four load and are valid graphs', () => {
    expect(templates.map((t) => t.id).sort()).toEqual([
      'before-after',
      'headline-ad',
      'hero-and-clips',
      'three-scenes',
    ])
    for (const template of templates) {
      expect(flowSchema.safeParse(template.flow).success).toBe(true)
    }
  })

  test('every slot a template declares appears in it', () => {
    // A declared slot nothing references is a prompt the LLM writes and nobody
    // reads; a referenced slot nothing declares never gets filled.
    for (const template of templates) {
      const body = JSON.stringify(template.flow)
      for (const slot of template.slots) expect(body).toContain(`{{${slot}}}`)

      const referenced = [...body.matchAll(/\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g)].map((m) => m[1])
      for (const slot of referenced) expect(template.slots).toContain(slot)
    }
  })
})

describe('parsing a response', () => {
  test('fills the chosen template and returns a valid graph', () => {
    const flow = buildFlowFromBrief(
      {
        templateId: 'before-after',
        prompts: { before: 'dull skin in flat light', after: 'the same skin, lit warm' },
      },
      templates,
    )
    expect(flow.nodes.map((n) => 'prompt' in n && n.prompt)).toContain('dull skin in flat light')
    expect(flowSchema.safeParse(flow).success).toBe(true)
  })

  test('fills headline and CTA, not just scene prompts', () => {
    // Otherwise the ad ships with `{{headline}}` burned into it.
    const flow = buildFlowFromBrief(
      {
        templateId: 'headline-ad',
        prompts: { scene: 'the bottle on marble', headline: 'Bottled sunlight', cta: 'Shop now' },
      },
      templates,
    )
    const exported = flow.nodes.find((n) => n.type === 'export')!
    expect(exported.type === 'export' && exported.overlay).toEqual({
      headline: 'Bottled sunlight',
      cta: 'Shop now',
    })
  })

  test('rejects an unknown templateId and names the valid ones', () => {
    expect(() =>
      buildFlowFromBrief({ templateId: 'twelve-shot-epic', prompts: {} }, templates),
    ).toThrow(BriefError)
    expect(() =>
      buildFlowFromBrief({ templateId: 'twelve-shot-epic', prompts: {} }, templates),
    ).toThrow(/three-scenes/)
  })

  test('fails loudly on a missing prompt rather than rendering an empty one', () => {
    // An empty prompt renders a blank shot and is billed exactly like a real
    // one. Silence here is the expensive failure.
    expect(() =>
      buildFlowFromBrief({ templateId: 'before-after', prompts: { before: 'x' } }, templates),
    ).toThrow(/after/)
  })

  test('treats a whitespace-only prompt as missing', () => {
    expect(() =>
      buildFlowFromBrief(
        { templateId: 'before-after', prompts: { before: 'x', after: '   ' } },
        templates,
      ),
    ).toThrow(/after/)
  })

  test('rejects a response that is not a brief result at all', () => {
    for (const junk of [null, 'sure, here you go', { templateId: 5 }, { prompts: {} }]) {
      expect(() => buildFlowFromBrief(junk, templates)).toThrow(BriefError)
    }
  })

  test('ignores prompts for slots the template does not have', () => {
    const flow = buildFlowFromBrief(
      { templateId: 'before-after', prompts: { before: 'a', after: 'b', extra: 'ignored' } },
      templates,
    )
    expect(JSON.stringify(flow)).not.toContain('ignored')
  })

  test('refuses a template directory containing an invalid template', () => {
    const broken: FlowTemplate[] = []
    expect(() => buildFlowFromBrief({ templateId: 'x', prompts: {} }, broken)).toThrow(BriefError)
  })
})
