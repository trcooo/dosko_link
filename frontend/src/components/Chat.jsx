import React, { useEffect, useMemo, useRef, useState } from 'react'

function wsBaseFromApi() {
  const env = (import.meta.env.VITE_API_BASE || '').trim()
  const isLocal = (typeof window !== 'undefined') && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
  const api = isLocal ? (env || 'http://localhost:8000') : window.location.origin
  return api.replace(/^http/, 'ws')
}

export default function Chat({ roomId, token, me }) {
  const wsUrl = useMemo(
    () => `${wsBaseFromApi()}/ws/chat/${encodeURIComponent(roomId)}?token=${encodeURIComponent(token)}`,
    [roomId, token]
  )

  const [messages, setMessages] = useState([])
  const [text, setText] = useState('')
  const wsRef = useRef(null)

  useEffect(() => {
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onmessage = (ev) => {
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      if (msg.type === 'message') {
        setMessages((prev) => [...prev, msg])
      }
    }

    return () => {
      try { ws.close() } catch {}
    }
  }, [wsUrl])

  function send() {
    const value = text.trim()
    if (!value) return

    const msg = {
      type: 'message',
      text: value,
      at: new Date().toISOString(),
      fromUserId: me?.id,
      fromEmail: me?.email
    }

    // optimistic UI
    setMessages((prev) => [...prev, { ...msg, _local: true }])
    setText('')

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg))
    }
  }

  return (
    <div>
      <div className="chatList">
        {messages.length === 0 ? (
          <div className="small">Сообщений пока нет.</div>
        ) : (
          messages.map((m, idx) => {
            const mine = m.fromUserId && me?.id && m.fromUserId === me.id
            return (
              <div key={idx} className={`bubble ${mine ? 'bubbleMe' : ''}`}>
                <div className="small" style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                  <span>{m.fromEmail || `user#${m.fromUserId || '?'}`}</span>
                  <span>{m.at ? new Date(m.at).toLocaleTimeString() : ''}</span>
                </div>
                <div style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>{m.text}</div>
              </div>
            )
          })
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Написать…" onKeyDown={(e) => { if (e.key === 'Enter') send() }} />
        <button className="btn btnPrimary" onClick={send}>Отправить</button>
      </div>
    </div>
  )
}
