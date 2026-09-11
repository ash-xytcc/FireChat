import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createClient, IndexedDBStore } from 'matrix-js-sdk'
import {
  CryptoEvent,
  VerificationPhase,
  VerifierEvent,
  canAcceptVerificationRequest,
  decodeRecoveryKey,
} from 'matrix-js-sdk/lib/crypto-api'

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

  return {
    id: safeEventId(event),
    body: typeof body === 'string' ? body : '',
    sender: event?.getSender?.() || '',
    ts: event?.getTs?.() || Date.now(),
    encrypted: !!event?.isEncrypted?.() || wireType === 'm.room.encrypted' || !!room?.isEncrypted?.(),
    undecryptable,
  }
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function uiaPassword(userId, password, session) {
  return {
    type: 'm.login.password',
    identifier: { type: 'm.id.user', user: userId },
    user: userId,
    password,
    ...(session ? { session } : {}),
  }
}

async function runPasswordUia(makeRequest, userId, password) {
  try {
    return await makeRequest(uiaPassword(userId, password))
  } catch (error) {
    const session = error?.data?.session
    if (error?.httpStatus === 401 && session) {
      return makeRequest(uiaPassword(userId, password, session))
    }
    throw error
  }
}

async function getDeviceTrust(client) {
  try {
    const crypto = client?.getCrypto?.()
    const userId = client?.getUserId?.()
    const deviceId = client?.getDeviceId?.()
    if (!crypto || !userId || !deviceId) {
      return { supportsEncryption: false, crossSigned: false, localVerified: false, signedByOwner: false }
    }

    const status = await crypto.getDeviceVerificationStatus(userId, deviceId)
    if (!status) {
      return { supportsEncryption: false, crossSigned: false, localVerified: false, signedByOwner: false }
    }

    return {
      supportsEncryption: true,
      crossSigned: status.crossSigningVerified === true,
      localVerified: status.localVerified === true,
      signedByOwner: status.signedByOwner === true,
    }
  } catch {
    return { supportsEncryption: false, crossSigned: false, localVerified: false, signedByOwner: false }
  }
}

