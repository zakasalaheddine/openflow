'use client'

import { useEffect, useRef, useState } from 'react'
import { fetchChat, sendChat, clearChat } from './state'

type Line = { role: 'user' | 'assistant'; text: string }

/** Model messages carry tool calls too; the panel only renders what a person wrote or read. */
function toLines(messages: { role: string; content: unknown }[]): Line[] {
  return messages.flatMap((message) => {
    if (message.role !== 'user' && message.role !== 'assistant') return []
    const text =
      typeof message.content === 'string'
        ? message.content
        : (message.content as { type: string; text?: string }[])
            .filter((part) => part.type === 'text')
            .map((part) => part.text ?? '')
            .join('')
    return text.trim() ? [{ role: message.role, text }] : []
  })
}

export function ChatPanel() {
  const [lines, setLines] = useState<Line[]>([])
  const [enabled, setEnabled] = useState(true)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void fetchChat().then((state) => {
      setEnabled(state.enabled)
      setLines(toLines(state.messages))
    })
  }, [])

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [lines])

  async function send() {
    const message = draft.trim()
    if (!message || busy) return

    setDraft('')
    setError(null)
    setBusy(true)
    setLines((current) => [...current, { role: 'user', text: message }, { role: 'assistant', text: '' }])

    try {
      await sendChat(message, (chunk) =>
        setLines((current) => {
          const next = [...current]
          const last = next.at(-1)!
          next[next.length - 1] = { ...last, text: last.text + chunk }
          return next
        }),
      )
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Chat failed')
      setLines((current) => current.slice(0, -1))
    } finally {
      setBusy(false)
    }
  }

  return (
    <aside className="chat" data-testid="chat">
      <header className="chat__head">
        <span className="slate">Direction</span>
        <button
          className="chip"
          data-testid="chat-clear"
          onClick={() => void clearChat().then(() => setLines([]))}
        >
          Start over
        </button>
      </header>

      <div className="chat__log" data-testid="chat-log">
        {lines.length === 0 && (
          <p className="chat__empty">
            Say what the ad is for. Nodes appear on the canvas as they are written — nothing renders
            until you press Run.
          </p>
        )}
        {lines.map((line, index) => (
          <p key={index} className={`chat__line chat__line--${line.role}`}>
            {line.text || (busy && index === lines.length - 1 ? 'Thinking…' : '')}
          </p>
        ))}
        <div ref={endRef} />
      </div>

      {error && <p className="chat__error">{error}</p>}
      {!enabled && (
        <p className="chat__error">
          Set OPENROUTER_API_KEY in .env to use chat, or LLM_MODE=replay for recorded answers.
        </p>
      )}

      <form
        className="chat__compose"
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
      >
        <textarea
          value={draft}
          rows={3}
          disabled={!enabled || busy}
          data-testid="chat-input"
          placeholder="add a hero shot of the serum on marble"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends, shift+Enter is a newline — the shape of every chat
            // box, and getting it wrong is the first thing anyone notices.
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void send()
            }
          }}
        />
        <button className="run" type="submit" disabled={!enabled || busy} data-testid="chat-send">
          {busy ? 'Writing…' : 'Send'}
        </button>
      </form>
    </aside>
  )
}

export { toLines }
