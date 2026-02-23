import React, { useEffect, useMemo, useRef, useState } from 'react'

function wsBaseFromApi() {
  const api = import.meta.env.VITE_API_BASE || 'http://localhost:8000'
  return api.replace(/^http/, 'ws')
}

export default function VideoCall({ roomId, token }) {
  const localVideoRef = useRef(null)
  const remoteVideoRef = useRef(null)

  const [status, setStatus] = useState('Инициализация…')
  const [micOn, setMicOn] = useState(true)
  const [camOn, setCamOn] = useState(true)

  const wsUrl = useMemo(
    () => `${wsBaseFromApi()}/ws/signaling/${encodeURIComponent(roomId)}?token=${encodeURIComponent(token)}`,
    [roomId, token]
  )

  const pcRef = useRef(null)
  const wsRef = useRef(null)
  const localStreamRef = useRef(null)

  async function ensureLocalMedia() {
    if (localStreamRef.current) return localStreamRef.current
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
    localStreamRef.current = stream
    if (localVideoRef.current) localVideoRef.current.srcObject = stream
    return stream
  }

  function createPeerConnection() {
    if (pcRef.current) return pcRef.current

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    })

    pc.onicecandidate = (ev) => {
      if (ev.candidate && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'ice', candidate: ev.candidate }))
      }
    }

    pc.ontrack = (ev) => {
      const [remoteStream] = ev.streams
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = remoteStream
    }

    pc.onconnectionstatechange = () => {
      const st = pc.connectionState
      if (st === 'connected') setStatus('Соединение установлено')
      else if (st === 'connecting') setStatus('Подключаемся…')
      else if (st === 'disconnected') setStatus('Отключено (проверь сеть)')
      else if (st === 'failed') setStatus('Ошибка соединения')
      else if (st === 'closed') setStatus('Закрыто')
    }

    pcRef.current = pc
    return pc
  }

  async function start() {
    setStatus('Запрашиваем камеру/микрофон…')
    const stream = await ensureLocalMedia()

    const pc = createPeerConnection()

    // Add local tracks
    for (const track of stream.getTracks()) {
      pc.addTrack(track, stream)
    }

    setStatus('Ожидаем второго участника…')

    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'ready' }))
    }

    ws.onmessage = async (event) => {
      let msg
      try { msg = JSON.parse(event.data) } catch { return }

      if (msg.type === 'peer-joined') {
        // Сервер шлёт peer-joined тем, кто был в комнате раньше.
        // Значит, именно «первый» участник делает offer.
        setStatus('Второй участник в комнате — подключаемся…')
        try {
          await pc.setLocalDescription(await pc.createOffer())
          ws.send(JSON.stringify({ type: 'sdp', sdp: pc.localDescription }))
        } catch {
          // ignore
        }
        return
      }

      if (msg.type === 'sdp' && msg.sdp) {
        const desc = msg.sdp

        // MVP: минимальная защита от гонок
        if (desc.type === 'offer' && pc.signalingState !== 'stable') {
          return
        }

        await pc.setRemoteDescription(desc)

        if (desc.type === 'offer') {
          await pc.setLocalDescription(await pc.createAnswer())
          ws.send(JSON.stringify({ type: 'sdp', sdp: pc.localDescription }))
        }
        return
      }

      if (msg.type === 'ice' && msg.candidate) {
        try {
          await pc.addIceCandidate(msg.candidate)
        } catch {
          // MVP: игнорируем редкие гонки при установке SDP
        }
      }
    }

    ws.onclose = () => setStatus('Сигналинг закрыт')
    ws.onerror = () => setStatus('Ошибка сигналинга')
  }

  useEffect(() => {
    let stopped = false

    start().catch(() => {
      if (!stopped) setStatus('Не удалось запустить созвон (разреши доступ к камере/микрофону)')
    })

    return () => {
      stopped = true
      try { wsRef.current?.close() } catch {}
      try { pcRef.current?.close() } catch {}
      pcRef.current = null

      const stream = localStreamRef.current
      if (stream) {
        stream.getTracks().forEach((t) => t.stop())
        localStreamRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsUrl])

  function toggleMic() {
    const s = localStreamRef.current
    if (!s) return
    const tracks = s.getAudioTracks()
    tracks.forEach((t) => { t.enabled = !t.enabled })
    setMicOn(tracks.some((t) => t.enabled))
  }

  function toggleCam() {
    const s = localStreamRef.current
    if (!s) return
    const tracks = s.getVideoTracks()
    tracks.forEach((t) => { t.enabled = !t.enabled })
    setCamOn(tracks.some((t) => t.enabled))
  }

  return (
    <div>
      <div className="videoGrid">
        <div className="videoBox">
          <video ref={localVideoRef} autoPlay playsInline muted />
          <div className="videoLabel">Вы</div>
        </div>
        <div className="videoBox">
          <video ref={remoteVideoRef} autoPlay playsInline />
          <div className="videoLabel">Собеседник</div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 10 }}>
        <button className="btn" onClick={toggleMic}>{micOn ? 'Микрофон: вкл' : 'Микрофон: выкл'}</button>
        <button className="btn" onClick={toggleCam}>{camOn ? 'Камера: вкл' : 'Камера: выкл'}</button>
        <div className="small" style={{ alignSelf: 'center' }}>{status}</div>
      </div>
    </div>
  )
}
