import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'

function wsBaseFromApi() {
  const api = import.meta.env.VITE_API_BASE || 'http://localhost:8000'
  return api.replace(/^http/, 'ws')
}

const Whiteboard = forwardRef(function Whiteboard({ roomId, token }, ref) {
  const wsUrl = useMemo(
    () => `${wsBaseFromApi()}/ws/whiteboard/${encodeURIComponent(roomId)}?token=${encodeURIComponent(token)}`,
    [roomId, token]
  )

  const canvasRef = useRef(null)
  const wrapRef = useRef(null)
  const wsRef = useRef(null)

  const [tool, setTool] = useState('pen') // pen | eraser
  const [width, setWidth] = useState(3)

  const historyRef = useRef([]) // draw segments history for redraw/export

  const drawing = useRef(false)
  const last = useRef({ x: 0, y: 0 })

  function resizeCanvas() {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return

    const rect = wrap.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1

    canvas.width = Math.floor(rect.width * dpr)
    canvas.height = Math.floor(520 * dpr)
    canvas.style.width = `${rect.width}px`
    canvas.style.height = '520px'

    const ctx = canvas.getContext('2d')
    // Рисуем в CSS-пикселях, а dpr учитываем через transform
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    // Redraw from history
    ctx.clearRect(0, 0, rect.width, 520)
    for (const seg of historyRef.current) {
      if (seg.type === 'draw') drawLine(seg)
      if (seg.type === 'clear') clearBoard(false)
    }
  }

  function getCtx() {
    const canvas = canvasRef.current
    if (!canvas) return null
    return canvas.getContext('2d')
  }

  function drawLine({ x0, y0, x1, y1, color, w }) {
    const ctx = getCtx()
    const wrap = wrapRef.current
    if (!ctx || !wrap) return

    const rect = wrap.getBoundingClientRect()
    const px0 = x0 * rect.width
    const py0 = y0 * 520
    const px1 = x1 * rect.width
    const py1 = y1 * 520

    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = color
    ctx.lineWidth = w

    ctx.beginPath()
    ctx.moveTo(px0, py0)
    ctx.lineTo(px1, py1)
    ctx.stroke()
  }

  function clearBoard(resetHistory = true) {
    const ctx = getCtx()
    const wrap = wrapRef.current
    if (!ctx || !wrap) return
    const rect = wrap.getBoundingClientRect()
    ctx.clearRect(0, 0, rect.width, 520)
    if (resetHistory) historyRef.current = []
  }

  function exportPngDataUrl() {
    const canvas = canvasRef.current
    if (!canvas) return null
    // Ensure white background (instead of transparent)
    const tmp = document.createElement('canvas')
    tmp.width = canvas.width
    tmp.height = canvas.height
    const tctx = tmp.getContext('2d')
    tctx.fillStyle = '#ffffff'
    tctx.fillRect(0, 0, tmp.width, tmp.height)
    tctx.drawImage(canvas, 0, 0)
    return tmp.toDataURL('image/png')
  }

  useImperativeHandle(ref, () => ({
    exportPngDataUrl,
    clear: () => { clearBoard(); send({ type: 'clear' }) }
  }))

  function send(msg) {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg))
    }
  }

  function pointerToNorm(e) {
    const wrap = wrapRef.current
    if (!wrap) return { x: 0, y: 0 }
    const rect = wrap.getBoundingClientRect()
    const x = (e.clientX - rect.left) / rect.width
    const y = (e.clientY - rect.top) / 520
    return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) }
  }

  function onDown(e) {
    if (e.button !== undefined && e.button !== 0) return
    drawing.current = true
    const p = pointerToNorm(e)
    last.current = p
  }

  function onMove(e) {
    if (!drawing.current) return
    const p = pointerToNorm(e)

    const color = tool === 'eraser' ? '#ffffff' : '#111827'
    const w = tool === 'eraser' ? Math.max(10, width * 4) : width

    const seg = { type: 'draw', x0: last.current.x, y0: last.current.y, x1: p.x, y1: p.y, color, w }
    drawLine(seg)
    historyRef.current.push(seg)
    send(seg)

    last.current = p
  }

  function onUp() {
    drawing.current = false
  }

  useEffect(() => {
    // render after layout
    setTimeout(resizeCanvas, 0)
    const onResize = () => resizeCanvas()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onmessage = (ev) => {
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      if (msg.type === 'draw') {
        drawLine(msg)
        historyRef.current.push(msg)
      }
      if (msg.type === 'clear') {
        clearBoard()
        historyRef.current.push({ type: 'clear' })
      }
    }

    return () => {
      try { ws.close() } catch {}
    }
  }, [wsUrl])

  return (
    <div className="canvasWrap">
      <div className="canvasTools">
        <button className={`btn ${tool === 'pen' ? 'btnPrimary' : ''}`} onClick={() => setTool('pen')}>Перо</button>
        <button className={`btn ${tool === 'eraser' ? 'btnPrimary' : ''}`} onClick={() => setTool('eraser')}>Ластик</button>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 8 }}>
          <span className="small">Толщина</span>
          <input type="range" min="1" max="10" value={width} onChange={(e) => setWidth(Number(e.target.value))} />
          <span className="small">{width}</span>
        </div>

        <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => { clearBoard(); historyRef.current.push({ type: 'clear' }); send({ type: 'clear' }) }}>Очистить</button>
      </div>

      <div ref={wrapRef} style={{ width: '100%', height: 520 }}>
        <canvas
          ref={canvasRef}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onPointerLeave={onUp}
          style={{ touchAction: 'none', display: 'block' }}
        />
      </div>
    </div>
  )
})

export default Whiteboard
