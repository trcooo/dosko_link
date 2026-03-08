import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'

function wsBaseFromApi() {
  const env = (import.meta.env.VITE_API_BASE || '').trim()
  const isLocal = (typeof window !== 'undefined') && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
  const api = isLocal ? (env || 'http://localhost:8000') : window.location.origin
  return api.replace(/^http/, 'ws')
}

async function fileToResizedDataUrl(file, { maxW = 900, maxH = 700, quality = 0.86 } = {}) {
  if (!file) return null

  const dataUrl = await new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result || ''))
    r.onerror = () => reject(new Error('Не удалось прочитать файл'))
    r.readAsDataURL(file)
  })

  const img = await new Promise((resolve, reject) => {
    const im = new Image()
    im.onload = () => resolve(im)
    im.onerror = () => reject(new Error('Не удалось загрузить изображение'))
    im.src = dataUrl
  })

  const w0 = img.naturalWidth || img.width || 1
  const h0 = img.naturalHeight || img.height || 1

  // Scale down
  let w = w0
  let h = h0
  const scale = Math.min(1, maxW / w, maxH / h)
  w = Math.max(1, Math.floor(w * scale))
  h = Math.max(1, Math.floor(h * scale))

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0, w, h)

  // Prefer JPEG for smaller payload unless source is PNG with alpha
  const hasAlpha = (file.type || '').toLowerCase().includes('png')
  const out = hasAlpha ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', quality)

  return {
    dataUrl: out,
    aspect: w / h
  }
}

