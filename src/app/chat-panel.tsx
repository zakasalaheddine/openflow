'use client'

import { useEffect, useRef, useState } from 'react'
import { fetchChat, sendChat, clearChat } from './state'

type Line =
  | { role: 'user' | 'assistant'; text: string }
  /** What the agent did to the graph on that turn, not what it said about it. */
  | { role: 'activity'; tools: string[] }

/** `add_node` reads like a function; "added a node" reads like a thing that happened. */
const ACTIVITY: Record<string, string> = {
  add_node: 'added a node',
  update_node: 'changed a node',
  delete_node: 'deleted a node',
  wire: 'wired two nodes',
  unwire: 'removed a wire',
  apply_template: 'applied a template',
  list_graph: 'read the graph',
  list_sources: 'read the assets',
}

/**
 * The thread as a person reads it: what was said, and what was done.
 *
 * Tool calls used to be dropped outright, which meant the agent's whole effect
 * on the canvas was invisible here — it would answer "added the hero shot" and
 * the only evidence was a card appearing somewhere off screen. Worse when it
 * said nothing: a turn that was pure tool calls rendered as an empty bubble.
 *
 * Summarised rather than logged. Arguments are not shown and never should be —
 * the graph is on screen, and a panel that reprints it is a second source of
 * truth to keep in sync.
 */
function toLines(messages: { role: string; content: unknown }[]): Line[] {
  return messages.flatMap((message): Line[] => {
    if (message.role !== 'user' && message.role !== 'assistant') return []
    if (typeof message.content === 'string') {
      return message.content.trim() ? [{ role: message.role, text: message.content }] : []
    }

    const parts = message.content as { type: string; text?: string; toolName?: string }[]
    const text = parts
      .filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .join('')
    const tools = parts
      .filter((part) => part.type === 'tool-call' && part.toolName)
      .map((part) => ACTIVITY[part.toolName!] ?? part.toolName!)

    return [
      ...(text.trim() ? [{ role: message.role, text } as Line] : []),
      ...(tools.length ? [{ role: 'activity', tools } as Line] : []),
    ]
  })
}

/** `flow` is the workspace slug: each one keeps its own thread, so switching does not carry a conversation across. */
export function ChatPanel({ flow }: { flow: string }) {
  const [lines, setLines] = useState<Line[]>([])
  const [enabled, setEnabled] = useState(true)
  const [demo, setDemo] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void fetchChat(flow).then((state) => {
      setEnabled(state.enabled)
      setDemo(state.demo)
      setLines(toLines(state.messages))
    })
  }, [flow])

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
      await sendChat(flow, message, (chunk) =>
        setLines((current) => {
          const next = [...current]
          const last = next.at(-1)
          // The placeholder this appends to is the empty assistant line pushed
          // just above; an activity line can never be last while a reply is
          // streaming, and narrowing here says so rather than assuming it.
          if (!last || last.role === 'activity') return current
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
          onClick={() => void clearChat(flow).then(() => setLines([]))}
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
        {lines.map((line, index) =>
          line.role === 'activity' ? (
            // What it did, between what it said. Deliberately quiet: it is a
            // receipt, and the canvas is the real answer.
            <p key={index} className="chat__activity" data-testid="chat-activity">
              {line.tools.join(' · ')}
            </p>
          ) : (
            <p key={index} className={`chat__line chat__line--${line.role}`}>
              {line.text}
              {/* A caret on the streaming line rather than the word "Thinking…"
                  swapped in and out — the text arrives token by token, so a
                  placeholder that vanishes on the first one flickers. */}
              {busy && index === lines.length - 1 && line.role === 'assistant' && (
                <span className="chat__caret" aria-label="Writing" />
              )}
            </p>
          ),
        )}
        <div ref={endRef} />
      </div>

      {error && <p className="chat__error">{error}</p>}
      {!enabled && (
        <p className="chat__error">
          {demo
            ? 'This is a read-only demo.'
            : 'Set OPENROUTER_API_KEY in .env to use chat, or LLM_MODE=replay for recorded answers.'}
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
