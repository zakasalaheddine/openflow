import { Button } from '@/ui/button'

/**
 * The proof that the two styling systems share one palette.
 *
 * Approach C puts shadcn primitives next to hand-written canvas CSS, and the
 * only thing holding them together is the variable bridge in `globals.css`. A
 * page is the cheapest way to see that bridge fail: if a shadcn Button renders
 * in stock neutral grey, or a `.chip` and a `<Button variant="outline">` sit at
 * different radii, it is visible here before it is visible on the canvas.
 *
 * Not linked from anywhere. Visit /design-probe.
 *
 * ponytail: delete this route when the last phase lands, or keep it — it costs
 * one static page and it is the only place the whole palette is on screen at
 * once.
 */
export default function DesignProbe() {
  return (
    <main
      style={{
        padding: 'var(--s-8)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--s-7)',
        maxWidth: '72ch',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
        <span className="slate">Design probe</span>
        <h1 style={{ margin: 0, fontSize: 'var(--fs-6)', fontWeight: 600, letterSpacing: '-0.01em' }}>
          One palette, two systems
        </h1>
        <p className="hint" style={{ maxWidth: '62ch' }}>
          Everything on the left of each row is hand-written CSS from{' '}
          <code className="figure">globals.css</code>. Everything on the right is a shadcn primitive
          reading the same variables. They have to agree.
        </p>
      </div>

      <Row label="Surfaces">
        {(
          [
            ['ground', 'var(--ground)'],
            ['panel', 'var(--panel)'],
            ['raised', 'var(--raised)'],
            ['overlay', 'var(--overlay)'],
            ['line', 'var(--line)'],
            ['line-bright', 'var(--line-bright)'],
          ] as const
        ).map(([name, value]) => (
          <Swatch key={name} name={name} value={value} />
        ))}
      </Row>

      <Row label="Meaning">
        <Swatch name="ink" value="var(--ink)" />
        <Swatch name="slate" value="var(--slate)" />
        <Swatch name="safelight · billed" value="var(--safelight)" />
        <Swatch name="beam · focus" value="var(--beam)" />
        <Swatch name="fixed · done" value="var(--fixed)" />
        <Swatch name="fault" value="var(--fault)" />
      </Row>

      <Row label="Elevation">
        {(['--e-1', '--e-2', '--e-3'] as const).map((token) => (
          <div
            key={token}
            className="figure"
            style={{
              width: 96,
              height: 56,
              display: 'grid',
              placeItems: 'center',
              borderRadius: 'var(--r-md)',
              background: 'var(--panel)',
              border: '1px solid var(--line)',
              boxShadow: `var(${token})`,
              fontSize: 'var(--fs-2)',
              color: 'var(--slate)',
            }}
          >
            {token}
          </div>
        ))}
      </Row>

      <Row label="Radius">
        {(['--r-sm', '--r-md', '--r-lg'] as const).map((token) => (
          <div
            key={token}
            className="figure"
            style={{
              width: 96,
              height: 56,
              display: 'grid',
              placeItems: 'center',
              borderRadius: `var(${token})`,
              background: 'var(--raised)',
              border: '1px solid var(--line-bright)',
              fontSize: 'var(--fs-2)',
              color: 'var(--slate)',
            }}
          >
            {token}
          </div>
        ))}
      </Row>

      <Row label="House controls">
        <button className="chip">chip</button>
        <button className="chip" aria-pressed="true">
          pressed
        </button>
        <button className="chip chip--danger">danger</button>
        <button className="run">Run all</button>
      </Row>

      <Row label="shadcn Button">
        <Button>Default</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="outline">Outline</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="destructive">Destructive</Button>
        <Button size="sm" variant="outline">
          Small
        </Button>
        <Button disabled>Disabled</Button>
      </Row>

      <Row label="Type scale">
        {(
          [
            ['--fs-6', 'The one title'],
            ['--fs-5', 'Panel heading'],
            ['--fs-4', 'Body text, the base'],
            ['--fs-3', 'Controls and fields'],
            ['--fs-2', 'Dense labels and figures'],
            ['--fs-1', 'Slates and meta'],
          ] as const
        ).map(([token, sample]) => (
          <div key={token} style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--s-4)', width: '100%' }}>
            <span className="figure" style={{ fontSize: 'var(--fs-1)', color: 'var(--slate-dim)', width: '5ch' }}>
              {token.replace('--fs-', '')}
            </span>
            <span style={{ fontSize: `var(${token})` }}>{sample}</span>
          </div>
        ))}
      </Row>
    </main>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
      <span className="slate">{label}</span>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--s-4)' }}>
        {children}
      </div>
    </section>
  )
}

function Swatch({ name, value }: { name: string; value: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
      <div
        style={{
          width: 96,
          height: 56,
          borderRadius: 'var(--r-sm)',
          background: value,
          border: '1px solid var(--line)',
        }}
      />
      <span className="figure" style={{ fontSize: 'var(--fs-1)', color: 'var(--slate)' }}>
        {name}
      </span>
    </div>
  )
}