const Whiteboard = forwardRef(function Whiteboard({ roomId, token }, ref) {
  const wsUrl = useMemo(
    () => `${wsBaseFromApi()}/ws/whiteboard/${encodeURIComponent(roomId)}?token=${encodeURIComponent(token)}`,
    [roomId, token]
  )

  const canvasRef = useRef(null)
  const wrapRef = useRef(null)
  const wsRef = useRef(null)
  const fileRef = useRef(null)

  const [tool, setTool] = useState('pen') // pen | eraser | text | image
  const [width, setWidth] = useState(3)

  const [pendingImg, setPendingImg] = useState(null) // {dataUrl, aspect}
  const [pendingMode, setPendingMode] = useState('place') // place | background
  const [boardHeight, setBoardHeight] = useState(520)

  const historyRef = useRef([]) // history for redraw/export
  const drawing = useRef(false)
  const last = useRef({ x: 0, y: 0 })

  const imgCacheRef = useRef(new Map()) // dataUrl -> HTMLImageElement

  function getBoardHeight(rectWidth = wrapRef.current?.getBoundingClientRect().width || 0) {
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1280
    if (vw <= 480) return Math.max(300, Math.min(360, Math.round(rectWidth * 0.88) || 320))
    if (vw <= 720) return Math.max(320, Math.min(400, Math.round(rectWidth * 0.82) || 340))
    if (vw <= 980) return 420
    return 520
  }

  function resizeCanvas() {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return

    const rect = wrap.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1

    canvas.width = Math.floor(rect.width * dpr)
    const nextHeight = getBoardHeight(rect.width)
    setBoardHeight(prev => prev === nextHeight ? prev : nextHeight)

    canvas.height = Math.floor(nextHeight * dpr)
    canvas.style.width = `${rect.width}px`
    canvas.style.height = `${nextHeight}px`

    const ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    // Redraw from history
    ctx.clearRect(0, 0, rect.width, nextHeight)
    for (const seg of historyRef.current) {
      if (seg.type === 'clear') {
        ctx.clearRect(0, 0, rect.width, nextHeight)
        continue
      }
      if (seg.type === 'draw') drawLine(seg)
      if (seg.type === 'text') drawText(seg)
      if (seg.type === 'image') drawImageSeg(seg)
    }
  }

  function getCtx() {
    const canvas = canvasRef.current
    if (!canvas) return null
    return canvas.getContext('2d')
  }

  function pointerToNorm(e) {
    const wrap = wrapRef.current
    if (!wrap) return { x: 0, y: 0, rect: { width: 1 } }
    const rect = wrap.getBoundingClientRect()
    const x = (e.clientX - rect.left) / rect.width
    const height = boardHeight || getBoardHeight(rect.width)
    const y = (e.clientY - rect.top) / height
    return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)), rect }
  }

  function drawLine({ x0, y0, x1, y1, color, w }) {
    const ctx = getCtx()
    const wrap = wrapRef.current
    if (!ctx || !wrap) return

    const rect = wrap.getBoundingClientRect()
    const px0 = x0 * rect.width
    const height = boardHeight || getBoardHeight(rect.width)
    const py0 = y0 * height
    const px1 = x1 * rect.width
    const py1 = y1 * height

    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = color
    ctx.lineWidth = w

    ctx.beginPath()
    ctx.moveTo(px0, py0)
    ctx.lineTo(px1, py1)
    ctx.stroke()
  }

  function drawText({ x, y, text, size = 18, color = '#111827' }) {
    const ctx = getCtx()
    const wrap = wrapRef.current
    if (!ctx || !wrap) return

    const rect = wrap.getBoundingClientRect()
    const px = x * rect.width
    const height = boardHeight || getBoardHeight(rect.width)
    const py = y * height

    ctx.fillStyle = color
    ctx.font = `${size}px system-ui, -apple-system, Segoe UI, Roboto, Arial`
    ctx.textBaseline = 'top'
    ctx.fillText(String(text || '').slice(0, 240), px, py)
  }

  function _getImg(dataUrl) {
    const cache = imgCacheRef.current
    if (cache.has(dataUrl)) return cache.get(dataUrl)
    const im = new Image()
    im.src = dataUrl
    cache.set(dataUrl, im)
    return im
  }

  function drawImageSeg({ x, y, w, h, dataUrl }) {
    const ctx = getCtx()
    const wrap = wrapRef.current
    if (!ctx || !wrap) return
    const rect = wrap.getBoundingClientRect()

    const px = x * rect.width
    const height = boardHeight || getBoardHeight(rect.width)
    const py = y * height
    const pw = w * rect.width
    const ph = h * height

    const im = _getImg(dataUrl)
    if (im.complete && im.naturalWidth) {
      ctx.drawImage(im, px, py, pw, ph)
      return
    }
    im.onload = () => {
      try { ctx.drawImage(im, px, py, pw, ph) } catch {}
    }
  }

  function clearBoard(resetHistory = true) {
    const ctx = getCtx()
    const wrap = wrapRef.current
    if (!ctx || !wrap) return
    const rect = wrap.getBoundingClientRect()
    const height = boardHeight || getBoardHeight(rect.width)
    ctx.clearRect(0, 0, rect.width, height)
    if (resetHistory) historyRef.current = []
  }

  function exportPngDataUrl() {
    const canvas = canvasRef.current
    if (!canvas) return null
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

  async function pickImage(mode) {
    setPendingMode(mode)
    try {
      if (fileRef.current) fileRef.current.value = ''
      fileRef.current?.click()
    } catch {}
  }

  async function onImageSelected(e) {
    const file = e.target.files && e.target.files[0]
    if (!file) return
    try {
      const resized = await fileToResizedDataUrl(file, { maxW: 1100, maxH: 900, quality: 0.86 })
      if (!resized) return
      setPendingImg(resized)
      setTool('image')
    } catch (err) {
      alert(err?.message || 'Не удалось обработать изображение')
    }
  }

  function onDown(e) {
    if (e.button !== undefined && e.button !== 0) return
    const p = pointerToNorm(e)

    if (tool === 'text') {
      const t = prompt('Текст на доске:')
      if (t && t.trim()) {
        const msg = { type: 'text', x: p.x, y: p.y, text: t.trim(), size: 18, color: '#111827' }
        drawText(msg)
        historyRef.current.push(msg)
        send(msg)
      }
      drawing.current = false
      return
    }

    if (tool === 'image' && pendingImg?.dataUrl) {
      const rect = p.rect || wrapRef.current?.getBoundingClientRect() || { width: 800 }
      if (pendingMode === 'background') {
        const msg = { type: 'image', x: 0, y: 0, w: 1, h: 1, dataUrl: pendingImg.dataUrl }
        drawImageSeg(msg)
        historyRef.current.push(msg)
        send(msg)
      } else {
        let wNorm = 0.42
        const height = boardHeight || getBoardHeight(rect.width)
        let hNorm = (wNorm * rect.width) / (pendingImg.aspect || 1) / height
        // Clamp if too tall
        if (hNorm > 0.8) {
          const scale = 0.8 / hNorm
          wNorm *= scale
          hNorm *= scale
        }
        let x = p.x - wNorm / 2
        let y = p.y - hNorm / 2
        x = Math.max(0, Math.min(1 - wNorm, x))
        y = Math.max(0, Math.min(1 - hNorm, y))

        const msg = { type: 'image', x, y, w: wNorm, h: hNorm, dataUrl: pendingImg.dataUrl }
        drawImageSeg(msg)
        historyRef.current.push(msg)
        send(msg)
      }
      setPendingImg(null)
      setTool('pen')
      drawing.current = false
      return
    }

    drawing.current = true
    last.current = { x: p.x, y: p.y }
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

    last.current = { x: p.x, y: p.y }
  }

  function onUp() {
    drawing.current = false
  }

  useEffect(() => {
    setTimeout(resizeCanvas, 0)
    const onResize = () => resizeCanvas()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [boardHeight])

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
      if (msg.type === 'text') {
        drawText(msg)
        historyRef.current.push(msg)
      }
      if (msg.type === 'image') {
        drawImageSeg(msg)
        historyRef.current.push(msg)
      }
      if (msg.type === 'clear') {
        clearBoard(false)
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
        <button className={`btn ${tool === 'pen' ? 'btnPrimary' : ''}`} onClick={() => { setTool('pen'); setPendingImg(null) }}>Перо</button>
        <button className={`btn ${tool === 'eraser' ? 'btnPrimary' : ''}`} onClick={() => { setTool('eraser'); setPendingImg(null) }}>Ластик</button>
        <button className={`btn ${tool === 'text' ? 'btnPrimary' : ''}`} onClick={() => { setTool('text'); setPendingImg(null) }}>Текст</button>

        <button className={`btn ${tool === 'image' ? 'btnPrimary' : ''}`} onClick={() => pickImage('place')}>Фото</button>
        <button className="btn btnGhost" onClick={() => pickImage('background')}>Фон</button>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 8 }}>
          <span className="small">Толщина</span>
          <input type="range" min="1" max="10" value={width} onChange={(e) => setWidth(Number(e.target.value))} />
        </div>

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          {pendingImg ? <span className="small">Изображение выбрано — кликни по доске</span> : <span className="small"> </span>}
          <button className="btn btnGhost" onClick={() => { clearBoard(); send({ type: 'clear' }) }}>Очистить</button>
        </div>

        <input ref={fileRef} style={{ display: 'none' }} type="file" accept="image/*" onChange={onImageSelected} />
      </div>

      <div ref={wrapRef} className="canvasArea" style={{ '--board-height': `${boardHeight}px` }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp}>
        <canvas ref={canvasRef} className="canvas responsiveCanvas" />
      </div>
    </div>
  )
})

export default Whiteboard
