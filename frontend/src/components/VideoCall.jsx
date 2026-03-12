import React, { useEffect, useMemo, useRef, useState } from 'react'
import { apiFetch } from '../api'

function wsBaseFromApi() {
  const env = (import.meta.env.VITE_API_BASE || '').trim()
  const isLocal = (typeof window !== 'undefined') && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
  const api = env || (isLocal ? 'http://localhost:8000' : window.location.origin)
  return api.replace(/^http/, 'ws')
}

function mediaLabel(list, value, fallback) {
  const found = (list || []).find((x) => x.deviceId === value)
  return found?.label || fallback
}

export default function VideoCall({ roomId, token, observerMode = false }) {
  const localVideoRef = useRef(null)
  const remoteVideoRef = useRef(null)
  const pcRef = useRef(null)
  const wsRef = useRef(null)
  const localStreamRef = useRef(null)
  const audioContextRef = useRef(null)
  const analyserRef = useRef(null)
  const micMeterTimerRef = useRef(null)
  const statsTimerRef = useRef(null)
  const reconnectTimerRef = useRef(null)
  const mountedRef = useRef(false)
  const audioOnlyModeRef = useRef(false)
  const lastWeakReportAtRef = useRef(0)
  const reconnectLockedRef = useRef(false)
  const manualCloseRef = useRef(false)
  const observerModeRef = useRef(observerMode)
  const transceiversRef = useRef({ audio: null, video: null })

  const [status, setStatus] = useState(observerMode ? 'Режим наблюдения…' : 'Инициализация…')
  const [micOn, setMicOn] = useState(false)
  const [camOn, setCamOn] = useState(false)
  const [micLevel, setMicLevel] = useState(0)
  const [connectionQuality, setConnectionQuality] = useState('Ожидание')
  const [cameraDevices, setCameraDevices] = useState([])
  const [audioDevices, setAudioDevices] = useState([])
  const [selectedCameraId, setSelectedCameraId] = useState('')
  const [selectedAudioId, setSelectedAudioId] = useState('')
  const [permissionHint, setPermissionHint] = useState('Для лучшего качества включены echo cancellation и noise suppression.')
  const [weakNetwork, setWeakNetwork] = useState(false)
  const [audioOnlyMode, setAudioOnlyMode] = useState(false)
  const [reconnectCount, setReconnectCount] = useState(0)
  const [retryNonce, setRetryNonce] = useState(0)

  const wsUrl = useMemo(
    () => `${wsBaseFromApi()}/ws/signaling/${encodeURIComponent(roomId)}?token=${encodeURIComponent(token)}`,
    [roomId, token]
  )

  useEffect(() => {
    audioOnlyModeRef.current = audioOnlyMode
  }, [audioOnlyMode])

  useEffect(() => {
    observerModeRef.current = observerMode
  }, [observerMode])

  async function reportQualityEvent(eventType, note = '') {
    if (!token) return
    try {
      await apiFetch(`/api/rooms/${encodeURIComponent(roomId)}/quality-event`, {
        method: 'POST',
        token,
        body: { event_type: eventType, note },
      })
    } catch {
      // ignore diagnostics errors
    }
  }

  async function loadDevices() {
    try {
      const list = await navigator.mediaDevices.enumerateDevices()
      const cams = list.filter((d) => d.kind === 'videoinput')
      const mics = list.filter((d) => d.kind === 'audioinput')
      setCameraDevices(cams)
      setAudioDevices(mics)
      if (!selectedCameraId && cams[0]?.deviceId) setSelectedCameraId(cams[0].deviceId)
      if (!selectedAudioId && mics[0]?.deviceId) setSelectedAudioId(mics[0].deviceId)
    } catch {
      // ignore
    }
  }

  function stopMeter() {
    if (micMeterTimerRef.current) {
      cancelAnimationFrame(micMeterTimerRef.current)
      micMeterTimerRef.current = null
    }
    try { audioContextRef.current?.close?.() } catch {}
    audioContextRef.current = null
    analyserRef.current = null
    setMicLevel(0)
  }

  function stopStatsMonitor() {
    if (statsTimerRef.current) {
      clearInterval(statsTimerRef.current)
      statsTimerRef.current = null
    }
  }

  function startMeter(stream) {
    stopMeter()
    const track = stream?.getAudioTracks?.()[0]
    if (!track) return
    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)()
      const source = audioCtx.createMediaStreamSource(new MediaStream([track]))
      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = 512
      source.connect(analyser)
      audioContextRef.current = audioCtx
      analyserRef.current = analyser

      const data = new Uint8Array(analyser.frequencyBinCount)
      const tick = () => {
        if (!analyserRef.current) return
        analyserRef.current.getByteFrequencyData(data)
        const avg = data.reduce((acc, n) => acc + n, 0) / Math.max(1, data.length)
        setMicLevel(Math.min(100, Math.round((avg / 255) * 140)))
        micMeterTimerRef.current = requestAnimationFrame(tick)
      }
      tick()
    } catch {
      setMicLevel(0)
    }
  }

  function ensureObserverTransceivers(pc) {
    if (!pc) return
    if (!transceiversRef.current.audio) {
      transceiversRef.current.audio = pc.addTransceiver('audio', { direction: 'recvonly' })
    }
    if (!transceiversRef.current.video) {
      transceiversRef.current.video = pc.addTransceiver('video', { direction: 'recvonly' })
    }
  }

  async function negotiatePeer(reason = 'manual-negotiation') {
    const pc = pcRef.current
    const ws = wsRef.current
    if (!pc || !ws || ws.readyState !== WebSocket.OPEN) return
    try {
      await pc.setLocalDescription(await pc.createOffer())
      ws.send(JSON.stringify({ type: 'sdp', sdp: pc.localDescription, reason }))
    } catch {
      // ignore renegotiation races
    }
  }

  async function ensureObserverMicrophone() {
    if (!(typeof window !== 'undefined' && window.isSecureContext)) {
      throw new Error('Созвон требует HTTPS (secure context)')
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Браузер не поддерживает доступ к микрофону')
    }

    const audioConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(selectedAudioId ? { deviceId: { exact: selectedAudioId } } : {}),
    }

    const stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: audioConstraints })
    const prev = localStreamRef.current
    if (prev) prev.getTracks().forEach((t) => t.stop())

    localStreamRef.current = stream
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null
    }

    setMicOn((stream.getAudioTracks() || []).some((t) => t.enabled))
    setCamOn(false)
    setAudioOnlyMode(true)
    setPermissionHint('Админ подключён как наблюдатель. Микрофон включается только вручную.')
    await loadDevices()
    startMeter(stream)
    return stream
  }

  async function ensureLocalMedia(forceAudioOnly = audioOnlyModeRef.current) {
    if (!(typeof window !== 'undefined' && window.isSecureContext)) {
      throw new Error('Созвон требует HTTPS (secure context)')
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Браузер не поддерживает доступ к камере/микрофону')
    }

    const audioConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(selectedAudioId ? { deviceId: { exact: selectedAudioId } } : {}),
    }
    const videoConstraints = {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 24, max: 30 },
      ...(selectedCameraId ? { deviceId: { exact: selectedCameraId } } : {}),
    }

    let stream = null
    let lastErr = null
    const variants = forceAudioOnly
      ? [
          { video: false, audio: audioConstraints, label: 'audio-only' },
          { video: videoConstraints, audio: audioConstraints, label: 'video+audio' },
        ]
      : [
          { video: videoConstraints, audio: audioConstraints, label: 'video+audio' },
          { video: videoConstraints, audio: false, label: 'video-only' },
          { video: false, audio: audioConstraints, label: 'audio-only' },
        ]

    for (const constraints of variants) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: constraints.video, audio: constraints.audio })
        if (constraints.label === 'video-only') {
          setPermissionHint('Камера доступна, но микрофон сейчас не дался браузеру.')
        } else if (constraints.label === 'audio-only') {
          setPermissionHint('Включён режим только аудио — так стабильнее при слабой сети.')
          setAudioOnlyMode(true)
        } else {
          setPermissionHint('Для лучшего качества включены echo cancellation и noise suppression.')
          if (!forceAudioOnly) setAudioOnlyMode(false)
        }
        break
      } catch (e) {
        lastErr = e
      }
    }

    if (!stream) {
      const name = lastErr?.name ? ` (${lastErr.name})` : ''
      throw new Error(`Не удалось получить доступ к камере/микрофону${name}`)
    }

    const prev = localStreamRef.current
    if (prev) prev.getTracks().forEach((t) => t.stop())

    localStreamRef.current = stream
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = stream
      try { localVideoRef.current.play?.() } catch {}
    }

    setMicOn((stream.getAudioTracks() || []).some((t) => t.enabled))
    setCamOn((stream.getVideoTracks() || []).some((t) => t.enabled))
    await loadDevices()
    startMeter(stream)
    return stream
  }

  function cleanupConnection({ keepStream = false } = {}) {
    manualCloseRef.current = true
    stopStatsMonitor()
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    try { wsRef.current?.close() } catch {}
    wsRef.current = null
    try { pcRef.current?.close() } catch {}
    pcRef.current = null
    transceiversRef.current = { audio: null, video: null }
    if (!keepStream) {
      const stream = localStreamRef.current
      if (stream) {
        stream.getTracks().forEach((t) => t.stop())
        localStreamRef.current = null
      }
      stopMeter()
    }
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null
  }

  function scheduleReconnect(reason = 'Соединение прервалось', forceAudioOnly = false) {
    if (reconnectLockedRef.current) return
    reconnectLockedRef.current = true
    setStatus(`${reason}. Переподключаемся…`)
    setConnectionQuality('Переподключение')
    setReconnectCount((prev) => prev + 1)
    reportQualityEvent('reconnect', reason)
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectLockedRef.current = false
      cleanupConnection({ keepStream: false })
      if (forceAudioOnly) setAudioOnlyMode(true)
      setRetryNonce((prev) => prev + 1)
    }, 1600)
  }

  function createPeerConnection() {
    if (pcRef.current) return pcRef.current

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    })

    pc.onicecandidate = (ev) => {
      if (ev.candidate && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'ice', candidate: ev.candidate }))
      }
    }

    pc.ontrack = (ev) => {
      const [remoteStream] = ev.streams
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = remoteStream
        try { remoteVideoRef.current.play?.() } catch {}
      }
    }

    pc.onconnectionstatechange = () => {
      const st = pc.connectionState
      if (st === 'connected') {
        setStatus('Соединение установлено')
        setConnectionQuality(weakNetwork ? 'Слабая сеть' : 'Хорошее')
      } else if (st === 'connecting') {
        setStatus('Подключаемся…')
        setConnectionQuality('Подключение')
      } else if (st === 'disconnected') {
        setStatus('Соединение нестабильно')
        setConnectionQuality('Нестабильно')
        scheduleReconnect('Нестабильная сеть', weakNetwork || audioOnlyModeRef.current)
      } else if (st === 'failed') {
        setStatus('Ошибка соединения')
        setConnectionQuality('Ошибка')
        scheduleReconnect('Ошибка WebRTC', true)
      } else if (st === 'closed') {
        setStatus('Созвон завершён')
        setConnectionQuality('Закрыто')
      }
    }

    if (observerModeRef.current) {
      ensureObserverTransceivers(pc)
    }

    pcRef.current = pc
    return pc
  }

  async function syncSendersWithStream(stream) {
    const pc = createPeerConnection()
    const senders = pc.getSenders()
    const audioTrack = stream.getAudioTracks()[0] || null
    const videoTrack = stream.getVideoTracks()[0] || null

    let audioSender = senders.find((s) => s.track?.kind === 'audio')
    let videoSender = senders.find((s) => s.track?.kind === 'video')

    if (observerModeRef.current) {
      ensureObserverTransceivers(pc)
      if (!audioSender && transceiversRef.current.audio) audioSender = transceiversRef.current.audio.sender
      if (!videoSender && transceiversRef.current.video) videoSender = transceiversRef.current.video.sender
    }

    if (audioSender) await audioSender.replaceTrack(audioTrack)
    else if (audioTrack) pc.addTrack(audioTrack, stream)

    if (videoSender) await videoSender.replaceTrack(videoTrack)
    else if (videoTrack) pc.addTrack(videoTrack, stream)

    if (observerModeRef.current) {
      if (transceiversRef.current.audio) transceiversRef.current.audio.direction = audioTrack ? 'sendrecv' : 'recvonly'
      if (transceiversRef.current.video) transceiversRef.current.video.direction = videoTrack ? 'sendrecv' : 'recvonly'
    }
  }

  function startStatsMonitor(pc) {
    stopStatsMonitor()
    statsTimerRef.current = window.setInterval(async () => {
      try {
        const stats = await pc.getStats()
        let weak = false
        let details = []
        stats.forEach((report) => {
          if (report.type === 'candidate-pair' && report.state === 'succeeded') {
            const rtt = Number(report.currentRoundTripTime || 0)
            if (rtt > 0.35) {
              weak = true
              details.push(`RTT ${Math.round(rtt * 1000)}ms`)
            }
          }
          if (report.type === 'inbound-rtp' && !report.isRemote) {
            const lost = Number(report.packetsLost || 0)
            if (lost > 12) {
              weak = true
              details.push(`потеря пакетов ${lost}`)
            }
          }
        })

        setWeakNetwork(weak)
        if (weak) {
          setConnectionQuality('Слабая сеть')
          const now = Date.now()
          if (now - lastWeakReportAtRef.current > 15000) {
            lastWeakReportAtRef.current = now
            reportQualityEvent('weak_network', details.join(', ').slice(0, 180))
          }
        } else if (pc.connectionState === 'connected') {
          setConnectionQuality(audioOnlyModeRef.current ? 'Аудио-режим' : 'Хорошее')
        }
      } catch {
        // ignore
      }
    }, 5000)
  }

  function connectSignaling(pc) {
    setStatus(observerModeRef.current ? 'Режим наблюдения: подключаемся к уроку…' : 'Ожидаем второго участника…')
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws
    manualCloseRef.current = false

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'ready' }))
    }

    ws.onmessage = async (event) => {
      let msg
      try { msg = JSON.parse(event.data) } catch { return }

      if (msg.type === 'peer-joined') {
        setStatus('Второй участник вошёл — создаём соединение…')
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
        if (desc.type === 'offer' && pc.signalingState !== 'stable') return
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
          // ignore race conditions
        }
      }
    }

    ws.onclose = () => {
      if (!mountedRef.current || manualCloseRef.current) return
      setStatus('Сигналинг закрыт')
      if (pc.connectionState !== 'closed') scheduleReconnect('Сигналинг разорван', weakNetwork || audioOnlyModeRef.current)
    }
    ws.onerror = () => setStatus('Ошибка сигналинга')
  }

  async function startSession() {
    setWeakNetwork(false)
    const pc = createPeerConnection()
    startStatsMonitor(pc)

    if (observerModeRef.current) {
      setMicOn(false)
      setCamOn(false)
      setAudioOnlyMode(true)
      setPermissionHint('Админ открывает урок как наблюдатель и не публикует камеру/микрофон автоматически.')
      connectSignaling(pc)
      return
    }

    setStatus('Запрашиваем камеру и микрофон…')
    const stream = await ensureLocalMedia(audioOnlyModeRef.current)
    await syncSendersWithStream(stream)
    connectSignaling(pc)
  }

  useEffect(() => {
    mountedRef.current = true
    startSession().catch((e) => {
      const msg = e?.message || 'Не удалось запустить созвон'
      if (mountedRef.current) {
        const fallback = observerModeRef.current ? msg : (msg.includes('разреш') ? msg : `${msg}. Разреши доступ к камере/микрофону в браузере.`)
        setStatus(fallback)
      }
    })

    navigator.mediaDevices?.addEventListener?.('devicechange', loadDevices)

    return () => {
      mountedRef.current = false
      navigator.mediaDevices?.removeEventListener?.('devicechange', loadDevices)
      cleanupConnection({ keepStream: false })
      reconnectLockedRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsUrl, retryNonce])

  useEffect(() => {
    if (!localStreamRef.current) return
    cleanupConnection({ keepStream: false })
    setRetryNonce((prev) => prev + 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAudioId, selectedCameraId])

  async function toggleMic() {
    if (observerModeRef.current && !localStreamRef.current) {
      try {
        setStatus('Подключаем микрофон администратора…')
        const stream = await ensureObserverMicrophone()
        await syncSendersWithStream(stream)
        await negotiatePeer('observer_mic_enabled')
        setStatus('Админ слушает урок. Микрофон доступен вручную.')
      } catch (e) {
        setStatus(e?.message || 'Не удалось включить микрофон')
      }
      return
    }

    const s = localStreamRef.current
    if (!s) return
    const tracks = s.getAudioTracks()
    tracks.forEach((t) => { t.enabled = !t.enabled })
    setMicOn(tracks.some((t) => t.enabled))
  }

  function toggleCam() {
    if (observerModeRef.current) return
    const s = localStreamRef.current
    if (!s) return
    const tracks = s.getVideoTracks()
    tracks.forEach((t) => { t.enabled = !t.enabled })
    setCamOn(tracks.some((t) => t.enabled))
  }

  function switchToAudioOnly() {
    setAudioOnlyMode(true)
    reportQualityEvent('audio_fallback', 'user_switched_to_audio_only')
    cleanupConnection({ keepStream: false })
    setRetryNonce((prev) => prev + 1)
  }

  function returnToVideo() {
    setAudioOnlyMode(false)
    cleanupConnection({ keepStream: false })
    setRetryNonce((prev) => prev + 1)
  }

  function reconnectNow() {
    scheduleReconnect('Ручное переподключение', audioOnlyModeRef.current)
  }

  return (
    <div className="lessonVideoShell">
      <div className="lessonDiagnosticsRow">
        <div className="lessonStatusChip">{status}</div>
        <div className={`lessonStatusChip ${connectionQuality === 'Хорошее' ? 'ok' : connectionQuality === 'Ошибка' ? 'bad' : weakNetwork ? 'warn' : ''}`}>
          Сеть: {connectionQuality}
        </div>
        <div className={`lessonStatusChip ${audioOnlyMode ? 'warn' : ''}`}>{audioOnlyMode ? 'Только аудио' : 'Видео + аудио'}</div>
        <div className="lessonMicMeterWrap">
          <span className="small">Микрофон</span>
          <div className="lessonMicMeter"><div style={{ width: `${micLevel}%` }} /></div>
        </div>
      </div>

      <div className="lessonVideoHelperRow">
        <div className="small">Переподключений: {reconnectCount}</div>
        {weakNetwork && <div className="small" style={{ color: '#b45309', fontWeight: 700 }}>Обнаружена слабая сеть — можно переключиться в аудио-режим.</div>}
      </div>

      <div className={`videoGrid ${audioOnlyMode ? 'audioOnlyGrid' : ''}`}>
        <div className="videoBox">
          <video ref={localVideoRef} autoPlay playsInline muted />
          <div className="videoLabel">{observerMode ? (micOn ? 'Админ • микрофон доступен' : 'Админ • наблюдатель') : 'Вы'}</div>
        </div>
        <div className="videoBox">
          <video ref={remoteVideoRef} autoPlay playsInline />
          <div className="videoLabel">Собеседник</div>
        </div>
      </div>

      <div className="lessonControlsRow" style={{ marginTop: 12 }}>
        <button className="btn" onClick={toggleMic}>{observerMode && !localStreamRef.current ? 'Подключить микрофон' : micOn ? 'Микрофон: вкл' : 'Микрофон: выкл'}</button>
        {!observerMode && <button className="btn" onClick={toggleCam} disabled={audioOnlyMode}>{camOn ? 'Камера: вкл' : 'Камера: выкл'}</button>}
        <button className="btn btnGhost" onClick={reconnectNow}>Переподключить</button>
        {!observerMode && (!audioOnlyMode ? (
          <button className="btn btnGhost" onClick={switchToAudioOnly}>Только аудио</button>
        ) : (
          <button className="btn btnGhost" onClick={returnToVideo}>Вернуть видео</button>
        ))}
        <button className="btn btnGhost" onClick={() => { cleanupConnection({ keepStream: false }); setRetryNonce((prev) => prev + 1) }}>Обновить устройства</button>
      </div>

      <div className="lessonDeviceGrid">
        {!observerMode && <div>
          <div className="label">Камера</div>
          <select className="select" value={selectedCameraId} onChange={(e) => setSelectedCameraId(e.target.value)}>
            {cameraDevices.length === 0 ? <option value="">Камера не найдена</option> : cameraDevices.map((d, idx) => <option key={d.deviceId || idx} value={d.deviceId}>{d.label || `Камера ${idx + 1}`}</option>)}
          </select>
          <div className="small">Активно: {mediaLabel(cameraDevices, selectedCameraId, camOn ? 'камера подключена' : 'камера выключена')}</div>
        </div>}
        <div>
          <div className="label">Микрофон</div>
          <select className="select" value={selectedAudioId} onChange={(e) => setSelectedAudioId(e.target.value)}>
            {audioDevices.length === 0 ? <option value="">Микрофон не найден</option> : audioDevices.map((d, idx) => <option key={d.deviceId || idx} value={d.deviceId}>{d.label || `Микрофон ${idx + 1}`}</option>)}
          </select>
          <div className="small">Активно: {mediaLabel(audioDevices, selectedAudioId, micOn ? 'микрофон подключён' : 'микрофон выключен')}</div>
        </div>
      </div>

      <div className="footerNote">{permissionHint}</div>
    </div>
  )
}