export default function FireChatV2() {
  const [session, setSession] = useState(() => readJSON(SESSION_KEY, null))
  const [authMode, setAuthMode] = useState('create')
  const [homeserver, setHomeserver] = useState(() => session?.hsUrl || DEFAULT_HOMESERVER)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [status, setStatus] = useState('')
  const [ready, setReady] = useState(false)
  const [cryptoState, setCryptoState] = useState('idle')
  const [deviceVerified, setDeviceVerified] = useState(false)
  const [deviceSupportsEncryption, setDeviceSupportsEncryption] = useState(false)
  const [verificationReq, setVerificationReq] = useState(null)
  const [sasData, setSasData] = useState(null)
  const [verifyMsg, setVerifyMsg] = useState('')
  const [recoveryKey, setRecoveryKey] = useState('')
  const [recoveryBusy, setRecoveryBusy] = useState(false)
  const [generatedRecoveryKey, setGeneratedRecoveryKey] = useState('')
  const [rooms, setRooms] = useState([])
  const [activeRoomId, setActiveRoomId] = useState(null)
  const [messages, setMessages] = useState([])
  const [messageDraft, setMessageDraft] = useState('')
  const [memberCache, setMemberCache] = useState({})
  const [hideUndecryptable, setHideUndecryptable] = useState(() => readJSON('firechat_hide_undecryptable', true))
  const [newestFirst, setNewestFirst] = useState(() => readJSON('firechat_newest_first', false))

  const clientRef = useRef(null)
  const verifierRef = useRef(null)
  const sasFlowRef = useRef(null)
  const recoveryKeyRef = useRef(null)
  const authPasswordRef = useRef('')
  const newAccountRef = useRef(false)
  const activeRoomIdRef = useRef(null)

  const loggedIn = !!(session?.hsUrl && session?.userId && session?.accessToken)
  const cryptoReady = cryptoState === 'ready'

  const log = useCallback((...parts) => {
    setStatus(`[${new Date().toLocaleTimeString()}] ${parts.join(' ')}`)
  }, [])

  useEffect(() => writeJSON('firechat_hide_undecryptable', hideUndecryptable), [hideUndecryptable])
  useEffect(() => writeJSON('firechat_newest_first', newestFirst), [newestFirst])
  useEffect(() => { activeRoomIdRef.current = activeRoomId }, [activeRoomId])

  const refreshVerification = useCallback(async () => {
    const client = clientRef.current
    if (!client) return null
    const trust = await getDeviceTrust(client)
    setDeviceSupportsEncryption(trust.supportsEncryption)
    setDeviceVerified(trust.crossSigned)
    return trust
  }, [])

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

  const selectRoom = useCallback(async (roomId) => {
    setActiveRoomId(roomId)
    setMessages([])
    const client = clientRef.current
    const room = client?.getRoom?.(roomId)
    if (!client || !room) return

    try {
      for (const member of room.getJoinedMembers?.() || []) {
        const mxid = member?.userId
        if (!mxid) continue
        const mxc = member?.getMxcAvatarUrl?.() || member?.events?.member?.getContent?.()?.avatar_url
        const avatarUrl = mxc && typeof client.mxcUrlToHttp === 'function'
          ? client.mxcUrlToHttp(mxc, 64, 64, 'crop') || ''
          : ''
        cacheMember(roomId, mxid, { name: member?.name || mxid, avatarUrl })
      }
    } catch {}

    const events = (room.getLiveTimeline?.()?.getEvents?.() || []).filter((event) => event.getType?.() === 'm.room.message')
    setMessages(events.map((event) => eventToMessage(event, room)))
  }, [cacheMember])

  useEffect(() => {
    if (!rooms.length) return
    if (!rooms.some((room) => room.id === activeRoomId)) void selectRoom(rooms[0].id)
  }, [activeRoomId, rooms, selectRoom])

  const finishVerification = useCallback(async (successMessage = 'Verified') => {
    let trust = null
    for (let attempt = 0; attempt < 30; attempt += 1) {
      trust = await refreshVerification()
      if (trust?.crossSigned) break
      await sleep(300)
    }

    setVerificationReq(null)
    setSasData(null)
    verifierRef.current = null
    sasFlowRef.current = null

    if (trust?.crossSigned) {
      setVerifyMsg(successMessage)
      return true
    }

    setVerifyMsg('Verification finished, but this device is not cross-signed yet. Retry recovery or emoji verification.')
    return false
  }, [refreshVerification])

  const runSasVerification = useCallback(async (request) => {
    if (!request) return
    if (sasFlowRef.current === request) return
    if (sasFlowRef.current && sasFlowRef.current !== request) return

    sasFlowRef.current = request

    try {
      if (!request.initiatedByMe && request.phase === VerificationPhase.Requested) {
        try {
          await request.accept()
        } catch (error) {
          if (![VerificationPhase.Ready, VerificationPhase.Started].includes(request.phase)) throw error
        }
      }

      setVerifyMsg(request.initiatedByMe ? 'Waiting for your trusted device to accept…' : 'Preparing emoji verification…')

      let verifier = request.verifier
      for (let attempt = 0; attempt < 80 && !verifier; attempt += 1) {
        const phase = request.phase

        if (phase === VerificationPhase.Done) {
          await finishVerification('Verified with emoji')
          return
        }
        if (phase === VerificationPhase.Cancelled) throw new Error('Verification was cancelled')

        if (phase === VerificationPhase.Started && request.verifier) {
          verifier = request.verifier
          break
        }

        if (phase === VerificationPhase.Ready) {
          verifier = request.verifier || await request.startVerification('m.sas.v1')
          break
        }

        await sleep(250)
      }

      if (!verifier) throw new Error('The trusted device did not become ready for emoji verification')
      verifierRef.current = verifier

      verifier.on(VerifierEvent.ShowSas, (sas) => {
        const payload = sas?.sas || {}
        const emoji = Array.isArray(payload.emoji)
          ? payload.emoji.map((item) => Array.isArray(item) ? [item[0], item[1]] : [item?.emoji, item?.description || item?.name]).filter((item) => item?.[0])
          : null
        setSasData({ emoji, decimal: payload.decimal || null, confirm: sas.confirm, mismatch: sas.mismatch })
        setVerifyMsg('Compare these on both devices.')
      })

      verifier.on(VerifierEvent.Cancel, (error) => {
        verifierRef.current = null
        sasFlowRef.current = null
        setSasData(null)
        setVerificationReq(null)
        setVerifyMsg(`Verification cancelled: ${error?.reason || error?.message || 'unknown'}`)
      })

      void verifier.verify()
        .then(() => finishVerification('Verified with emoji'))
        .catch((error) => {
          verifierRef.current = null
          sasFlowRef.current = null
          setVerifyMsg(error?.message || String(error))
        })
    } catch (error) {
      verifierRef.current = null
      sasFlowRef.current = null
      setVerifyMsg(error?.message || String(error))
    }
  }, [finishVerification])

  const setupNewAccountSecurity = useCallback(async (client) => {
    const crypto = client.getCrypto?.()
    const passwordForAuth = authPasswordRef.current
    if (!crypto || !passwordForAuth) return

    try {
      const generated = await crypto.createRecoveryKeyFromPassphrase()
      recoveryKeyRef.current = generated.privateKey

      await crypto.bootstrapSecretStorage({
        createSecretStorageKey: async () => generated,
        setupNewKeyBackup: true,
      })

      await crypto.bootstrapCrossSigning({
        authUploadDeviceSigningKeys: async (makeRequest) => runPasswordUia(
          makeRequest,
          client.getUserId?.(),
          passwordForAuth,
        ),
      })

      try { await crypto.crossSignDevice(client.getDeviceId?.()) } catch {}
      setGeneratedRecoveryKey(generated.encodedPrivateKey || '')
      await finishVerification('Account encryption is ready. Save the recovery key before using another device.')
    } catch (error) {
      setVerifyMsg(`Account created, but encryption setup needs attention: ${error?.message || String(error)}`)
    } finally {
      authPasswordRef.current = ''
      newAccountRef.current = false
    }
  }, [finishVerification])

  useEffect(() => {
    if (!loggedIn || !session || clientRef.current) return

    let disposed = false
    const uid = normalizeMxid(session.userId)
    const uidSafe = sanitizeForIdb(uid)
    const deviceSafe = sanitizeForIdb(session.deviceId || 'unknown-device')
    const baseUrl = normalizeHomeserver(session.hsUrl)
    const store = new IndexedDBStore({
      indexedDB: window.indexedDB,
      localStorage: window.localStorage,
      dbName: `firechat_store_${uidSafe}`,
    })

    const client = createClient({
      baseUrl,
      accessToken: session.accessToken,
      userId: uid,
      deviceId: session.deviceId,
      store,
      timelineSupport: true,
      useAuthorizationHeader: true,
      verificationMethods: ['m.sas.v1'],
      cryptoCallbacks: {
        getSecretStorageKey: async ({ keys }) => {
          const privateKey = recoveryKeyRef.current
          if (!privateKey) return null
          const keyId = Object.keys(keys || {})[0]
          return keyId ? [keyId, privateKey] : null
        },
      },
    })

    clientRef.current = client
    setCryptoState('loading')
    setStatus('Connecting…')

    const onTimeline = (event, room, toStartOfTimeline) => {
      if (disposed || toStartOfTimeline) return
      if (event?.getType?.() !== 'm.room.message') return
      if (!activeRoomIdRef.current || room?.roomId !== activeRoomIdRef.current) return
      const mapped = eventToMessage(event, room)
      setMessages((current) => current.some((item) => item.id === mapped.id) ? current : [...current, mapped])
    }

    const onVerificationRequest = (request) => {
      setVerificationReq(request)
      setSasData(null)
      setVerifyMsg(request.initiatedByMe ? 'Waiting for your trusted device to accept…' : 'Verification request received. Accept it to compare emojis.')

      request.on?.('change', () => {
        if (request.phase === VerificationPhase.Done) {
          void finishVerification('Verified with emoji')
        } else if (request.phase === VerificationPhase.Cancelled) {
          setVerificationReq(null)
          setSasData(null)
          verifierRef.current = null
          sasFlowRef.current = null
          setVerifyMsg('Verification cancelled')
        } else if (request.initiatedByMe && [VerificationPhase.Ready, VerificationPhase.Started].includes(request.phase)) {
          void runSasVerification(request)
        }
      })
    }

    const onSync = (state) => {
      if (state === 'PREPARED') {
        setReady(true)
        setStatus('Connected')
        refreshRooms()
        void refreshVerification()
      }
    }

    ;(async () => {
      try {
        await store.startup()
        await client.initRustCrypto({
          cryptoDatabasePrefix: `firechat_crypto_${uidSafe}_${deviceSafe}`,
          useIndexedDB: true,
        })

        if (disposed) return
        const crypto = client.getCrypto?.()
        if (!crypto) throw new Error('Matrix encryption did not initialize')

        setCryptoState('ready')

        client.on('sync', onSync)
        client.on('Room.timeline', onTimeline)
        client.on(CryptoEvent.VerificationRequestReceived, onVerificationRequest)
        client.on?.('Room', refreshRooms)
        client.on?.('Room.name', refreshRooms)
        client.on?.('Room.myMembership', refreshRooms)
        client.startClient({ initialSyncLimit: 30 })

        try { await crypto.getOwnDeviceKeys?.() } catch {}

        if (newAccountRef.current) {
          await setupNewAccountSecurity(client)
        } else {
          await refreshVerification()
        }
      } catch (error) {
        setCryptoState('error')
        setStatus(`Encryption failed: ${error?.message || String(error)}`)
      }
    })()

    return () => {
      disposed = true
      try { client.stopClient?.() } catch {}
      try { client.removeAllListeners?.() } catch {}
      if (clientRef.current === client) clientRef.current = null
    }
  }, [finishVerification, loggedIn, refreshRooms, refreshVerification, runSasVerification, session, setupNewAccountSecurity])

  async function signIn(event) {
    event.preventDefault()
    const baseUrl = normalizeHomeserver(homeserver)
    if (!baseUrl || !username.trim() || !password) return

    try {
      setStatus('Signing in…')
      const temp = createClient({ baseUrl })
      const result = await temp.loginRequest({
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: username.trim() },
        password,
        initial_device_display_name: 'FireChat',
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
    } catch (error) {
      log('Sign in failed:', error?.message || 'Unknown error')
    }
  }

  async function createAccount(event) {
    event.preventDefault()
    const baseUrl = normalizeHomeserver(homeserver)
    const localpart = username.trim().replace(/^@/, '').split(':')[0]
    if (!baseUrl || !localpart || !password) return

    try {
      setStatus('Creating private account…')
      const temp = createClient({ baseUrl })
      let result
      try {
        result = await temp.registerRequest({
          username: localpart,
          password,
          initial_device_display_name: 'FireChat',
          inhibit_login: false,
        })
      } catch (error) {
        if (error?.httpStatus !== 401 || !error?.data?.session || !Array.isArray(error?.data?.flows)) throw error
        const anonymousFlow = error.data.flows.find((flow) =>
          Array.isArray(flow?.stages) && flow.stages.length === 1 && flow.stages[0] === 'm.login.dummy'
        )
        if (!anonymousFlow) {
          throw new Error('This server requires extra identity or anti-abuse checks. FireChat will not ask for a phone number or email. Choose a server that allows pseudonymous registration.')
        }
        result = await temp.registerRequest({
          username: localpart,
          password,
          initial_device_display_name: 'FireChat',
          inhibit_login: false,
          auth: { type: 'm.login.dummy', session: error.data.session },
        })
      }

      if (!result?.access_token || !result?.user_id) {
        throw new Error('The server created the account without a login session. Sign in with the new username and password.')
      }

      authPasswordRef.current = password
      newAccountRef.current = true
      const next = {
        hsUrl: baseUrl,
        userId: normalizeMxid(result.user_id),
        accessToken: result.access_token,
        deviceId: result.device_id || '',
      }
      writeJSON(SESSION_KEY, next)
      setSession(next)
      setPassword('')
    } catch (error) {
      log('Account creation failed:', error?.message || 'Unknown error')
    }
  }

  async function logout() {
    const client = clientRef.current
    try { client?.stopClient?.() } catch {}
    try { client?.removeAllListeners?.() } catch {}
    clientRef.current = null
    verifierRef.current = null
    sasFlowRef.current = null
    recoveryKeyRef.current = null
    authPasswordRef.current = ''
    newAccountRef.current = false
    removeKey(SESSION_KEY)
    setSession(null)
    setReady(false)
    setCryptoState('idle')
    setDeviceVerified(false)
    setDeviceSupportsEncryption(false)
    setVerificationReq(null)
    setSasData(null)
    setVerifyMsg('')
    setRecoveryKey('')
    setGeneratedRecoveryKey('')
    setRooms([])
    setMessages([])
    setActiveRoomId(null)
    setStatus('Signed out')
  }

  async function verifyWithRecoveryKey() {
    const client = clientRef.current
    const crypto = client?.getCrypto?.()
    if (!client || !crypto || !recoveryKey.trim() || recoveryBusy) return

    setRecoveryBusy(true)
    setVerifyMsg('Unlocking encrypted identity…')
    try {
      recoveryKeyRef.current = decodeRecoveryKey(recoveryKey.trim())
      const hasCrossSigning = await crypto.userHasCrossSigningKeys(client.getUserId?.(), true)
      if (!hasCrossSigning) {
        throw new Error('This Matrix account has no existing cross-signing identity to recover. Use emoji verification from a trusted device instead.')
      }

      await crypto.bootstrapCrossSigning({})
      await crypto.crossSignDevice(client.getDeviceId?.())
      try { await crypto.loadSessionBackupPrivateKeyFromSecretStorage() } catch {}

      const verified = await finishVerification('Verified with recovery key')
      if (!verified) throw new Error('The recovery key was accepted, but the server did not confirm a cross-signature for this device.')
      setRecoveryKey('')
    } catch (error) {
      recoveryKeyRef.current = null
      setVerifyMsg(`Recovery failed: ${error?.message || String(error)}`)
    } finally {
      setRecoveryBusy(false)
    }
  }

  async function requestEmojiVerification() {
    const crypto = clientRef.current?.getCrypto?.()
    if (!crypto) return
    if (sasFlowRef.current) return

    try {
      const request = await crypto.requestOwnUserVerification()
      setVerificationReq(request)
      setSasData(null)
      setVerifyMsg('Waiting for your trusted device to accept…')
      void runSasVerification(request)
    } catch (error) {
      sasFlowRef.current = null
      setVerifyMsg(error?.message || String(error))
    }
  }

  async function acceptVerification() {
    if (!verificationReq || sasFlowRef.current) return
    void runSasVerification(verificationReq)
  }

  async function confirmSas() {
    try {
      await sasData?.confirm?.()
      setVerifyMsg('Confirmed. Waiting for the other device…')
    } catch (error) {
      setVerifyMsg(error?.message || String(error))
    }
  }

  function mismatchSas() {
    try { sasData?.mismatch?.() } catch {}
    setSasData(null)
    setVerificationReq(null)
    verifierRef.current = null
    sasFlowRef.current = null
    setVerifyMsg('Verification cancelled because the codes did not match.')
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

  const accountState = !cryptoReady
    ? (cryptoState === 'error' ? 'encryption error' : 'encryption loading')
    : !deviceSupportsEncryption
      ? 'publishing encryption keys'
      : deviceVerified
        ? 'verified'
        : 'needs verification'

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-mark" aria-hidden="true">FC</div>
        <div className="brand-copy">
          <h1>FireChat</h1>
          <p>private encrypted communication</p>
        </div>
        <div className={`connection-pill ${ready ? 'ready' : ''}`}>{loggedIn ? (ready ? 'connected' : 'connecting') : 'ready'}</div>
      </header>

      {!loggedIn ? (
        <div className="login-shell">
          <section className="card login-intro">
            <h2>Private messaging without a phone number.</h2>
            <p>Create a pseudonymous account directly in FireChat. No email, phone number, address-book upload, or real name is requested by this app.</p>
          </section>

          <section className="card login-card">
            <div className="auth-tabs">
              <button className={`auth-tab ${authMode === 'create' ? 'active' : ''}`} type="button" onClick={() => setAuthMode('create')}>Create account</button>
              <button className={`auth-tab ${authMode === 'login' ? 'active' : ''}`} type="button" onClick={() => setAuthMode('login')}>Sign in</button>
            </div>

            <h2 className="section-title">{authMode === 'create' ? 'Create FireChat account' : 'Sign in'}</h2>
            <p className="helper">{authMode === 'create' ? 'Choose a handle and password. FireChat will refuse registration flows that require email or phone verification.' : 'Use your FireChat account or another compatible Matrix account.'}</p>

            <form className="grid login-form" onSubmit={authMode === 'create' ? createAccount : signIn}>
              <input className="input" value={username} onChange={(event) => setUsername(event.target.value)} placeholder={authMode === 'create' ? 'Handle' : 'Handle or @user:server'} autoComplete="username" required />
              <input className="input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Password" autoComplete={authMode === 'create' ? 'new-password' : 'current-password'} required />

              <details className="advanced-auth">
                <summary>Advanced server settings</summary>
                <div className="advanced-auth-body">
                  <label className="helper" htmlFor="homeserver">Homeserver</label>
                  <input id="homeserver" className="input" type="url" value={homeserver} onChange={(event) => setHomeserver(event.target.value)} required />
                </div>
              </details>

              <button className="btn primary" type="submit">{authMode === 'create' ? 'Create private account' : 'Sign in'}</button>
            </form>
            <div className="helper status-line">{status}</div>
          </section>
        </div>
      ) : (
        <>
          <div className="account-bar">
            <button className="btn ghost" type="button" onClick={logout}>Sign out</button>
            <div className="account-meta">{session?.userId} · {session?.deviceId || '(device loading)'} · {accountState}</div>
          </div>

          {generatedRecoveryKey && (
            <section className="card panel recovery-save-card">
              <h2 className="section-title">Save your recovery key</h2>
              <p className="helper">This is what lets a future FireChat session recover your encrypted identity without another trusted device. Store it somewhere you control.</p>
              <div className="recovery-key-display">{generatedRecoveryKey}</div>
              <div className="verification-actions">
                <button className="btn" type="button" onClick={() => navigator.clipboard?.writeText(generatedRecoveryKey)}>Copy recovery key</button>
                <button className="btn primary" type="button" onClick={() => setGeneratedRecoveryKey('')}>I saved it</button>
              </div>
            </section>
          )}

          <section className="card panel verification-card">
            <h2 className="section-title">Encryption & device trust</h2>

            {cryptoState === 'loading' && <div className="helper">Initializing end-to-end encryption for this device…</div>}
            {cryptoState === 'error' && <div className="error">FireChat could not initialize end-to-end encryption. This session should not be treated as secure. {status}</div>}

            {cryptoReady && !deviceSupportsEncryption && (
              <div className="helper">Publishing this device's encryption keys. If this remains here after a few seconds, sign out and sign back in once to create a clean FireChat device session.</div>
            )}

            {cryptoReady && deviceSupportsEncryption && deviceVerified && (
              <>
                <div className="helper">This device is encrypted and cross-signed. Other Matrix clients should show this session as verified.</div>
                <div className="verification-actions"><button className="btn" type="button" onClick={requestEmojiVerification}>Verify again with emoji</button></div>
              </>
            )}

            {cryptoReady && deviceSupportsEncryption && !deviceVerified && (
              <>
                <div className="helper">This device supports encryption but is not cross-signed yet. Enter the account recovery key, or verify from another trusted Matrix session.</div>
                <div className="verification-actions recovery-row">
                  <input className="input" type="password" autoComplete="off" value={recoveryKey} onChange={(event) => setRecoveryKey(event.target.value)} placeholder="Recovery key" aria-label="Recovery key" />
                  <button className="btn primary" type="button" onClick={verifyWithRecoveryKey} disabled={!recoveryKey.trim() || recoveryBusy}>{recoveryBusy ? 'Recovering…' : 'Trust this device'}</button>
                </div>

                <div className="helper verification-divider">Or verify from another trusted session with emoji.</div>

                {verificationReq ? (
                  <>
                    <div className="helper">Verification with {verificationReq.otherUserId}{verificationReq.otherDeviceId ? ` · ${verificationReq.otherDeviceId}` : ''}</div>
                    {sasData?.emoji || sasData?.decimal ? (
                      <>
                        {sasData.emoji ? (
                          <div className="sas-grid">
                            {sasData.emoji.map(([emoji, name], index) => (
                              <div className="sas-item" key={`${emoji}-${index}`}><div className="sas-emoji">{emoji}</div><div className="sas-name">{name}</div></div>
                            ))}
                          </div>
                        ) : <div className="helper">Code: {Array.isArray(sasData.decimal) ? sasData.decimal.join(' ') : ''}</div>}
                        <div className="verification-actions">
                          <button className="btn primary" type="button" onClick={confirmSas}>Confirm match</button>
                          <button className="btn" type="button" onClick={mismatchSas}>Doesn’t match</button>
                        </div>
                      </>
                    ) : !verificationReq.initiatedByMe ? (
                      <div className="verification-actions">
                        <button className="btn primary" type="button" onClick={acceptVerification}>Accept & compare emojis</button>
                      </div>
                    ) : null}
                  </>
                ) : (
                  <div className="verification-actions"><button className="btn" type="button" onClick={requestEmojiVerification}>Verify with emoji</button></div>
                )}
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
                {!rooms.length && <div className="empty">No rooms yet.</div>}
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
                <input className="input" value={messageDraft} onChange={(event) => setMessageDraft(event.target.value)} placeholder={currentRoom ? 'Type a message…' : 'Select a room first'} disabled={!currentRoom || currentRoom.membership === 'invite' || !cryptoReady} />
                <button className="btn primary" type="submit" disabled={!currentRoom || currentRoom.membership === 'invite' || !messageDraft.trim() || !cryptoReady}>Send</button>
              </form>
            </main>
          </div>

          <div className="helper status-line">{status}</div>
        </>
      )}
    </div>
  )
}
