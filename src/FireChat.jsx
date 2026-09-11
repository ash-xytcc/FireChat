import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createClient, IndexedDBStore, IndexedDBCryptoStore } from 'matrix-js-sdk'
import { CryptoEvent, VerifierEvent, canAcceptVerificationRequest } from 'matrix-js-sdk/lib/crypto-api'

const GLOBAL_MATRIX_KEY = '__firechat_matrix_client__'
const SESSION_KEY = 'firechat_matrix_session'
const DEFAULT_HOMESERVER = (import.meta.env.VITE_MATRIX_HOMESERVER || 'https://matrix-client.matrix.org').replace(/\/+$/, '')

function readJSON(key, fallback = null) {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

function writeJSON(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {}
}

function removeKey(key) {
  try {
    window.localStorage.removeItem(key)
  } catch {}
}

function getGlobalMatrix() {
  try {
    return window[GLOBAL_MATRIX_KEY] || null
  } catch {
    return null
  }
}

function setGlobalMatrix(value) {
  try {
    window[GLOBAL_MATRIX_KEY] = value
  } catch {}
}

function clearGlobalMatrix() {
  try {
    delete window[GLOBAL_MATRIX_KEY]
  } catch {}
}

function normalizeHomeserver(value) {
  return String(value || '').trim().replace(/\/+$/, '')
}

function normalizeMxid(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  const parts = text.split(':')
  if (parts.length <= 2) return text
  return `${parts[0]}:${parts[1]}`
}

function sanitizeForIdb(value) {
  return String(value || '').replace(/[^a-zA-Z0-9._=-]/g, '_')
}

function verifiedKeyFor(userId, deviceId) {
  return `firechat_mx_verified_${sanitizeForIdb(userId)}_${sanitizeForIdb(deviceId)}`
}

function safeEventId(event) {
  return event?.getId?.() || `${event?.getSender?.() || '?'}:${event?.getTs?.() || Date.now()}`
}

function eventToMessage(event, room = null) {
  const content = event?.getContent?.() || {}
  const body = content?.body
  const msgtype = content?.msgtype
  const wireType = event?.getWireType?.() || event?.event?.type || ''
  const undecryptable =
    !!event?.isDecryptionFailure?.() ||
    msgtype === 'm.bad.encrypted' ||
    (typeof body === 'string' && /unable to decrypt|decryptionerror/i.test(body))
  const encrypted = !!event?.isEncrypted?.() || wireType === 'm.room.encrypted' || !!room?.isEncrypted?.()

  return {
    id: safeEventId(event),
    body: typeof body === 'string' ? body : '',
    sender: event?.getSender?.() || '',
    ts: event?.getTs?.() || Date.now(),
    encrypted,
    undecryptable,
  }
}

async function deleteIDB(name) {
  try {
    if (!name || !window.indexedDB) return
    await new Promise((resolve) => {
      const request = window.indexedDB.deleteDatabase(name)
      request.onsuccess = () => resolve(true)
      request.onerror = () => resolve(false)
      request.onblocked = () => resolve(false)
    })
  } catch {}
}

async function nukeMatrixIdbForUser(userId) {
  const uidSafe = sanitizeForIdb(userId)
  if (!uidSafe) return
  const names = new Set([`firechat_mx_store_${uidSafe}`, `firechat_mx_crypto_${uidSafe}`])

  try {
    if (window.indexedDB?.databases) {
      const dbs = await window.indexedDB.databases()
      for (const db of dbs || []) {
        const name = db?.name || ''
        if (name.includes(uidSafe) && (name.startsWith('firechat_mx_store_') || name.startsWith('firechat_mx_crypto_'))) {
          names.add(name)
        }
      }
    }
  } catch {}

  for (const name of names) await deleteIDB(name)
}

async function detectCryptoReady(client) {
  try {
    const crypto = client?.getCrypto?.()
    if (!crypto) return false
    if (typeof crypto.isCryptoEnabled === 'function') return !!crypto.isCryptoEnabled()
    if (typeof crypto.getOwnDeviceKeys === 'function') return !!(await crypto.getOwnDeviceKeys())
    return true
  } catch {
    return false
  }
}

async function getDeviceVerifiedTruth(client) {
  try {
    const crypto = client?.getCrypto?.()
    const userId = client?.getUserId?.()
    const deviceId = client?.getDeviceId?.()
    if (!crypto || !userId || !deviceId) return null

    if (typeof crypto.getDeviceVerificationStatus === 'function') {
      const result = await crypto.getDeviceVerificationStatus(userId, deviceId)
      if (result === true || result === false) return result
      if (result && typeof result === 'object') {
        if (result.isVerified === true || result.verified === true || result.isCrossSigningVerified === true) return true
        if (result.isVerified === false || result.verified === false) return false
      }
    }

    if (typeof crypto.getDeviceVerification === 'function') {
      const result = await crypto.getDeviceVerification(userId, deviceId)
      if (result === true || result === false) return result
      if (result && typeof result === 'object') {
        if (result.isVerified === true || result.verified === true) return true
        if (result.isVerified === false || result.verified === false) return false
      }
    }
  } catch {}
  return null
}

export default function FireChat() {
  const [session, setSession] = useState(() => readJSON(SESSION_KEY, null))
  const [homeserver, setHomeserver] = useState(() => session?.hsUrl || DEFAULT_HOMESERVER)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [status, setStatus] = useState('')
  const [ready, setReady] = useState(false)
  const [cryptoReady, setCryptoReady] = useState(false)
  const [deviceVerified, setDeviceVerified] = useState(() => {
    const key = verifiedKeyFor(session?.userId || '', session?.deviceId || '')
    return key ? !!readJSON(key, false) : false
  })
  const [verificationReq, setVerificationReq] = useState(null)
  const [sasData, setSasData] = useState(null)
  const [verifyMsg, setVerifyMsg] = useState('')
  const [rooms, setRooms] = useState([])
  const [activeRoomId, setActiveRoomId] = useState(null)
  const [messages, setMessages] = useState([])
  const [messageDraft, setMessageDraft] = useState('')
  const [memberCache, setMemberCache] = useState({})
  const [hideUndecryptable, setHideUndecryptable] = useState(() => readJSON('firechat_hide_undecryptable', true))
  const [newestFirst, setNewestFirst] = useState(() => readJSON('firechat_newest_first', false))

  const clientRef = useRef(null)
  const verifierRef = useRef(null)
  const activeRoomIdRef = useRef(null)
  const stoppedRef = useRef(false)

  const loggedIn = !!(session?.hsUrl && session?.userId && session?.accessToken)

  const log = useCallback((...parts) => {
    setStatus(`[${new Date().toLocaleTimeString()}] ${parts.join(' ')}`)
  }, [])

  useEffect(() => writeJSON('firechat_hide_undecryptable', hideUndecryptable), [hideUndecryptable])
  useEffect(() => writeJSON('firechat_newest_first', newestFirst), [newestFirst])
  useEffect(() => { activeRoomIdRef.current = activeRoomId }, [activeRoomId])

  const cacheMember = useCallback((roomId, mxid, info) => {
    setMemberCache((current) => {
      const room = current[roomId] || {}
      const previous = room[mxid] || {}
      const next = { ...previous, ...info }
      if (previous.name === next.name && previous.avatarUrl === next.avatarUrl) return current
      return { ...current, [roomId]: { ...room, [mxid]: next } }
    })
  }, [])

  const getMemberInfo = useCallback((roomId, mxid) => {
    const cached = memberCache?.[roomId]?.[mxid]
    if (cached) return cached
    const client = clientRef.current
    if (!client) return { name: mxid, avatarUrl: '' }

    try {
      const room = client.getRoom(roomId)
      const member = room?.getMember?.(mxid)
      const name = member?.name || mxid
      const mxc = member?.getMxcAvatarUrl?.() || member?.events?.member?.getContent?.()?.avatar_url
      const avatarUrl = mxc && typeof client.mxcUrlToHttp === 'function'
        ? client.mxcUrlToHttp(mxc, 64, 64, 'crop') || ''
        : ''
      const info = { name, avatarUrl }
      cacheMember(roomId, mxid, info)
      return info
    } catch {
      return { name: mxid, avatarUrl: '' }
    }
  }, [cacheMember, memberCache])

  const refreshRooms = useCallback(() => {
    const client = clientRef.current
    if (!client) return
    try {
      let matrixRooms = client.getVisibleRooms?.() || []
      matrixRooms = matrixRooms.filter((room) => ['join', 'invite'].includes(room.getMyMembership?.()))
      if (!matrixRooms.length && typeof client.getRooms === 'function') {
        matrixRooms = (client.getRooms() || []).filter((room) => ['join', 'invite'].includes(room.getMyMembership?.()))
      }
      matrixRooms.sort((a, b) => (b.getLastActiveTimestamp?.() || 0) - (a.getLastActiveTimestamp?.() || 0))
      setRooms(matrixRooms.map((room) => ({
        id: room.roomId,
        name: room.name || room.getCanonicalAlias?.() || room.roomId,
        encrypted: !!room.isEncrypted?.(),
        membership: room.getMyMembership?.() || '',
      })))
    } catch (error) {
      log('Room refresh failed:', error?.message || error)
    }
  }, [log])

  const refreshVerificationTruth = useCallback(async () => {
    const client = clientRef.current
    if (!client) return
    const cryptoOk = await detectCryptoReady(client)
    setCryptoReady(cryptoOk)
    const truth = await getDeviceVerifiedTruth(client)
    if (truth === true) {
      setDeviceVerified(true)
      const key = verifiedKeyFor(client.getUserId?.(), client.getDeviceId?.())
      if (key) writeJSON(key, true)
    } else if (truth === false) {
      setDeviceVerified(false)
    }
  }, [])

  const persistSessionFromClient = useCallback((client, fallbackSession = session) => {
    if (!client || !fallbackSession) return
    try {
      const next = {
        hsUrl: normalizeHomeserver(fallbackSession.hsUrl || DEFAULT_HOMESERVER),
        userId: normalizeMxid(client.getUserId?.() || fallbackSession.userId || ''),
        accessToken: fallbackSession.accessToken || '',
        deviceId: client.getDeviceId?.() || fallbackSession.deviceId || '',
      }
      if (!next.userId || !next.accessToken) return
      writeJSON(SESSION_KEY, next)
      setSession((current) => {
        if (current?.userId === next.userId && current?.accessToken === next.accessToken && current?.deviceId === next.deviceId && current?.hsUrl === next.hsUrl) return current
        return next
      })
      setGlobalMatrix({ client, ...next })
    } catch {}
  }, [session])

  const cleanupVerification = useCallback((message = '') => {
    setSasData(null)
    setVerificationReq(null)
    verifierRef.current = null
    setVerifyMsg(message)
  }, [])

  const markThisDeviceVerified = useCallback(() => {
    const client = clientRef.current
    const userId = client?.getUserId?.() || session?.userId || ''
    const deviceId = client?.getDeviceId?.() || session?.deviceId || ''
    setDeviceVerified(true)
    const key = verifiedKeyFor(userId, deviceId)
    if (key) writeJSON(key, true)
  }, [session?.deviceId, session?.userId])

  const selectRoom = useCallback(async (roomId) => {
    setActiveRoomId(roomId)
    setMessages([])
    const client = clientRef.current
    if (!client) return
    const room = client.getRoom(roomId)
    if (!room) return

    try {
      const members = room.getJoinedMembers?.() || []
      members.forEach((member) => {
        const mxid = member?.userId
        if (!mxid) return
        const mxc = member?.getMxcAvatarUrl?.() || member?.events?.member?.getContent?.()?.avatar_url
        const avatarUrl = mxc && typeof client.mxcUrlToHttp === 'function'
          ? client.mxcUrlToHttp(mxc, 64, 64, 'crop') || ''
          : ''
        cacheMember(roomId, mxid, { name: member?.name || mxid, avatarUrl })
      })
    } catch {}

    const timeline = room.getLiveTimeline?.()
    const events = (timeline?.getEvents?.() || []).filter((event) => event.getType?.() === 'm.room.message')
    setMessages(events.map((event) => eventToMessage(event, room)))
  }, [cacheMember])

  useEffect(() => {
    if (!rooms.length) {
      if (activeRoomId) {
        setActiveRoomId(null)
        setMessages([])
      }
      return
    }
    if (!rooms.some((room) => room.id === activeRoomId)) void selectRoom(rooms[0].id)
  }, [activeRoomId, rooms, selectRoom])

  useEffect(() => {
    if (!loggedIn || !session) return
    if (clientRef.current) return

    stoppedRef.current = false
    const baseUrl = normalizeHomeserver(session.hsUrl)
    const uid = normalizeMxid(session.userId)
    const uidSafe = sanitizeForIdb(uid)
    const global = getGlobalMatrix()
    const canReuse = !!(
      global?.client &&
      global.hsUrl === baseUrl &&
      global.userId === uid &&
      global.accessToken === session.accessToken &&
      (!session.deviceId || global.deviceId === session.deviceId)
    )

    let client
    let store = null
    if (canReuse) {
      client = global.client
      setReady(true)
      log('Connected (resumed)')
    } else {
      store = new IndexedDBStore({
        indexedDB: window.indexedDB,
        localStorage: window.localStorage,
        dbName: `firechat_mx_store_${uidSafe}`,
      })
      const cryptoStore = new IndexedDBCryptoStore(window.indexedDB, `firechat_mx_crypto_${uidSafe}`)
      client = createClient({
        baseUrl,
        accessToken: session.accessToken,
        userId: uid,
        deviceId: session.deviceId || undefined,
        store,
        cryptoStore,
      })
      setGlobalMatrix({ client, hsUrl: baseUrl, userId: uid, accessToken: session.accessToken, deviceId: session.deviceId || '' })
      log('Connecting…')
    }

    clientRef.current = client

    function onTimeline(event, room, toStartOfTimeline) {
      if (stoppedRef.current || toStartOfTimeline) return
      if (event?.getType?.() !== 'm.room.message') return
      if (!activeRoomIdRef.current || room?.roomId !== activeRoomIdRef.current) return
      const mapped = eventToMessage(event, room)
      setMessages((current) => current.some((item) => item.id === mapped.id) ? current : [...current, mapped])
    }

    function onVerificationReq(request) {
      setVerificationReq(request)
      setSasData(null)
      setVerifyMsg('')
      request.on?.('change', () => setVerificationReq(request))
    }

    function onSync(state) {
      if (state === 'PREPARED') {
        persistSessionFromClient(client, session)
        setReady(true)
        setStatus('Connected')
        refreshRooms()
        void refreshVerificationTruth()
      }
    }

    function onRoomUpdate() {
      refreshRooms()
    }

    ;(async () => {
      if (!canReuse) {
        try {
          await store.startup()
        } catch (error) {
          log('Store startup failed:', error?.message || error)
        }

        try {
          if (typeof client.initRustCrypto === 'function') {
            await client.initRustCrypto()
            setCryptoReady(true)
          } else if (typeof client.initCrypto === 'function') {
            await client.initCrypto()
            setCryptoReady(true)
          } else {
            setCryptoReady(false)
            log('Matrix crypto initialization is unavailable')
          }
        } catch (error) {
          setCryptoReady(false)
          log('Crypto init failed:', error?.message || error)
        }
      } else {
        setCryptoReady(await detectCryptoReady(client))
      }

      persistSessionFromClient(client, session)
      refreshRooms()
      await refreshVerificationTruth()

      try {
        const crypto = client.getCrypto?.()
        const pending = crypto?.getVerificationRequestsToDeviceInProgress?.(client.getUserId?.() || uid)
        if (pending?.length) onVerificationReq(pending[0])
      } catch {}

      client.on('sync', onSync)
      client.on(CryptoEvent.VerificationRequestReceived, onVerificationReq)
      client.on('Room.timeline', onTimeline)
      client.on?.('Room', onRoomUpdate)
      client.on?.('Room.name', onRoomUpdate)
      client.on?.('Room.myMembership', onRoomUpdate)
      if (!canReuse) client.startClient({ initialSyncLimit: 30 })
    })()

    return () => {
      stoppedRef.current = true
      try {
        client.removeListener?.('sync', onSync)
        client.removeListener?.(CryptoEvent.VerificationRequestReceived, onVerificationReq)
        client.removeListener?.('Room.timeline', onTimeline)
        client.removeListener?.('Room', onRoomUpdate)
        client.removeListener?.('Room.name', onRoomUpdate)
        client.removeListener?.('Room.myMembership', onRoomUpdate)
      } catch {}
      clientRef.current = null
    }
  }, [loggedIn, log, persistSessionFromClient, refreshRooms, refreshVerificationTruth, session])

  useEffect(() => {
    function refreshWhenVisible() {
      if (document.visibilityState === 'visible') {
        refreshRooms()
        void refreshVerificationTruth()
      }
    }
    window.addEventListener('focus', refreshWhenVisible)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      window.removeEventListener('focus', refreshWhenVisible)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [refreshRooms, refreshVerificationTruth])

  async function login(event) {
    event.preventDefault()
    const baseUrl = normalizeHomeserver(homeserver)
    if (!baseUrl) return
    try {
      setStatus('Signing in…')
      const tempClient = createClient({ baseUrl })
      const result = await tempClient.login('m.login.password', {
        identifier: { type: 'm.id.user', user: username.trim() },
        password,
      })
      const next = {
        hsUrl: baseUrl,
        userId: normalizeMxid(result.user_id),
        accessToken: result.access_token,
        deviceId: result.device_id || '',
      }
      writeJSON(SESSION_KEY, next)
      setSession(next)
      setPassword('')
      setStatus('Signed in')
    } catch (error) {
      log('Login failed:', error?.message || 'Unknown error')
    }
  }

  async function logout() {
    const userId = session?.userId || ''
    const deviceId = session?.deviceId || ''
    const client = clientRef.current
    try { client?.stopClient?.() } catch {}
    try { client?.removeAllListeners?.() } catch {}
    clientRef.current = null
    clearGlobalMatrix()
    removeKey(SESSION_KEY)
    removeKey(verifiedKeyFor(userId, deviceId))
    setSession(null)
    setReady(false)
    setCryptoReady(false)
    setDeviceVerified(false)
    setRooms([])
    setActiveRoomId(null)
    setMessages([])
    setStatus('Signed out')
    cleanupVerification('')
  }

  async function resetMatrixStorage() {
    const userId = session?.userId || ''
    const deviceId = session?.deviceId || ''
    const client = clientRef.current
    try { client?.stopClient?.() } catch {}
    try { client?.removeAllListeners?.() } catch {}
    clientRef.current = null
    clearGlobalMatrix()
    removeKey(SESSION_KEY)
    removeKey(verifiedKeyFor(userId, deviceId))
    await nukeMatrixIdbForUser(userId)
    setSession(null)
    setReady(false)
    setCryptoReady(false)
    setDeviceVerified(false)
    setRooms([])
    setActiveRoomId(null)
    setMessages([])
    cleanupVerification('')
    setStatus('Local Matrix storage reset')
  }

  async function requestOwnVerification() {
    const client = clientRef.current
    if (!client) return
    try {
      const crypto = client.getCrypto?.()
      if (!crypto?.requestOwnUserVerification) {
        setVerifyMsg('This Matrix build cannot initiate verification. Start verification from another Matrix client.')
        return
      }
      const request = await crypto.requestOwnUserVerification()
      setVerificationReq(request)
      setSasData(null)
      setVerifyMsg('Verification request sent. Accept it on your other device, then start SAS here.')
    } catch (error) {
      setVerifyMsg(error?.message || String(error))
    }
  }

  function checkPendingVerification() {
    const client = clientRef.current
    if (!client) return
    try {
      const crypto = client.getCrypto?.()
      const pending = crypto?.getVerificationRequestsToDeviceInProgress?.(client.getUserId?.() || session?.userId) || []
      if (pending.length) {
        setVerificationReq(pending[0])
        setVerifyMsg('Found an in-progress verification.')
      } else {
        setVerifyMsg('No in-progress verification found.')
      }
    } catch (error) {
      setVerifyMsg(error?.message || String(error))
    }
  }

  async function acceptVerification() {
    if (!verificationReq) return
    try {
      if (!canAcceptVerificationRequest(verificationReq)) {
        setVerifyMsg('This verification is already in progress.')
        return
      }
      await verificationReq.accept()
      setVerifyMsg('Accepted. Start SAS to compare codes.')
    } catch (error) {
      setVerifyMsg(error?.message || String(error))
    }
  }

  async function startSas() {
    if (!verificationReq || verifierRef.current) return
    try {
      setSasData(null)
      setVerifyMsg('')
      const verifier = await verificationReq.startVerification('m.sas.v1')
      verifierRef.current = verifier

      verifier.on(VerifierEvent.ShowSas, (sas) => {
        const payload = sas?.sas || {}
        const emoji = Array.isArray(payload.emoji)
          ? payload.emoji.map((item) => {
              if (Array.isArray(item)) return [item[0], item[1]]
              if (item && typeof item === 'object') return [item.emoji, item.description || item.name]
              return null
            }).filter(Boolean)
          : null
        setSasData({ emoji, decimal: payload.decimal || null, confirm: sas.confirm, mismatch: sas.mismatch })
      })

      verifier.on(VerifierEvent.Done, () => {
        markThisDeviceVerified()
        cleanupVerification('Verified')
      })
      verifier.on(VerifierEvent.Cancel, (error) => cleanupVerification(`Cancelled: ${error?.reason || 'unknown'}`))
      await verifier.verify()
    } catch (error) {
      verifierRef.current = null
      setVerifyMsg(error?.message || String(error))
    }
  }

  async function confirmSas() {
    try {
      await sasData?.confirm?.()
      setVerifyMsg('Confirmed. Waiting for the other device…')
    } catch (error) {
      setVerifyMsg(error?.message || String(error))
    }
  }

  async function mismatchSas() {
    try {
      await sasData?.mismatch?.()
      cleanupVerification('Mismatch sent.')
    } catch (error) {
      setVerifyMsg(error?.message || String(error))
    }
  }

  async function sendMessage(event) {
    event.preventDefault()
    const client = clientRef.current
    if (!client || !activeRoomId || !messageDraft.trim()) return
    const body = messageDraft.trim()
    setMessageDraft('')
    const optimistic = {
      id: `local:${Date.now()}:${Math.random().toString(16).slice(2)}`,
      body,
      sender: session?.userId || '',
      ts: Date.now(),
      encrypted: true,
      undecryptable: false,
    }
    setMessages((current) => [...current, optimistic])
    try {
      await client.sendEvent(activeRoomId, 'm.room.message', { msgtype: 'm.text', body }, '')
    } catch (error) {
      log('Send failed:', error?.message || 'Unknown error')
    }
  }

  const currentRoom = useMemo(() => rooms.find((room) => room.id === activeRoomId) || null, [activeRoomId, rooms])
  const shownMessages = useMemo(() => {
    const filtered = hideUndecryptable ? messages.filter((message) => !message.undecryptable) : messages
    const sorted = [...filtered].sort((a, b) => a.ts - b.ts)
    return newestFirst ? sorted.reverse() : sorted
  }, [hideUndecryptable, messages, newestFirst])

  const deviceLock = !cryptoReady ? 'crypto loading' : deviceVerified ? 'verified' : 'unverified'

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-mark" aria-hidden="true">FC</div>
        <div className="brand-copy">
          <h1>FireChat</h1>
          <p>encrypted collective communication</p>
        </div>
        <div className={`connection-pill ${ready ? 'ready' : ''}`}>{loggedIn ? (ready ? 'connected' : 'connecting') : 'offline'}</div>
      </header>

      {!loggedIn ? (
        <div className="login-shell">
          <section className="card login-intro">
            <h2>Private rooms without the organization shell.</h2>
            <p>FireChat is the standalone Matrix chat application extracted from Bondfire. It keeps encrypted room support, local session storage, and device verification without requiring a Bondfire workspace.</p>
          </section>
          <section className="card login-card">
            <h2 className="section-title">Sign in to Matrix</h2>
            <p className="helper">Use an existing Matrix account. Your homeserver can be changed below.</p>
            <form className="grid login-form" onSubmit={login}>
              <input className="input" type="url" value={homeserver} onChange={(event) => setHomeserver(event.target.value)} placeholder="https://matrix.example.org" required />
              <input className="input" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="Matrix username or @user:server" required />
              <input className="input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Password" required />
              <button className="btn primary" type="submit">Sign in</button>
            </form>
            <div className="helper status-line">{status}</div>
          </section>
        </div>
      ) : (
        <>
          <div className="account-bar">
            <button className="btn ghost" type="button" onClick={logout}>Sign out</button>
            <button className="btn ghost danger" type="button" onClick={resetMatrixStorage}>Reset local Matrix storage</button>
            <div className="account-meta">{session?.userId} · {session?.deviceId || '(device loading)'} · {deviceLock}</div>
          </div>

          <section className="card panel verification-card">
            <h2 className="section-title">Device verification</h2>
            {!cryptoReady ? (
              <div className="helper">Encryption is still initializing. Verification becomes available when Matrix crypto is ready.</div>
            ) : deviceVerified && !verificationReq ? (
              <>
                <div className="helper">This FireChat session is verified for the account.</div>
                <div className="verification-actions"><button className="btn" type="button" onClick={requestOwnVerification}>Re-verify</button></div>
              </>
            ) : verificationReq ? (
              <>
                <div className="helper">Verification with {verificationReq.otherUserId} · {verificationReq.otherDeviceId}</div>
                {sasData?.emoji || sasData?.decimal ? (
                  <>
                    {sasData.emoji ? (
                      <div className="sas-grid">
                        {sasData.emoji.map(([emoji, name], index) => (
                          <div className="sas-item" key={`${emoji}-${index}`}><div className="sas-emoji">{emoji}</div><div className="sas-name">{name}</div></div>
                        ))}
                      </div>
                    ) : (
                      <div className="helper">Code: {Array.isArray(sasData.decimal) ? sasData.decimal.join(' ') : ''}</div>
                    )}
                    <div className="verification-actions">
                      <button className="btn primary" type="button" onClick={confirmSas}>Confirm match</button>
                      <button className="btn" type="button" onClick={mismatchSas}>Doesn’t match</button>
                    </div>
                  </>
                ) : (
                  <div className="verification-actions">
                    <button className="btn" type="button" onClick={acceptVerification}>Accept</button>
                    <button className="btn" type="button" onClick={startSas}>Start SAS</button>
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="helper">Verify this device against another Matrix client signed into the same account.</div>
                <div className="verification-actions">
                  <button className="btn" type="button" onClick={requestOwnVerification}>Request verification</button>
                  <button className="btn" type="button" onClick={checkPendingVerification}>Check pending</button>
                </div>
              </>
            )}
            {verifyMsg && <div className="helper status-line">{verifyMsg}</div>}
          </section>

          <div className="chat-layout">
            <aside className="card rooms-panel">
              <h2 className="section-title">Rooms</h2>
              <div className="room-options">
                <label className="check-row"><input type="checkbox" checked={hideUndecryptable} onChange={(event) => setHideUndecryptable(event.target.checked)} /> Hide undecryptable messages</label>
                <label className="check-row"><input type="checkbox" checked={newestFirst} onChange={(event) => setNewestFirst(event.target.checked)} /> Newest first</label>
              </div>
              <div className="room-list">
                {rooms.map((room) => (
                  <button className={`room-button ${room.id === activeRoomId ? 'active' : ''}`} type="button" key={room.id} onClick={() => void selectRoom(room.id)}>
                    {room.name}{room.encrypted ? ' 🔒' : ''}{room.membership === 'invite' ? ' · invite' : ''}
                  </button>
                ))}
                {!rooms.length && <div className="empty">No rooms found for this Matrix account.</div>}
              </div>
            </aside>

            <main className="card message-panel">
              <div className="message-header"><h2>{currentRoom ? `${currentRoom.name}${currentRoom.encrypted ? ' 🔒' : ''}` : 'Select a room'}</h2></div>
              <div className="message-list">
                {!shownMessages.length ? <div className="empty">No messages yet.</div> : shownMessages.map((message) => {
                  const info = activeRoomId ? getMemberInfo(activeRoomId, message.sender) : { name: message.sender, avatarUrl: '' }
                  return (
                    <div className="message" key={message.id}>
                      {info.avatarUrl ? <img className="avatar" src={info.avatarUrl} alt="" /> : <div className="avatar" aria-hidden="true" />}
                      <div className="message-copy">
                        <div className="message-meta">{info.name} · {new Date(message.ts).toLocaleString()} {message.encrypted && !message.undecryptable ? '🔒' : ''}</div>
                        <div className="message-body">{message.body || <span className="helper">(undecryptable)</span>}</div>
                      </div>
                    </div>
                  )
                })}
              </div>
              <form className="composer" onSubmit={sendMessage}>
                <input className="input" value={messageDraft} onChange={(event) => setMessageDraft(event.target.value)} placeholder={currentRoom ? 'Type a message…' : 'Select a room first'} disabled={!currentRoom || currentRoom.membership === 'invite'} />
                <button className="btn primary" type="submit" disabled={!currentRoom || currentRoom.membership === 'invite' || !messageDraft.trim()}>Send</button>
              </form>
            </main>
          </div>
          <div className="helper status-line">{status}</div>
        </>
      )}
    </div>
  )
}
