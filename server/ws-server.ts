import { WebSocketServer, WebSocket } from 'ws'
import { createServer } from 'http'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync, existsSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { randomUUID } from 'crypto'
import { networkInterfaces } from 'os'
import sharp from 'sharp'
import { visualMemory, type VisualContext, type VisualSearchResult } from './visual-memory.js'
import { multimodalMemory } from './multimodal-memory.js'
import { EntityStore } from './memory/entity-store.js'
import { VisionLog, type VisionSearchResult } from './memory/vision-log.js'
import { FacePersistenceTracker } from './memory/face-tracker.js'
import { NewSpeakerDetector } from './memory/speaker-tracker.js'

// Initialize entity memory store
const entityStore = new EntityStore()
const visionLog = new VisionLog()
entityStore.seed()

// New person detection trackers
const faceTracker = new FacePersistenceTracker()
const speakerTracker = new NewSpeakerDetector()

// Load config
const CONFIG_PATH = resolve(import.meta.dirname ?? '.', '..', 'clawatar.config.json')
let config: any = {}
try { config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) } catch {}

const VITE_PORT = config.server?.vitePort || 3000
const WS_PORT = config.server?.wsPort || 8765
const AUDIO_PORT = config.server?.audioPort || 8866
const ENFORCE_LOOPBACK_WS_CLIENTS = process.env.CLAWATAR_ALLOW_REMOTE_WS_CLIENTS !== '1'
const SERVER_HOST = ENFORCE_LOOPBACK_WS_CLIENTS ? '127.0.0.1' : '0.0.0.0'
const AUDIO_CACHE_DIR = resolve(import.meta.dirname ?? '.', '_audio_cache')
const MAX_CACHE_FILES = 64
const SYNC_STATE_DIR = resolve(import.meta.dirname ?? '.', 'memory')
const SYNC_STATE_PATH = resolve(SYNC_STATE_DIR, 'clawatar-sync-state.json')
const OPENCLAW_SYNC_BACKUP_PATH = process.env.HOME
  ? join(process.env.HOME, '.openclaw', 'clawatar-sync-state.json')
  : ''

const ALLOWED_THEME_KEYS = new Set(['sakura', 'sunset', 'ocean', 'night', 'forest', 'lavender', 'minimal'])
const ALLOWED_CAMERA_PRESETS = new Set(['face', 'portrait', 'full'])

type TtsProviderKind = 'elevenlabs' | 'openai-compatible'

type ResolvedTtsConfig = {
  provider: TtsProviderKind
  elevenlabs: {
    voiceId: string
    model: string
    apiKey: string
  }
  openaiCompatible: {
    endpoint: string
    model: string
    voice: string
    responseFormat: string
    apiKey: string
  }
}

function getElevenLabsApiKey(): string {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY
  try {
    const configPath = join(process.env.HOME || '', '.openclaw', 'openclaw.json')
    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    return config?.skills?.entries?.sag?.apiKey || ''
  } catch { return '' }
}

function resolveTtsConfig(): ResolvedTtsConfig {
  return {
    provider: config.voice?.provider === 'openai-compatible' ? 'openai-compatible' : 'elevenlabs',
    elevenlabs: {
      voiceId: process.env.ELEVEN_LABS_VOICE_ID || config.voice?.elevenlabs?.voiceId || config.voice?.elevenlabsVoiceId || 'L5vK1xowu0LZIPxjLSl5',
      model: process.env.ELEVEN_LABS_MODEL || config.voice?.elevenlabs?.model || config.voice?.elevenlabsModel || 'eleven_turbo_v2_5',
      apiKey: process.env.ELEVENLABS_API_KEY || config.voice?.elevenlabs?.apiKey || getElevenLabsApiKey(),
    },
    openaiCompatible: {
      endpoint: process.env.OPENAI_COMPATIBLE_TTS_ENDPOINT || config.voice?.openaiCompatible?.endpoint || 'http://127.0.0.1:8772/v1/audio/speech',
      model: process.env.OPENAI_COMPATIBLE_TTS_MODEL || config.voice?.openaiCompatible?.model || 'tts-1',
      voice: process.env.OPENAI_COMPATIBLE_TTS_VOICE || config.voice?.openaiCompatible?.voice || 'af_bella',
      responseFormat: process.env.OPENAI_COMPATIBLE_TTS_RESPONSE_FORMAT || config.voice?.openaiCompatible?.responseFormat || 'mp3',
      apiKey: process.env.OPENAI_COMPATIBLE_TTS_API_KEY || config.voice?.openaiCompatible?.apiKey || '',
    },
  }
}

const TTS = resolveTtsConfig()
const VOICE_ID = TTS.elevenlabs.voiceId
const MODEL_ID = TTS.elevenlabs.model
const API_KEY = TTS.elevenlabs.apiKey

const TRANSPORT_STATUS_KEYWORDS = /(relay|gateway|websocket|ws|8765|18789|连接|连上|本地|直连|鉴权|session|配对|pair)/i
const BRIDGE_STATUS_URL = process.env.CLAWATAR_BRIDGE_STATUS_URL || 'http://127.0.0.1:8797/status'
const RELAY_SESSION_STATUS_URL = process.env.CLAWATAR_RELAY_SESSION_STATUS_URL || 'http://127.0.0.1:8797/relay/session-status'

function getLocalNetworkIPs(): string[] {
  const interfaces = networkInterfaces()
  const ips = new Set<string>()

  for (const iface of Object.values(interfaces)) {
    if (!iface) continue
    for (const addr of iface) {
      if (addr.family !== 'IPv4' || addr.internal) continue
      ips.add(addr.address)
    }
  }

  return Array.from(ips)
}

function getPrimaryNetworkIP(): string | null {
  const localIPs = getLocalNetworkIPs()
  if (localIPs.length === 0) return null

  const preferred = localIPs.find(ip => ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.'))
  return preferred || localIPs[0]
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false
  const normalized = address.trim().toLowerCase()
  return normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === '::ffff:127.0.0.1'
}

function getAudioBaseURL(): string {
  const tsIP = process.env.CLAWATAR_TAILSCALE_IP || '100.77.209.106'
  if (process.env.CLAWATAR_TAILSCALE_IP || tsIP) {
    return `http://${tsIP}:${actualAudioPort}`
  }
  const host = process.env.CLAWATAR_PUBLIC_HOST || getPrimaryNetworkIP() || 'localhost'
  return `http://${host}:${actualAudioPort}`
}

function logNetworkEndpoints() {
  if (ENFORCE_LOOPBACK_WS_CLIENTS) {
    console.log(`🌐 VRM Viewer: http://localhost:${VITE_PORT}`)
    console.log(`🔌 WebSocket (loopback only): ws://127.0.0.1:${WS_PORT}`)
    return
  }

  const localIPs = getLocalNetworkIPs()
  if (localIPs.length === 0) {
    console.log(`🌐 VRM Viewer: http://localhost:${VITE_PORT}`)
    console.log(`🔌 WebSocket: ws://localhost:${WS_PORT}`)
    return
  }

  for (const ip of localIPs) {
    console.log(`🌐 VRM Viewer: http://${ip}:${VITE_PORT}`)
    console.log(`🔌 WebSocket:  ws://${ip}:${WS_PORT}`)
  }
}

// Ensure cache dir
mkdirSync(AUDIO_CACHE_DIR, { recursive: true })

// --- Audio HTTP server ---
const audioServer = createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET')
  
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return }

  const match = req.url?.match(/^\/audio\/([a-f0-9-]+\.mp3)$/)
  if (!match) { res.writeHead(404); res.end('Not found'); return }

  const filePath = join(AUDIO_CACHE_DIR, match[1])
  if (!existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return }

  const data = readFileSync(filePath)
  res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store', 'Content-Length': data.length })
  res.end(data)
})

let actualAudioPort = AUDIO_PORT

// --- Bridge endpoint: POST /bridge/speak — push text to VRM for TTS + animation ---
// Used by OpenClaw main session to bridge replies to VRM
audioServer.on('request', (req: any, res: any) => {
  // Already handled by createServer callback above for /audio/ routes
})

const bridgeServer = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return }

  // POST /bridge/speak — push a reply to VRM with TTS
  if (req.method === 'POST' && req.url === '/bridge/speak') {
    let body = ''
    req.on('data', (chunk: string) => { body += chunk })
    req.on('end', async () => {
      try {
        const { text, audio_device, action_id: actionIdOverride, expression: expressionOverride, expression_weight: expressionWeightOverride } = JSON.parse(body)
        if (!text) { res.writeHead(400); res.end('Missing text'); return }

        await enqueueBridgeSpeak(async () => {
          const request_id = `bridge_${++bridgeRequestSeq}`
          console.log(`[bridge] Speaking: "${text.slice(0, 80)}..." (audio_device: ${audio_device || 'all'}, request: ${request_id})`)
          const inferred = pickAction(text)
          const action_id = typeof actionIdOverride === 'string' && actionIdOverride.trim() ? actionIdOverride.trim() : inferred.action_id
          const expression = typeof expressionOverride === 'string' && expressionOverride.trim() ? expressionOverride.trim() : inferred.expression
          const expression_weight = typeof expressionWeightOverride === 'number' ? expressionWeightOverride : inferred.expression_weight

          try {
            const audioUrl = await generateTTS(text)
            const msg: any = { type: 'speak_audio', request_id, audio_url: audioUrl, text, action_id, expression, expression_weight }
            if (audio_device) msg.audio_device = audio_device
            const msgStr = JSON.stringify(msg)
            for (const client of clients) {
              if (client.readyState === WebSocket.OPEN) client.send(msgStr)
            }
            const fallbackTimer = setTimeout(() => completeBridgeRequest(request_id), estimateBridgeSpeechMs(text))
            try {
              await waitForBridgeCompletion(request_id)
            } finally {
              clearTimeout(fallbackTimer)
            }
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: true, request_id, action_id, audio_url: audioUrl }))
          } catch (e: any) {
            const msg = JSON.stringify({ type: 'speak', request_id, text, action_id, expression, expression_weight })
            for (const client of clients) {
              if (client.readyState === WebSocket.OPEN) client.send(msg)
            }
            completeBridgeRequest(request_id)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: true, request_id, action_id, tts_error: e.message }))
          }
        })
      } catch (e: any) {
        res.writeHead(400)
        res.end(e.message)
      }
    })
    return
  }

  res.writeHead(404)
  res.end('Not found')
})

const BRIDGE_PORT = config.server?.bridgePort || 8867

bridgeServer.on('error', (err: any) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Bridge port ${BRIDGE_PORT} in use, trying ${BRIDGE_PORT + 1}...`)
    bridgeServer.listen(BRIDGE_PORT + 1, '0.0.0.0')
  } else {
    console.error('Bridge server error:', err)
  }
})

bridgeServer.listen(BRIDGE_PORT, '0.0.0.0', () => {
  console.log(`Bridge HTTP server on http://localhost:${BRIDGE_PORT}`)
})

audioServer.on('error', (err: any) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Port ${actualAudioPort} in use, trying ${actualAudioPort + 1}...`)
    actualAudioPort++
    audioServer.listen(actualAudioPort, '0.0.0.0')
  } else {
    console.error('Audio server error:', err)
  }
})

audioServer.listen(AUDIO_PORT, '0.0.0.0', () => {
  console.log(`Audio HTTP server on ${getAudioBaseURL()}`)
})

// --- TTS generation ---
async function synthesizeWithElevenLabs(text: string): Promise<Buffer> {
  if (!TTS.elevenlabs.apiKey) throw new Error('No ElevenLabs API key configured')

  const endpoint = `https://api.elevenlabs.io/v1/text-to-speech/${TTS.elevenlabs.voiceId}/stream`
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'xi-api-key': TTS.elevenlabs.apiKey,
      'accept': 'audio/mpeg',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      text: text.trim(),
      model_id: TTS.elevenlabs.model,
      voice_settings: { stability: 0.45, similarity_boost: 0.75 },
    }),
  })

  if (!resp.ok) {
    const body = await resp.text()
    throw new Error(`ElevenLabs error (${resp.status}): ${body.slice(0, 300)}`)
  }

  return Buffer.from(await resp.arrayBuffer())
}

async function synthesizeWithOpenAiCompatible(text: string): Promise<Buffer> {
  const endpoint = TTS.openaiCompatible.endpoint
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (TTS.openaiCompatible.apiKey) headers['Authorization'] = `Bearer ${TTS.openaiCompatible.apiKey}`
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: TTS.openaiCompatible.model,
      input: text.trim(),
      voice: TTS.openaiCompatible.voice,
      response_format: TTS.openaiCompatible.responseFormat,
    }),
  })

  if (!resp.ok) {
    const body = await resp.text()
    throw new Error(`OpenAI-compatible TTS error (${resp.status}): ${body.slice(0, 300)}`)
  }

  return Buffer.from(await resp.arrayBuffer())
}

async function writeAudioBuffer(buffer: Buffer): Promise<string> {
  const fileName = `${randomUUID()}.mp3`
  writeFileSync(join(AUDIO_CACHE_DIR, fileName), buffer)
  pruneCache()
  return `${getAudioBaseURL()}/audio/${fileName}`
}

async function generateTTS(text: string): Promise<string> {
  const buffer = TTS.provider === 'openai-compatible'
    ? await synthesizeWithOpenAiCompatible(text)
    : await synthesizeWithElevenLabs(text)
  return writeAudioBuffer(buffer)
}

function pruneCache() {
  try {
    const files = readdirSync(AUDIO_CACHE_DIR)
      .filter(f => f.endsWith('.mp3'))
      .map(f => ({ name: f, mtime: statSync(join(AUDIO_CACHE_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    for (const f of files.slice(MAX_CACHE_FILES)) {
      try { unlinkSync(join(AUDIO_CACHE_DIR, f.name)) } catch {}
    }
  } catch {}
}

// --- Streaming Gateway + TTS Pipeline ---

/**
 * Quick acknowledgment phrases — played immediately while Gateway processes tools.
 * Gives instant feedback so user doesn't wait 5-15s in silence.
 */
const ACK_PHRASES_ZH = [
  '让我看看～', '我查一下哦～', '稍等一下～', '嗯，让我想想…', '好的，等我一下～',
]
const ACK_PHRASES_EN = [
  "Let me check~", "One sec~", "Hmm, let me look...", "Sure, give me a moment~",
]

function pickAckPhrase(text: string): string {
  const isChinese = /[\u4e00-\u9fff]/.test(text)
  const phrases = isChinese ? ACK_PHRASES_ZH : ACK_PHRASES_EN
  return phrases[Math.floor(Math.random() * phrases.length)]
}

/**
 * Stream tokens from OpenClaw Gateway (SSE).
 * Yields individual content tokens as they arrive.
 */
async function* streamFromGateway(
  messages: Array<{ role: string; content: string }>,
  sessionKey: string = 'vrm-chat',
): AsyncGenerator<string> {
  const resp = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GATEWAY_TOKEN}`,
      'x-openclaw-agent-id': 'main',
      'x-openclaw-session-key': sessionKey,
    },
    body: JSON.stringify({ model: 'openclaw', stream: true, messages }),
  })
  if (!resp.ok) {
    const body = await resp.text()
    console.warn(`[gateway] chat backend unavailable (${resp.status}): ${body.slice(0, 200)}`)
    yield "The integrated chat backend is unavailable right now. Annie's avatar shell still works, but chat and voice input are temporarily disabled until the gateway integration is fixed."
    return
  }

  const reader = resp.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() || ''
    for (const line of lines) {
      if (!line.startsWith('data: ') || line === 'data: [DONE]') continue
      try {
        const json = JSON.parse(line.slice(6))
        const token = json.choices?.[0]?.delta?.content
        if (token) yield token
      } catch {}
    }
  }
}

/**
 * Split streaming tokens into complete sentences for TTS.
 */
async function* sentenceSplitter(tokens: AsyncGenerator<string>): AsyncGenerator<string> {
  let buffer = ''
  // Include ～ ，、；：— … and other natural Chinese break points
  // This is critical: "让我查一下～" must be emitted IMMEDIATELY so TTS can start
  // while the tool call executes in the background
  const enders = /[。！？.!?\n～〜；;：…—]/

  for await (const token of tokens) {
    buffer += token
    const match = buffer.match(enders)
    if (match && match.index !== undefined) {
      const idx = match.index + 1
      const sentence = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx)
      if (sentence.length >= 2) yield sentence + ' '  // skip single-char fragments
    }
  }
  if (buffer.trim()) yield buffer.trim()
}

/**
 * Streaming TTS: feeds sentence chunks to ElevenLabs WebSocket API,
 * collects MP3 audio, saves to cache, returns URL.
 * Starts generating audio as soon as the first sentence arrives.
 */
async function streamingTTS(sentences: AsyncIterable<string>): Promise<{ audioUrl: string; firstChunkMs: number }> {
  if (TTS.provider === 'openai-compatible') {
    const startTime = Date.now()
    const allTextParts: string[] = []
    for await (const sentence of sentences) allTextParts.push(sentence)
    const fullText = allTextParts.join('').trim()
    if (!fullText) throw new Error('No text to synthesize')
    const audioUrl = await generateTTS(fullText)
    return { audioUrl, firstChunkMs: Date.now() - startTime }
  }

  return new Promise(async (resolve, reject) => {
    const audioBuffers: Buffer[] = []
    let firstChunkTime: number | null = null
    const startTime = Date.now()
    let resolved = false

    const wsUrl = `wss://api.elevenlabs.io/v1/text-to-speech/${TTS.elevenlabs.voiceId}/stream-input?model_id=${TTS.elevenlabs.model}&output_format=mp3_44100_128`
    const elWs = new WebSocket(wsUrl)

    elWs.on('open', async () => {
      elWs.send(JSON.stringify({
        text: ' ',
        voice_settings: { stability: 0.45, similarity_boost: 0.75 },
        xi_api_key: TTS.elevenlabs.apiKey,
      }))

      for await (const sentence of sentences) {
        if (elWs.readyState === WebSocket.OPEN) {
          elWs.send(JSON.stringify({ text: sentence }))
        }
      }

      if (elWs.readyState === WebSocket.OPEN) {
        elWs.send(JSON.stringify({ text: '' }))
      }
    })

    elWs.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.audio) {
          const buf = Buffer.from(msg.audio, 'base64')
          audioBuffers.push(buf)
          if (!firstChunkTime) {
            firstChunkTime = Date.now()
            console.log(`[streaming-tts] First audio chunk: ${firstChunkTime - startTime}ms`)
          }
        }
        if (msg.isFinal) elWs.close()
      } catch {}
    })

    elWs.on('close', async () => {
      if (resolved) return
      resolved = true
      if (audioBuffers.length === 0) { reject(new Error('No audio from ElevenLabs')); return }
      try {
        const audioUrl = await writeAudioBuffer(Buffer.concat(audioBuffers))
        resolve({ audioUrl, firstChunkMs: (firstChunkTime || Date.now()) - startTime })
      } catch (err) {
        reject(err)
      }
    })

    elWs.on('error', (err) => { if (!resolved) { resolved = true; reject(err) } })
  })
}

/**
 * Two-phase streaming pipeline for tool-call scenarios.
 *
 * When the sentence splitter emits the first sentence (e.g. "让我查一下～")
 * and then the next sentence takes >GAP_THRESHOLD_MS (tool call gap), we:
 * 1. Immediately TTS the first sentence and broadcast it (ack phase)
 * 2. Collect the remaining sentences, TTS them, and broadcast (main phase)
 *
 * For simple chats (no gap), everything goes through as one broadcast.
 */
const GAP_THRESHOLD_MS = 1500

async function twoPhaseStreamingPipeline(
  messages: Array<{ role: string; content: any }>,
  sessionKey: string = 'vrm-chat',
  broadcastFn: (audioUrl: string, text: string, isAck: boolean) => void,
): Promise<{ text: string; audioUrl: string; firstAudioMs: number; ackSent: boolean }> {
  // Prepend voice-mode system prompt
  messages = [{ role: 'system', content: getVoiceSystemPrompt() }, ...messages]
  const startTime = Date.now()
  let ackSent = false

  // Collect sentences with timestamps
  const sentenceQueue: Array<{ text: string; time: number }> = []
  let allDone = false

  // Start Gateway streaming
  const tokenStream = streamFromGateway(messages, sessionKey)
  const sentenceStream = sentenceSplitter(tokenStream)

  // Consume sentences into a queue
  ;(async () => {
    for await (const sentence of sentenceStream) {
      sentenceQueue.push({ text: sentence, time: Date.now() })
    }
    allDone = true
  })()

  // Wait for first sentence
  while (sentenceQueue.length === 0 && !allDone) {
    await new Promise(r => setTimeout(r, 50))
  }

  if (sentenceQueue.length === 0) {
    throw new Error('No sentences from Gateway')
  }

  const firstSentence = sentenceQueue[0]
  const firstSentenceMs = firstSentence.time - startTime
  console.log(`[two-phase] First sentence at ${firstSentenceMs}ms: "${firstSentence.text.slice(0, 40)}"`)

  // Wait up to GAP_THRESHOLD_MS for a second sentence
  const gapStart = Date.now()
  while (sentenceQueue.length <= 1 && !allDone && (Date.now() - gapStart) < GAP_THRESHOLD_MS) {
    await new Promise(r => setTimeout(r, 50))
  }

  const hasGap = sentenceQueue.length <= 1 && !allDone
  let fullText = ''
  let finalAudioUrl = ''

  if (hasGap) {
    // TOOL CALL DETECTED: long gap after first sentence
    // Phase 1: immediately TTS and broadcast the first sentence
    console.log(`[two-phase] Gap detected (>${GAP_THRESHOLD_MS}ms) — broadcasting ack: "${firstSentence.text.slice(0, 40)}"`)
    try {
      const ackAudioUrl = await generateTTS(firstSentence.text)
      broadcastFn(ackAudioUrl, firstSentence.text, true)
      ackSent = true
      console.log(`[two-phase] Ack broadcast at ${Date.now() - startTime}ms`)
    } catch (e: any) {
      console.error(`[two-phase] Ack TTS failed: ${e.message}`)
    }

    // Phase 2: wait for remaining sentences, TTS, and broadcast
    while (!allDone) {
      await new Promise(r => setTimeout(r, 100))
    }

    // Collect all text
    fullText = sentenceQueue.map(s => s.text).join('')

    // TTS the remaining sentences (skip first which was already ack'd)
    const remainingSentences = sentenceQueue.slice(1).map(s => s.text).join('')
    if (remainingSentences.trim()) {
      finalAudioUrl = await generateTTS(remainingSentences)
    } else {
      // Only had the ack sentence
      finalAudioUrl = await generateTTS(fullText)
    }
  } else {
    // NO GAP: simple chat, one-shot TTS
    while (!allDone) {
      await new Promise(r => setTimeout(r, 100))
    }
    fullText = sentenceQueue.map(s => s.text).join('')
    // Use streaming TTS for better performance
    async function* sentenceTexts() {
      for (const s of sentenceQueue) yield s.text
    }
    const result = await streamingTTS(sentenceTexts())
    finalAudioUrl = result.audioUrl
  }

  const totalMs = Date.now() - startTime
  console.log(`[two-phase] Complete in ${totalMs}ms, ack: ${ackSent}, text: "${fullText.slice(0, 80)}..."`)

  return { text: fullText, audioUrl: finalAudioUrl, firstAudioMs: firstSentenceMs, ackSent }
}

/**
 * ─────────────────────────────────────────────────────────────────────
 * Streaming Audio Pipeline (voice / chat mode ONLY)
 *
 * Optimisations vs the batch pipeline:
 *  1. Tokens fed DIRECTLY to ElevenLabs WS (no sentence splitting)
 *  2. ElevenLabs WS pre-warmed in parallel with Gateway fetch
 *  3. Audio chunks forwarded to browser clients immediately (no file I/O)
 *  4. No gap detection / 1 500 ms wait
 *
 * The browser client plays chunks via MediaSource Extensions for
 * near-zero buffering delay and real-time lip-sync.
 * ─────────────────────────────────────────────────────────────────────
 */
async function streamingAudioPipeline(
  messages: Array<{ role: string; content: any }>,
  sessionKey: string,
  broadcastToClients: (msg: any) => void,
): Promise<{ text: string; firstChunkMs: number }> {
  messages = [{ role: 'system', content: getVoiceSystemPrompt() }, ...messages]
  const startTime = Date.now()
  const sid = randomUUID()
  let fullText = ''
  let firstChunkMs = 0
  let chunkIndex = 0
  let audioStartSent = false

  if (TTS.provider === 'openai-compatible') {
    const gwResp = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GATEWAY_TOKEN}`,
        'x-openclaw-agent-id': 'main',
        'x-openclaw-session-key': sessionKey,
      },
      body: JSON.stringify({ model: 'openclaw', stream: true, messages }),
    })

    if (!gwResp.ok) {
      throw new Error(`Gateway ${gwResp.status}: ${(await gwResp.text()).slice(0, 200)}`)
    }

    const reader = gwResp.body!.getReader()
    const dec = new TextDecoder()
    let buf = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const lines = buf.split('\n'); buf = lines.pop() || ''
      for (const line of lines) {
        if (!line.startsWith('data: ') || line === 'data: [DONE]') continue
        try {
          const token = JSON.parse(line.slice(6)).choices?.[0]?.delta?.content
          if (token) fullText += token
        } catch {}
      }
    }

    if (/^(NO_REPLY|HEARTBEAT_OK)\s*$/i.test(fullText.trim())) {
      console.log('[stream-audio] Response is NO_REPLY — suppressing')
      return { text: fullText, firstChunkMs }
    }

    const { action_id, expression, expression_weight } = pickAction(fullText || '…')
    broadcastToClients({
      type: 'audio_start', session_id: sid,
      action_id, expression, expression_weight,
      text: fullText,
    })

    const audioUrl = await generateTTS(fullText)
    firstChunkMs = Date.now() - startTime
    broadcastToClients({ type: 'audio_end', session_id: sid, text: fullText, audio_url: audioUrl })
    const totalMs = Date.now() - startTime
    console.log(`[stream-audio] Batch mode done in ${totalMs}ms (first audio: ${firstChunkMs}ms): "${fullText.slice(0, 80)}"`)
    return { text: fullText, firstChunkMs }
  }

  /* ── 1. Pre-warm ElevenLabs WS ── */
  const elReady = new Promise<WebSocket>((resolve, reject) => {
    const url = `wss://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream-input?model_id=${MODEL_ID}&output_format=mp3_44100_128`
    const ws = new WebSocket(url)
    ws.on('open', () => {
      ws.send(JSON.stringify({
        text: ' ',
        voice_settings: { stability: 0.45, similarity_boost: 0.75 },
        // Lower chunk_length_schedule for faster first-audio in voice chat
        generation_config: { chunk_length_schedule: [50, 80, 120, 160] },
        xi_api_key: API_KEY,
      }))
      resolve(ws)
    })
    ws.on('error', reject)
    setTimeout(() => reject(new Error('ElevenLabs WS connect timeout')), 8000)
  })

  /* ── 2. Start Gateway SSE in parallel ── */
  const gwResp = fetch(`http://127.0.0.1:${GATEWAY_PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GATEWAY_TOKEN}`,
      'x-openclaw-agent-id': 'main',
      'x-openclaw-session-key': sessionKey,
    },
    body: JSON.stringify({ model: 'openclaw', stream: true, messages }),
  })

  const [elWs, resp] = await Promise.all([elReady, gwResp])

  if (!resp.ok) {
    elWs.close()
    throw new Error(`Gateway ${resp.status}: ${(await resp.text()).slice(0, 200)}`)
  }

  /* ── 3. Forward ElevenLabs audio → clients ── */
  const elDone = new Promise<void>((resolve) => {
    elWs.on('message', (raw: Buffer | string) => {
      try {
        const msg = JSON.parse(raw.toString())
        if (msg.audio) {
          // Send audio_start before first chunk
          if (!audioStartSent) {
            const { action_id, expression, expression_weight } = pickAction(fullText || '…')
            broadcastToClients({
              type: 'audio_start', session_id: sid,
              action_id, expression, expression_weight,
              text: fullText,
            })
            audioStartSent = true
          }
          if (chunkIndex === 0) {
            firstChunkMs = Date.now() - startTime
            console.log(`[stream-audio] First audio chunk at ${firstChunkMs}ms`)
          }
          broadcastToClients({
            type: 'audio_chunk', audio: msg.audio,
            index: chunkIndex++, session_id: sid,
          })
        }
        if (msg.isFinal) elWs.close()
      } catch {}
    })
    elWs.on('close', resolve)
    elWs.on('error', () => resolve())
    setTimeout(resolve, 60_000) // safety
  })

  /* ── 4. Read Gateway tokens → batch & feed ElevenLabs ── */
  //
  // Token batching + gap-triggered generation:
  //  • Accumulate tokens in a small buffer
  //  • Flush to ElevenLabs every BATCH_MS or when punctuation seen
  //  • If no tokens arrive for GAP_TRIGGER_MS, send try_trigger_generation
  //    so ElevenLabs renders whatever it has (critical for tool-call gaps)
  //
  const BATCH_MS = 80       // max time to buffer tokens before sending
  const GAP_TRIGGER_MS = 400 // gap without tokens → force audio generation

  let tokenBuf = ''
  let gapTimer: ReturnType<typeof setTimeout> | null = null
  let batchTimer: ReturnType<typeof setTimeout> | null = null
  const PUNCT = /[。！？.!?\n～〜；;：…—，、]/

  const sendToEL = (text: string, trigger: boolean) => {
    if (!text || elWs.readyState !== WebSocket.OPEN) return
    const msg: any = { text }
    if (trigger) msg.try_trigger_generation = true
    elWs.send(JSON.stringify(msg))
  }

  const flushBatch = (trigger: boolean) => {
    if (batchTimer) { clearTimeout(batchTimer); batchTimer = null }
    if (tokenBuf) {
      sendToEL(tokenBuf, trigger)
      tokenBuf = ''
    }
  }

  const reader = resp.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n'); buf = lines.pop() || ''
    for (const line of lines) {
      if (!line.startsWith('data: ') || line === 'data: [DONE]') continue
      try {
        const token = JSON.parse(line.slice(6)).choices?.[0]?.delta?.content
        if (token) {
          fullText += token
          tokenBuf += token

          // Reset gap timer every time a token arrives
          if (gapTimer) clearTimeout(gapTimer)
          gapTimer = setTimeout(() => {
            flushBatch(true)
            // Force ElevenLabs to generate audio from whatever it has buffered
            if (elWs.readyState === WebSocket.OPEN) {
              elWs.send(JSON.stringify({ text: '', flush: true }))
              console.log(`[stream-audio] gap flush @${Date.now() - startTime}ms`)
            }
          }, GAP_TRIGGER_MS)

          // Flush immediately on sentence-ending punctuation (with trigger + flush)
          if (PUNCT.test(token)) {
            flushBatch(true)
            if (elWs.readyState === WebSocket.OPEN) {
              elWs.send(JSON.stringify({ text: '', flush: true }))
            }
          } else if (!batchTimer) {
            // Otherwise batch up to BATCH_MS
            batchTimer = setTimeout(() => flushBatch(false), BATCH_MS)
          }
        }
      } catch {}
    }
  }

  // Flush anything left
  flushBatch(true)
  if (gapTimer) clearTimeout(gapTimer)

  // Signal end-of-text to ElevenLabs
  if (elWs.readyState === WebSocket.OPEN) {
    elWs.send(JSON.stringify({ text: '' }))
  }

  await elDone

  // Abort if model returned a no-op
  if (/^(NO_REPLY|HEARTBEAT_OK)\s*$/i.test(fullText.trim())) {
    console.log('[stream-audio] Response is NO_REPLY — suppressing')
    return { text: fullText, firstChunkMs }
  }

  broadcastToClients({ type: 'audio_end', session_id: sid, text: fullText })
  const totalMs = Date.now() - startTime
  console.log(`[stream-audio] Done in ${totalMs}ms (${chunkIndex} chunks, first: ${firstChunkMs}ms): "${fullText.slice(0, 80)}"`)
  return { text: fullText, firstChunkMs }
}

/**
 * Voice-mode system prompt: instructs the model to always speak a brief
 * acknowledgment BEFORE calling any tool. This ensures the SSE stream
 * emits tokens immediately, eliminating silent gaps during tool execution.
 */
const VOICE_SYSTEM_PROMPT_BASE = `You are in VOICE MODE — your response will be spoken aloud via TTS.
Critical rules:
1. ALWAYS say a brief phrase BEFORE using any tool (e.g. "让我看看～", "我查一下哦"). This gives immediate audio feedback.
2. NO markdown (**bold**, # headers, | tables, \`code\`, - bullets). TTS reads these literally and it sounds terrible.
3. Keep it SHORT — 2-4 sentences max unless asked for detail. This is a conversation, not an essay.
4. Speak naturally, like talking to a friend. No emoji, no URLs.
5. Use your multimodal memory to be proactive — if you notice something changed or remember a preference, mention it naturally.
6. Never tell users to manually send WebSocket/gateway JSON commands. If they ask for device speech routing, treat it as an execution request.
7. Never guess network topology. Do not claim local-vs-relay connection facts unless those facts were explicitly provided in authoritative context.`

/**
 * Build voice system prompt with dynamic multimodal memory context.
 */
function getVoiceSystemPrompt(): string {
  const memoryContext = multimodalMemory.buildContextForAI()
  if (!memoryContext || memoryContext.length < 20) return VOICE_SYSTEM_PROMPT_BASE

  return `${VOICE_SYSTEM_PROMPT_BASE}

--- Multimodal Memory ---
${memoryContext}
--- End Memory ---`
}

// Keep a static reference for backward compatibility
const VOICE_SYSTEM_PROMPT = VOICE_SYSTEM_PROMPT_BASE

/**
 * Full streaming pipeline with voice-mode system prompt.
 * 
 * The voice system prompt ensures the model always says something before
 * tool calls, so the SSE stream produces tokens immediately instead of
 * going silent for 5-15s during tool execution.
 * 
 * Fallback: if first token still takes >ACK_THRESHOLD_MS, send a hardcoded ack.
 */
const ACK_THRESHOLD_MS = 3000  // Raised since model should now ack naturally

async function streamingPipeline(
  messages: Array<{ role: string; content: string }>,
  sessionKey: string = 'vrm-chat',
  opts?: { broadcastAck?: (audioUrl: string, text: string) => void; inputText?: string },
): Promise<{ text: string; audioUrl: string; firstChunkMs: number; ackSent: boolean }> {
  // Prepend voice-mode system prompt
  messages = [{ role: 'system', content: getVoiceSystemPrompt() }, ...messages]
  let fullText = ''
  let ackSent = false

  // Race: first token vs ack timeout
  const tokenIterator = streamFromGateway(messages, sessionKey)
  const firstResult = await Promise.race([
    tokenIterator.next(),
    new Promise<'timeout'>(r => setTimeout(() => r('timeout'), ACK_THRESHOLD_MS)),
  ])

  if (firstResult === 'timeout' && opts?.broadcastAck) {
    // Gateway is slow (likely tool call) — send ack immediately
    const ackText = pickAckPhrase(opts.inputText || '')
    try {
      const ackAudioUrl = await generateTTS(ackText)
      opts.broadcastAck(ackAudioUrl, ackText)
      ackSent = true
      console.log(`[streaming] Ack sent: "${ackText}"`)
    } catch (e: any) {
      console.error(`[streaming] Ack TTS failed: ${e.message}`)
    }
  }

  // Now collect all tokens (including the first if we got it from the race)
  async function* allTokens() {
    if (firstResult !== 'timeout') {
      const r = firstResult as IteratorResult<string>
      if (!r.done && r.value) {
        fullText += r.value
        yield r.value
      }
      if (r.done) return
    }
    for await (const token of tokenIterator) {
      fullText += token
      yield token
    }
  }

  const sentences = sentenceSplitter(allTokens())
  const { audioUrl, firstChunkMs } = await streamingTTS(sentences)

  return { text: fullText.trim(), audioUrl, firstChunkMs, ackSent }
}

// --- OpenClaw Agent Integration ---
const GATEWAY_PORT = config.openclaw?.gatewayPort || 18789
const GATEWAY_TOKEN = (() => {
  try {
    const configPath = join(process.env.HOME || '', '.openclaw', 'openclaw.json')
    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    return config?.gateway?.auth?.token || ''
  } catch { return '' }
})()

// Simple action picker based on text sentiment
function pickAction(text: string): { action_id: string, expression: string, expression_weight: number } {
  const lower = text.toLowerCase()
  if (lower.match(/\b(haha|lol|funny|laugh|😂|😄)\b/)) return { action_id: '125_Laughing', expression: 'happy', expression_weight: 0.9 }
  if (lower.match(/\b(hi|hello|hey|greet|welcome)\b/)) return { action_id: '161_Waving', expression: 'happy', expression_weight: 0.7 }
  if (lower.match(/\b(yes|yeah|sure|agree|ok|okay|right)\b/)) return { action_id: '118_Head Nod Yes', expression: 'happy', expression_weight: 0.6 }
  if (lower.match(/\b(no|nope|disagree|don't)\b/)) return { action_id: '144_Shaking Head No', expression: 'neutral', expression_weight: 0.5 }
  if (lower.match(/\b(sad|sorry|bad|unfortunately)\b/)) return { action_id: '142_Sad Idle', expression: 'sad', expression_weight: 0.7 }
  if (lower.match(/\b(think|hmm|consider|maybe|probably)\b/)) return { action_id: '88_Thinking', expression: 'neutral', expression_weight: 0.5 }
  if (lower.match(/\b(thank|thanks|appreciate|grateful)\b/)) return { action_id: '156_Thankful', expression: 'happy', expression_weight: 0.8 }
  if (lower.match(/\b(wow|amazing|awesome|incredible|cool)\b/)) return { action_id: '116_Happy Hand Gesture', expression: 'surprised', expression_weight: 0.8 }
  if (lower.match(/\b(dance|party|celebrate)\b/)) return { action_id: '54_Macarena Dance', expression: 'happy', expression_weight: 0.9 }
  if (lower.match(/\b(shrug|dunno|idk|whatever)\b/)) return { action_id: '145_Shrugging', expression: 'neutral', expression_weight: 0.5 }
  // Default: talking gesture
  return { action_id: '86_Talking', expression: 'happy', expression_weight: 0.5 }
}

type RelaySpeakType = 'speak' | 'speak_audio' | 'tts_audio'

interface DirectRelaySpeakCommand {
  type: RelaySpeakType
  text: string
  targets: string[]
}

interface DirectRelayDispatchResult {
  command: DirectRelaySpeakCommand
  resolvedType: RelaySpeakType
}

function normalizeRouteTarget(raw: string): string | null {
  const token = raw.trim().toLowerCase()
  if (!token) return null

  const aliases: Record<string, string> = {
    iphone: 'iphone',
    ipad: 'ipad',
    ios: 'ios',
    mobile: 'mobile',
    mac: 'mac',
    macos: 'macos',
    macbook: 'macbook',
    desktop: 'desktop',
    watch: 'watch',
    watchos: 'watchos',
    applewatch: 'applewatch',
    wearable: 'wearable',
    meeting: 'meeting',
    all: 'all',
    any: 'all',
    everyone: 'all',
    broadcast: 'all',
    '*': 'all',
  }
  if (aliases[token]) return aliases[token]

  // Allow explicit device IDs like ios-xxxx / web-xxxx / custom IDs.
  if (/^[a-z0-9._:-]{1,128}$/i.test(token)) {
    return token
  }
  return null
}

function extractQuotedText(input: string): string | null {
  const patterns = [
    /"([^"]+)"/,
    /“([^”]+)”/,
    /'([^']+)'/,
    /‘([^’]+)’/,
    /「([^」]+)」/,
  ]
  for (const pattern of patterns) {
    const match = input.match(pattern)
    if (match?.[1]?.trim()) {
      return match[1].trim()
    }
  }
  return null
}

function parseDirectRelaySpeakCommand(input: string): DirectRelaySpeakCommand | null {
  const text = input.trim()
  if (!text) return null

  const explicitCommand = /^\/(?:relay_?speak|gateway_?speak)\b/i.test(text)
  const hasDispatchIntent = /(send|dispatch|push|发|发送|下发|推送)/i.test(text)
  const hasTransportHint = /(gateway|relay|websocket|ws|后端)/i.test(text)
  const hasSpeakHint = /(speak_audio|tts_audio|\bspeak\b|语音|说话|朗读)/i.test(text)

  if (!explicitCommand && !(hasDispatchIntent && hasTransportHint && hasSpeakHint)) {
    return null
  }

  let type: RelaySpeakType = 'speak'
  if (/tts_audio/i.test(text)) type = 'tts_audio'
  else if (/speak_audio/i.test(text)) type = 'speak_audio'

  const targets: string[] = []

  // Parse explicit targets=.../devices=... without swallowing the next key (e.g. text=...).
  // Examples:
  //   targets=iphone
  //   targets=iphone,ipad,mac
  //   devices=ios
  const targetsArg = text.match(
    /(?:targets?|devices?)\s*[=:]\s*([a-z0-9._:*\-]+(?:\s*[,;]\s*[a-z0-9._:*\-]+)*)/i,
  )?.[1]
  if (targetsArg) {
    for (const item of targetsArg.split(/[,\s;]+/)) {
      const normalized = normalizeRouteTarget(item)
      if (normalized) targets.push(normalized)
    }
  } else {
    const namedTargets: Array<[RegExp, string]> = [
      [/\biphone\b/i, 'iphone'],
      [/\bipad\b/i, 'ipad'],
      [/\bios\b/i, 'ios'],
      [/\bmacos\b/i, 'macos'],
      [/\bmacbook\b/i, 'macbook'],
      [/\bmac\b/i, 'mac'],
      [/\bwatchos\b/i, 'watchos'],
      [/\bapple\s*watch\b/i, 'applewatch'],
      [/\bwatch\b/i, 'watch'],
      [/\bmeeting\b/i, 'meeting'],
      [/\b(all|broadcast|everyone|any)\b/i, 'all'],
      [/(全部|所有|全体)/, 'all'],
    ]
    for (const [pattern, target] of namedTargets) {
      if (pattern.test(text)) {
        targets.push(target)
      }
    }
  }

  let commandText = text.match(/(?:text|content|内容)\s*[=:]\s*(.+)$/i)?.[1]?.trim() || ''
  if (!commandText) {
    commandText = extractQuotedText(text) || ''
  }
  if (!commandText) {
    const colonIndex = text.search(/[:：]/)
    if (colonIndex >= 0 && colonIndex < text.length - 1) {
      commandText = text.slice(colonIndex + 1).trim()
    }
  }
  if (!commandText) {
    return null
  }

  commandText = commandText.replace(/^["“'‘「]+|["”'’」]+$/g, '').trim()
  if (!commandText) {
    return null
  }

  const uniqueTargets = Array.from(new Set(targets.map(normalizeRouteTarget).filter((v): v is string => !!v)))
  return {
    type,
    text: commandText,
    targets: uniqueTargets,
  }
}

function hasExplicitRoutingFields(msg: Record<string, any>): boolean {
  return (
    msg.audio_device !== undefined
    || msg.audio_devices !== undefined
    || msg.target_device !== undefined
    || msg.target_devices !== undefined
    || msg.reply_device !== undefined
    || msg.request_device !== undefined
  )
}

function shouldBroadcastMotionSync(msg: Record<string, any>): boolean {
  const type = typeof msg.type === 'string' ? msg.type.trim().toLowerCase() : ''
  return type === 'speak' || type === 'speak_audio' || type === 'tts_audio' || type === 'audio_start'
}

function extractMotionSyncPayload(msg: Record<string, any>): Record<string, any> | null {
  const actionIdRaw =
    (typeof msg.action_id === 'string' && msg.action_id)
    || (typeof msg.actionId === 'string' && msg.actionId)
    || ''
  const expressionRaw =
    (typeof msg.expression === 'string' && msg.expression)
    || ''

  const actionId = actionIdRaw.trim()
  const expression = expressionRaw.trim()
  const expressionWeight =
    coerceNumber(msg.expression_weight)
    ?? coerceNumber(msg.expressionWeight)

  if (!actionId && !expression) return null

  const payload: Record<string, any> = {}
  if (actionId) payload.actionId = actionId
  if (typeof msg.loop === 'boolean') payload.loop = msg.loop
  if (typeof msg.category === 'string' && msg.category.trim()) {
    payload.category = msg.category.trim()
  }
  if (expression) payload.expression = expression
  if (expressionWeight !== null) payload.expressionWeight = expressionWeight
  return payload
}

function stripMotionFields(msg: Record<string, any>) {
  delete msg.action_id
  delete msg.actionId
  delete msg.loop
  delete msg.category
  delete msg.expression
  delete msg.expression_weight
  delete msg.expressionWeight
}

function broadcastMotionSync(payload: Record<string, any>) {
  broadcastJSONToClients({
    type: 'sync',
    category: 'action',
    payload,
    origin: 'backend',
    ts: Date.now(),
    backend_version: backendSyncState.version,
  })
}

async function dispatchDirectRelaySpeakCommand(
  command: DirectRelaySpeakCommand,
  broadcast: (msg: Record<string, any>) => void,
): Promise<DirectRelayDispatchResult> {
  const { action_id, expression, expression_weight } = pickAction(command.text)
  const payload: Record<string, any> = {
    type: command.type,
    text: command.text,
    action_id,
    expression,
    expression_weight,
  }

  let resolvedType: RelaySpeakType = command.type
  if (command.type === 'speak_audio' || command.type === 'tts_audio') {
    try {
      payload.audio_url = await generateTTS(command.text)
    } catch (error: any) {
      // Gracefully degrade to text-only speak if TTS fails.
      resolvedType = 'speak'
      payload.type = 'speak'
      console.error(`[direct-relay] TTS failed, falling back to speak: ${error?.message || error}`)
    }
  }

  const explicitTargets = command.targets.filter((target) => target !== 'all')
  const wantsBroadcast = command.targets.includes('all')
  if (!wantsBroadcast) {
    if (explicitTargets.length === 1) {
      payload.audio_device = explicitTargets[0]
    } else if (explicitTargets.length > 1) {
      payload.audio_devices = explicitTargets
    }
  }

  broadcast(payload)
  return { command, resolvedType }
}

function summarizeRouteTargets(targets: string[]): string {
  if (targets.length === 0) return 'current device'
  if (targets.includes('all')) return 'all devices'
  return targets.join(', ')
}

async function askOpenClaw(
  userText: string,
  sessionId: string = config.openclaw?.sessionId || 'vrm-chat',
): Promise<string> {
  // Use CLI with --json and strip any non-JSON output
  const { execSync } = await import('child_process')
  try {
    const result = execSync(
      `openclaw agent --message ${JSON.stringify(userText)} --json --session-id ${JSON.stringify(sessionId)} 2>/dev/null`,
      { encoding: 'utf-8', timeout: 120000 }
    )
    // Strip CLI UI decorations, find the main JSON object
    // The output has "│ ◇ Config warnings ..." before the JSON
    const lines = result.split('\n')
    let jsonStr = ''
    let braceDepth = 0
    let inJson = false
    for (const line of lines) {
      if (!inJson && line.trim().startsWith('{')) {
        inJson = true
      }
      if (inJson) {
        jsonStr += line + '\n'
        for (const ch of line) {
          if (ch === '{') braceDepth++
          if (ch === '}') braceDepth--
        }
        if (braceDepth <= 0 && inJson) break
      }
    }
    if (jsonStr) {
      const parsed = JSON.parse(jsonStr)
      // OpenClaw agent output: result.payloads[0].text
      const payloadText = parsed?.result?.payloads?.[0]?.text
      if (payloadText) return payloadText
      return parsed?.reply || parsed?.text || parsed?.message || 'Hmm?'
    }
    return 'I couldn\'t process that.'
  } catch (e: any) {
    console.error('CLI error:', e.message)
    // Last resort: try gateway HTTP API
    try {
      const resp = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/api/agent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${GATEWAY_TOKEN}`,
        },
        body: JSON.stringify({
          message: userText,
          session: sessionId,
          channel: 'webchat',
        }),
      })
      if (resp.ok) {
        const data = await resp.json() as Record<string, unknown>
        return (data?.reply || data?.text || data?.message || 'I couldn\'t process that.') as string
      }
    } catch {}
    throw e
  }
}

interface VisualMemoryPromptEntry {
  id: string
  timestamp: string
  description: string
  tags: string[]
  thumbnailPath: string
  score: number
}

function formatVisualMemoryTimestamp(timestamp: string): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return timestamp
  return date
    .toLocaleString('en-US', {
      timeZone: 'America/New_York',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
    .replace(',', '')
}

function buildVisualMemoryContext(
  visualResults: VisualSearchResult[],
  visionResults: VisionSearchResult[],
  limit: number = 5,
): string {
  const merged: VisualMemoryPromptEntry[] = []

  for (const result of visualResults) {
    merged.push({
      id: result.id,
      timestamp: result.timestamp,
      description: result.description,
      tags: Array.isArray(result.tags) ? result.tags : [],
      thumbnailPath: result.thumbnailPath,
      score: result.relevanceScore,
    })
  }

  for (const result of visionResults) {
    merged.push({
      id: result.id,
      timestamp: result.record.timestamp,
      description: result.record.description,
      tags: Array.isArray(result.record.tags) ? result.record.tags : [],
      thumbnailPath: result.thumbnailPath,
      score: result.score,
    })
  }

  if (merged.length === 0) return ''

  const deduped = new Map<string, VisualMemoryPromptEntry>()
  for (const item of merged) {
    const key = `${item.thumbnailPath}|${item.description}`
    const existing = deduped.get(key)
    if (!existing || item.score > existing.score) {
      deduped.set(key, item)
    }
  }

  const topResults = Array.from(deduped.values())
    .sort((a, b) => b.score - a.score || b.timestamp.localeCompare(a.timestamp))
    .slice(0, Math.max(1, limit))

  if (topResults.length === 0) return ''

  const lines: string[] = ['[Visual Memory]']
  for (const item of topResults) {
    const time = formatVisualMemoryTimestamp(item.timestamp)
    const tags = item.tags.length > 0 ? item.tags.join(', ') : 'none'
    lines.push(`#${item.id} ${time} — ${item.description} [tags: ${tags}] (thumbnail: ${item.thumbnailPath})`)
  }
  lines.push('')
  lines.push('If you need to see a specific image, use the image tool with the thumbnail path above.')

  return lines.join('\n')
}

type ConversationLanguage = 'zh' | 'en'

interface DeviceConversationState {
  lastSpeechAt: number
  lastLanguage: ConversationLanguage
}

const DUPLICATE_USER_SPEECH_WINDOW_MS = 1800
const USER_SPEECH_SIGNATURE_TTL_MS = 60_000
const CONVERSATION_GREETING_RESET_MS = 12 * 60 * 1000
const CONVERSATION_LANGUAGE_MEMORY_MS = 6 * 60 * 60 * 1000

const recentUserSpeechSignatures = new Map<string, number>()
const conversationStateByDevice = new Map<string, DeviceConversationState>()
let globalConversationLanguage: ConversationLanguage = 'en'

function resolveSourceDeviceKey(sourceDevice: string | undefined, senderWs: WebSocket): string {
  const candidate = typeof sourceDevice === 'string' ? sourceDevice.trim() : ''
  if (candidate) return candidate
  return findDeviceIdByWs(senderWs) || 'unknown'
}

function normalizeSpeechTextForDedup(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

function shouldDropDuplicateUserSpeech(text: string, sourceDeviceKey: string, now: number): boolean {
  for (const [signature, timestamp] of recentUserSpeechSignatures) {
    if (now - timestamp > USER_SPEECH_SIGNATURE_TTL_MS) {
      recentUserSpeechSignatures.delete(signature)
    }
  }

  const normalizedText = normalizeSpeechTextForDedup(text)
  if (!normalizedText) return false

  const signature = `${sourceDeviceKey}::${normalizedText}`
  const previousTimestamp = recentUserSpeechSignatures.get(signature)
  recentUserSpeechSignatures.set(signature, now)

  return !!previousTimestamp && now - previousTimestamp <= DUPLICATE_USER_SPEECH_WINDOW_MS
}

function detectConversationLanguage(text: string): ConversationLanguage | null {
  const zhCount = (text.match(/[\u4e00-\u9fff]/g) || []).length
  const latinCount = (text.match(/[A-Za-z]/g) || []).length

  if (zhCount >= 2 && zhCount >= latinCount) return 'zh'
  if (latinCount >= 3 && zhCount === 0) return 'en'
  if (latinCount >= 6 && latinCount > zhCount * 2) return 'en'
  if (zhCount >= 1 && zhCount >= latinCount) return 'zh'
  return null
}

function resolvePreferredConversationLanguage(
  text: string,
  sourceDeviceKey: string,
  now: number,
): ConversationLanguage {
  const detected = detectConversationLanguage(text)
  if (detected) return detected

  const previous = conversationStateByDevice.get(sourceDeviceKey)
  if (previous && now - previous.lastSpeechAt <= CONVERSATION_LANGUAGE_MEMORY_MS) {
    return previous.lastLanguage
  }

  return globalConversationLanguage
}

function shouldUseProactiveGreeting(sourceDeviceKey: string, now: number): boolean {
  const previous = conversationStateByDevice.get(sourceDeviceKey)
  if (!previous) return true
  return now - previous.lastSpeechAt >= CONVERSATION_GREETING_RESET_MS
}

function recordConversationState(sourceDeviceKey: string, language: ConversationLanguage, now: number): void {
  conversationStateByDevice.set(sourceDeviceKey, {
    lastSpeechAt: now,
    lastLanguage: language,
  })
  globalConversationLanguage = language

  for (const [deviceKey, state] of conversationStateByDevice) {
    if (now - state.lastSpeechAt > CONVERSATION_LANGUAGE_MEMORY_MS) {
      conversationStateByDevice.delete(deviceKey)
    }
  }
}

function activeCharacterName(): string {
  return (backendSyncState.profile?.name || 'Reze').trim() || 'Reze'
}

function buildCharacterPromptContext(): string {
  const characterName = activeCharacterName()
  const avatarId = backendSyncState.avatarModel?.id?.trim() || 'unknown'
  const thumbnailId = backendSyncState.avatarModel?.thumbnailID?.trim() || avatarId

  return [
    `[Character Context]`,
    `Character name: ${characterName}`,
    `Character role: Clawatar virtual avatar companion`,
    `Avatar id: ${avatarId}`,
    `Avatar thumbnail id: ${thumbnailId}`,
    `Transport policy: Apple clients connect via relay only (/ws/client). Local ws://127.0.0.1:8765 is backend-internal bridge hop.`,
  ].join('\n')
}

function shouldAttachTransportStatusContext(userText: string): boolean {
  return TRANSPORT_STATUS_KEYWORDS.test(userText)
}

interface TransportPromptContext {
  directive: string
  bridgeStatus: Record<string, any> | null
  relayStatus: Record<string, any> | null
}

async function fetchJSONWithTimeout(url: string, timeoutMs: number): Promise<Record<string, any> | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch(url, { signal: controller.signal })
    if (!resp.ok) return null
    const parsed = await resp.json()
    return isObjectRecord(parsed) ? parsed : null
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

function summarizeConnectedDevicesForPrompt(raw: unknown): string {
  if (!Array.isArray(raw) || raw.length === 0) return 'none'

  const summary = raw
    .slice(0, 4)
    .map((item) => {
      if (!isObjectRecord(item)) return null
      const name = typeof item.deviceName === 'string' && item.deviceName.trim() ? item.deviceName.trim() : 'Unknown'
      const type = typeof item.deviceType === 'string' && item.deviceType.trim() ? item.deviceType.trim() : 'unknown'
      const via = typeof item.via === 'string' && item.via.trim() ? item.via.trim() : 'unknown'
      return `${name} (${type}, via=${via})`
    })
    .filter((value): value is string => !!value)

  if (summary.length === 0) return 'none'
  const suffix = raw.length > 4 ? ` +${raw.length - 4} more` : ''
  return summary.join('; ') + suffix
}

async function buildTransportStatusPromptContext(userText: string): Promise<TransportPromptContext | null> {
  if (!shouldAttachTransportStatusContext(userText)) {
    return null
  }

  const [bridgeStatus, relayStatus] = await Promise.all([
    fetchJSONWithTimeout(BRIDGE_STATUS_URL, 420),
    fetchJSONWithTimeout(RELAY_SESSION_STATUS_URL, 420),
  ])

  const lines: string[] = [
    '[Transport Facts — Authoritative]',
    '- Apple clients in this project are relay-only (/ws/client).',
    '- ws://127.0.0.1:8765 is backend-internal bridge-to-backend hop, not direct app transport.',
    '- Never claim direct local-network client connection unless runtime status explicitly confirms it.',
  ]

  if (bridgeStatus) {
    const relayConnected = bridgeStatus.relay?.connected === true
    const localConnected = bridgeStatus.localGateway?.connected === true
    const localEndpoint = typeof bridgeStatus.localGateway?.endpoint === 'string'
      ? bridgeStatus.localGateway.endpoint
      : 'unknown'
    const devicesSummary = summarizeConnectedDevicesForPrompt(bridgeStatus.devices?.connected)
    lines.push(
      `[Bridge runtime] relayConnected=${relayConnected}; localBackendConnected=${localConnected}; localEndpoint=${localEndpoint}; devices=${devicesSummary}`,
    )
  }

  if (relayStatus) {
    const gatewayConnected = relayStatus.gatewayConnected === true
    const connectedClients = Number.isFinite(relayStatus.connectedClients)
      ? relayStatus.connectedClients
      : (Array.isArray(relayStatus.connectedDevices) ? relayStatus.connectedDevices.length : 0)
    const devicesSummary = summarizeConnectedDevicesForPrompt(relayStatus.connectedDevices)
    lines.push(
      `[Relay session] gatewayConnected=${gatewayConnected}; connectedClients=${connectedClients}; devices=${devicesSummary}`,
    )
  }

  if (!bridgeStatus && !relayStatus) {
    lines.push('[Runtime status] unavailable. If asked for live topology, state uncertainty instead of guessing.')
  }

  lines.push('If the user asks about current connection path, answer strictly from these facts/status lines only.')
  return {
    directive: lines.join('\n'),
    bridgeStatus,
    relayStatus,
  }
}

function responseMentionsRelay(text: string): boolean {
  return /(relay|\/ws\/client|gateway|中继|中转|走relay|relay-only|relay only)/i.test(text)
}

function responseMentionsInternalBridgeHop(text: string): boolean {
  return /(internal|backend-internal|bridge hop|后端内部|内部跳点|内部桥接|bridge-to-backend)/i.test(text)
}

function responseClaimsDirectLocalConnection(text: string): boolean {
  const denyRelayPatterns = [
    /not\s+going\s+through\s+relay/i,
    /不是.*relay/i,
    /不走\s*relay/i,
    /绕过.*relay/i,
  ]
  if (denyRelayPatterns.some((pattern) => pattern.test(text))) {
    return true
  }

  const localPathPatterns = [
    /local\s+websocket/i,
    /same\s+local\s+network/i,
    /ws:\/\/(?:localhost|127\.0\.0\.1):8765/i,
    /through\s+(?:the\s+)?local/i,
    /本地.*(?:websocket|ws|8765|直连|局域网)/i,
    /通过.*本地/i,
  ]
  if (!localPathPatterns.some((pattern) => pattern.test(text))) {
    return false
  }

  if (responseMentionsInternalBridgeHop(text)) {
    return false
  }

  return true
}

function readBooleanStatus(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function readFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return null
}

function buildSafeTransportReply(
  preferredLanguage: ConversationLanguage,
  transportContext: TransportPromptContext,
): string {
  const relayConnected = readBooleanStatus(transportContext.bridgeStatus?.relay?.connected)
  const localBackendConnected = readBooleanStatus(transportContext.bridgeStatus?.localGateway?.connected)
  const gatewayConnected = readBooleanStatus(transportContext.relayStatus?.gatewayConnected)
  const connectedClientsRaw = transportContext.relayStatus?.connectedClients
  const connectedClients = readFiniteNumber(connectedClientsRaw)

  if (preferredLanguage === 'zh') {
    const runtimeParts: string[] = []
    if (relayConnected !== null) runtimeParts.push(`relayConnected=${relayConnected ? '是' : '否'}`)
    if (gatewayConnected !== null) runtimeParts.push(`gatewayConnected=${gatewayConnected ? '是' : '否'}`)
    if (localBackendConnected !== null) runtimeParts.push(`internalBridgeConnected=${localBackendConnected ? '是' : '否'}`)
    if (connectedClients !== null) runtimeParts.push(`connectedClients=${connectedClients}`)

    const runtimeText = runtimeParts.length > 0
      ? ` 当前运行状态：${runtimeParts.join('，')}。`
      : ''
    return `当前策略是 relay-only：iPhone/iPad/macOS 只通过 relay (/ws/client) 鉴权连接。ws://127.0.0.1:8765 只是后端内部 bridge 到 ws-server 的本地跳点，不是客户端直连。${runtimeText}`
  }

  const runtimeParts: string[] = []
  if (relayConnected !== null) runtimeParts.push(`relayConnected=${relayConnected}`)
  if (gatewayConnected !== null) runtimeParts.push(`gatewayConnected=${gatewayConnected}`)
  if (localBackendConnected !== null) runtimeParts.push(`internalBridgeConnected=${localBackendConnected}`)
  if (connectedClients !== null) runtimeParts.push(`connectedClients=${connectedClients}`)

  const runtimeText = runtimeParts.length > 0
    ? ` Runtime status: ${runtimeParts.join('; ')}.`
    : ''
  return `Current policy is relay-only for Apple clients: iPhone/iPad/macOS connect via relay (/ws/client). ws://127.0.0.1:8765 is an internal backend bridge hop, not a direct client path.${runtimeText}`
}

function enforceTransportResponseGuard(
  responseText: string,
  preferredLanguage: ConversationLanguage,
  transportContext: TransportPromptContext | null,
): string {
  if (!transportContext) return responseText

  const trimmed = responseText.trim()
  if (!trimmed) return trimmed

  const mentionsLocalEndpoint = /(127\.0\.0\.1|localhost|8765|local\s+websocket|本地)/i.test(trimmed)
  const isDirectLocalClaim = responseClaimsDirectLocalConnection(trimmed)

  if (isDirectLocalClaim) {
    return buildSafeTransportReply(preferredLanguage, transportContext)
  }

  if (mentionsLocalEndpoint && !responseMentionsInternalBridgeHop(trimmed)) {
    return buildSafeTransportReply(preferredLanguage, transportContext)
  }

  if (!responseMentionsRelay(trimmed)) {
    return buildSafeTransportReply(preferredLanguage, transportContext)
  }

  return trimmed
}

function buildConversationPromptDirective(options: {
  preferredLanguage: ConversationLanguage
  useProactiveGreeting: boolean
}): string {
  const characterName = activeCharacterName()
  const languageDirective = options.preferredLanguage === 'zh'
    ? 'For this turn, reply ONLY in Chinese. Do not output English unless the user explicitly switches language.'
    : 'For this turn, reply ONLY in English. Do not output Chinese unless the user explicitly switches language.'

  let greetingDirective = 'Do not force a new greeting unless the user explicitly asks for one.'
  if (options.useProactiveGreeting) {
    if (options.preferredLanguage === 'zh') {
      greetingDirective = `This is the first message of a new/restarted conversation window. Your opening sentence MUST explicitly include your identity in Chinese (name + role), for example: "我是${characterName}，你的 Clawatar 虚拟角色搭档。"`
    } else {
      greetingDirective = `This is the first message of a new/restarted conversation window. Your opening sentence MUST explicitly include your identity in English (name + role), for example: "I'm ${characterName}, your Clawatar avatar companion."`
    }
  }

  return [
    buildCharacterPromptContext(),
    '[Conversation Style Rules]',
    languageDirective,
    greetingDirective,
    'Keep responses conversational and concise for spoken chat.',
  ].join('\n')
}

function enforceConversationResponseStyle(
  responseText: string,
  options: {
    preferredLanguage: ConversationLanguage
    useProactiveGreeting: boolean
  },
): string {
  const trimmed = responseText.trim()
  if (!trimmed) return trimmed
  if (!options.useProactiveGreeting) return trimmed

  const characterName = activeCharacterName()
  const lower = trimmed.toLowerCase()
  const hasName = lower.includes(characterName.toLowerCase())
  const hasRole = /clawatar|avatar companion|virtual avatar|虚拟角色|搭档/i.test(trimmed)
  if (hasName && hasRole) {
    return trimmed
  }

  const identitySentence = options.preferredLanguage === 'zh'
    ? `我是${characterName}，你的 Clawatar 虚拟角色搭档。`
    : `I'm ${characterName}, your Clawatar avatar companion.`
  return `${identitySentence} ${trimmed}`
}

function violatesLanguagePreference(text: string, preferredLanguage: ConversationLanguage): boolean {
  const zhCount = (text.match(/[\u4e00-\u9fff]/g) || []).length
  const latinCount = (text.match(/[A-Za-z]/g) || []).length

  if (preferredLanguage === 'en') {
    return zhCount >= 2
  }

  // Allow short English names/acronyms in Chinese replies.
  return latinCount >= 12 && latinCount > zhCount
}

async function alignResponseLanguageIfNeeded(
  responseText: string,
  preferredLanguage: ConversationLanguage,
): Promise<string> {
  const trimmed = responseText.trim()
  if (!trimmed) return trimmed
  if (!violatesLanguagePreference(trimmed, preferredLanguage)) return trimmed

  const rewritePrompt = preferredLanguage === 'zh'
    ? `请把下面这段助手回复改写成自然中文，只保留原意和语气，不要增加新信息，不要 Markdown：\n\n${trimmed}`
    : `Rewrite this assistant reply into natural English only. Keep the exact meaning and tone, add no new information, no markdown:\n\n${trimmed}`

  const rewriteSession = preferredLanguage === 'zh' ? 'vrm-chat-style-zh' : 'vrm-chat-style-en'
  try {
    const rewritten = (await askOpenClaw(rewritePrompt, rewriteSession)).trim()
    if (!rewritten) return trimmed
    if (violatesLanguagePreference(rewritten, preferredLanguage)) return trimmed
    return rewritten
  } catch {
    return trimmed
  }
}

/**
 * Analyze camera frames using OpenAI Vision API directly.
 * Gateway doesn't support multimodal content, so we call OpenAI directly.
 * Returns a text description of what's visible in the frames.
 */
async function handleUserSpeech(text: string, senderWs: WebSocket, sourceDevice?: string) {
  console.log(`User said: "${text}" (from device: ${sourceDevice || 'unknown'})`)
  const startTime = Date.now()
  const audioDevice = sourceDevice || undefined
  const sourceDeviceKey = resolveSourceDeviceKey(sourceDevice, senderWs)
  const preferredLanguage = resolvePreferredConversationLanguage(text, sourceDeviceKey, startTime)
  const useProactiveGreeting = shouldUseProactiveGreeting(sourceDeviceKey, startTime)
  recordConversationState(sourceDeviceKey, preferredLanguage, startTime)

  // Record in multimodal memory (non-blocking)
  // Simple mood detection from text patterns (fast, no API call)
  const moodPatterns: [RegExp, string][] = [
    [/哈哈|lol|😂|太好了|开心|happy|nice|awesome|棒/i, 'happy'],
    [/累|tired|困|sleepy|好烦|唉/i, 'tired'],
    [/太棒|厉害|wow|amazing|excited|激动|兴奋/i, 'excited'],
    [/难过|sad|不开心|伤心|💔/i, 'sad'],
    [/生气|angry|烦死|fuck|shit|操/i, 'angry'],
    [/为什么|怎么|好奇|what|why|how|想知道/i, 'curious'],
  ]
  const detectedMood = moodPatterns.find(([re]) => re.test(text))?.[1]
  multimodalMemory.addAudioMemory(text, detectedMood || undefined)

  // Broadcast helper
  const broadcast = (msg: any) => {
    if (!isObjectRecord(msg)) {
      const str = JSON.stringify(msg)
      for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) client.send(str)
      }
      return
    }

    const outgoing: Record<string, any> = { ...msg }

    if (shouldBroadcastMotionSync(outgoing)) {
      const syncPayload = extractMotionSyncPayload(outgoing)
      if (syncPayload) {
        broadcastMotionSync(syncPayload)
        // Keep text/audio messages routing-only; motion is now carried by sync/action.
        stripMotionFields(outgoing)
      }
    }

    if (audioDevice && !hasExplicitRoutingFields(outgoing)) {
      outgoing.audio_device = audioDevice
      outgoing.target_device = audioDevice
      outgoing.reply_device = audioDevice
    }

    const str = JSON.stringify(outgoing)
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) client.send(str)
    }
  }

  // Fast-path: direct relay command dispatch (without round-tripping through agent).
  const directCommand = parseDirectRelaySpeakCommand(text)
  if (directCommand) {
    const commandStart = Date.now()
    try {
      const dispatchResult = await dispatchDirectRelaySpeakCommand(directCommand, broadcast)
      const targetSummary = summarizeRouteTargets(directCommand.targets)
      console.log(
        `[direct-relay] dispatched ${dispatchResult.resolvedType} to ${targetSummary} in ${Date.now() - commandStart}ms`,
      )

      if (audioDevice) {
        const ackText = `Done. Sent to ${targetSummary}.`
        const ackPayload: Record<string, any> = {
          type: 'speak',
          text: ackText,
          action_id: '161_Waving',
          expression: 'happy',
          expression_weight: 0.55,
          audio_device: audioDevice,
        }
        try {
          ackPayload.type = 'speak_audio'
          ackPayload.audio_url = await generateTTS(ackText)
        } catch {
          ackPayload.type = 'speak'
          delete ackPayload.audio_url
        }
        broadcast(ackPayload)
      }

      return
    } catch (error: any) {
      console.error(`[direct-relay] failed: ${error?.message || error}`)
      broadcast({
        type: 'speak',
        text: 'I could not dispatch that relay speak command.',
        action_id: '88_Thinking',
        expression: 'neutral',
        expression_weight: 0.5,
        audio_device: audioDevice,
      })
      return
    }
  }

  // --- Entity memory recall ---
  const entityContext = entityStore.quickRecall(text)
  if (entityContext) {
    console.log(`[entity-memory] Recalled context for: "${text.slice(0, 40)}"`)
  }

  // --- Visual memory search (Tier 1: text only, embedding-first) ---
  const visualSearchResults = await visualMemory.search(text, 5)
  const visualMemoryContext = buildVisualMemoryContext(visualSearchResults, [], 5)
  if (visualMemoryContext) {
    console.log(`[visual-memory] Recalled ${visualSearchResults.length} visual records for: "${text.slice(0, 40)}"`)
  }

  // --- Visual context injection ---
  // If camera is active, check if we should include visual context
  // Triggers: visual keywords in user text, or camera just opened
  const visualKeywords = /看|see|show|这是|what|image|图|视频|camera|摄像|样子|穿|外面|在哪|where|look/i
  let messages: Array<{ role: string; content: any }> = []

  if (visualMemory.isCameraActive() && visualKeywords.test(text)) {
    const ctx = visualMemory.getVisualContext('user_visual_request')
    if (ctx.currentFrames.length > 0) {
      const framePaths: string[] = []
      const framesToSend = ctx.currentFrames.slice(-2)
      for (let i = 0; i < framesToSend.length; i++) {
        const framePath = `/tmp/camera-frame-${Date.now()}-${i}.jpg`
        writeFileSync(framePath, Buffer.from(framesToSend[i], 'base64'))
        framePaths.push(framePath)
      }
      let enrichedText = `[CAMERA IS ACTIVE — frames captured]\n`
      enrichedText += `Camera frames saved at: ${framePaths.join(', ')}\n`
      enrichedText += `Please analyze these camera images to answer the user's question.\n`
      const visionSummary = visionLog.getSummaryText()
      enrichedText += `${visionSummary}\n`
      enrichedText += `\nUser says: ${text}`
      messages = [{ role: 'user', content: enrichedText }]
      console.log(`[visual] Saved ${framePaths.length} frames to disk, injected paths into context`)
    } else {
      messages = [{ role: 'user', content: text }]
    }
  } else {
    messages = [{ role: 'user', content: text }]
  }

  // Prepend retrieved memory context to user message.
  // Order: Visual Memory -> Entity Memory -> User text
  if (messages.length > 0) {
    const lastMsg = messages[messages.length - 1]
    if (typeof lastMsg.content === 'string') {
      const contextBlocks: string[] = []
      if (visualMemoryContext) contextBlocks.push(visualMemoryContext)
      if (entityContext) contextBlocks.push(entityContext)
      if (contextBlocks.length > 0) {
        const userBlock = lastMsg.content.includes('User says:')
          ? lastMsg.content
          : `User says: ${lastMsg.content}`
        lastMsg.content = `${contextBlocks.join('\n\n')}\n\n${userBlock}`
      }
    }
  }

  // --- New person detection hints (rule-based, injected only when triggered) ---
  const hints: string[] = []

  // Check face persistence tracker
  const persistentFaces = faceTracker.getPendingPrompts()
  if (persistentFaces.length > 0) {
    const face = persistentFaces[0]
    const duration = Math.round((Date.now() - face.firstSeen) / 1000)
    hints.push(`[CONTEXT: An unknown person has been visible in the camera for ${duration} seconds. You might want to ask the user who they are.]`)
    faceTracker.markPrompted(face.faceHash)
  }

  // Check unknown speaker tracker
  const newSpeakers = speakerTracker.getPendingPrompts()
  if (newSpeakers.length > 0) {
    hints.push(`[CONTEXT: A new voice has spoken ${newSpeakers[0].sentenceCount} sentences in the conversation. You might want to ask who is talking.]`)
    speakerTracker.markPrompted(newSpeakers[0].speakerLabel)
  }

  // Detect user introduction pattern (rule-based NER)
  const introPatterns = [
    /(?:this is|meet|let me introduce)\s+(?:my\s+)?(\w[\w\s]{0,30})/i,
    /(?:这是|介绍一下|认识一下)\s*(?:我的|我们的)?\s*(.{1,20})/,
  ]
  for (const pattern of introPatterns) {
    const match = text.match(pattern)
    if (!match) continue

    const name = match[1].trim()
    if (!name) continue

    const existing = entityStore.findByName(name)
    if (existing) {
      entityStore.updateEntity(existing.id, {
        lastSeen: new Date().toISOString(),
        seenCount: existing.seenCount + 1,
      })
    } else {
      const created = entityStore.createEntity({
        type: 'person',
        name,
        aliases: [],
      })
      console.log(`[entity-memory] Created introduced entity: ${created.name || created.id}`)
    }

    hints.push(`[CONTEXT: The user is introducing someone named "${name}". Record their face and voice from the current camera/audio. Confirm you will remember them.]`)
    break
  }

  // Inject hints before the "User says" block (after memory context blocks if present)
  if (hints.length > 0 && messages.length > 0) {
    const hintBlock = hints.join('\n') + '\n\n'
    const lastMsg = messages[messages.length - 1]
    if (typeof lastMsg.content === 'string') {
      const marker = 'User says:'
      const markerIndex = lastMsg.content.indexOf(marker)
      if (markerIndex >= 0) {
        lastMsg.content = `${lastMsg.content.slice(0, markerIndex)}${hintBlock}${lastMsg.content.slice(markerIndex)}`
      } else {
        lastMsg.content = hintBlock + lastMsg.content
      }
    }
    console.log(`[hints] Injected ${hints.length} new-person hints`)
  }

  const conversationDirective = buildConversationPromptDirective({
    preferredLanguage,
    useProactiveGreeting,
  })
  const transportPromptContext = await buildTransportStatusPromptContext(text)
  if (transportPromptContext) {
    messages = [
      { role: 'system', content: transportPromptContext.directive },
      { role: 'system', content: conversationDirective },
      ...messages,
    ]
  } else {
    messages = [{ role: 'system', content: conversationDirective }, ...messages]
  }

  /* ── Streaming-audio mode ──────────────────────────────────────── */
  const shouldForceBatchTransportReply = !!transportPromptContext
  if (isDeviceStreaming(senderWs) && !shouldForceBatchTransportReply) {
    try {
      const { text: response, firstChunkMs } = await streamingAudioPipeline(
        messages,
        'vrm-chat',
        broadcast,
      )
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      console.log(`[stream-audio] handleUserSpeech done in ${elapsed}s (first chunk: ${firstChunkMs}ms)`)
      return
    } catch (e: any) {
      console.error('[stream-audio] Pipeline error, falling back to batch:', e.message)
      // fall through to batch pipeline
    }
  }

  /* ── Batch pipeline (default) ──────────────────────────────────── */
  try {
    // Two-phase broadcast: ack first sentence immediately during tool calls,
    // then broadcast the main response when ready
    const broadcastFn = (audioUrl: string, text: string, isAck: boolean) => {
      const { action_id, expression, expression_weight } = isAck
        ? { action_id: '88_Thinking', expression: 'neutral', expression_weight: 0.5 }
        : pickAction(text)
      broadcast({ type: 'speak_audio', audio_url: audioUrl, text, action_id, expression, expression_weight })
      console.log(`[two-phase] ${isAck ? 'ACK' : 'MAIN'} broadcast: ${action_id}, text: "${text.slice(0, 50)}"`)
    }

    const { text: response, audioUrl, firstAudioMs, ackSent } = await twoPhaseStreamingPipeline(
      messages,
      'vrm-chat',
      broadcastFn,
    )

    const baseStyledResponse = enforceConversationResponseStyle(response, {
      preferredLanguage,
      useProactiveGreeting,
    })
    const alignedResponse = await alignResponseLanguageIfNeeded(baseStyledResponse, preferredLanguage)
    let styledResponse = enforceConversationResponseStyle(alignedResponse, {
      preferredLanguage,
      useProactiveGreeting,
    })
    styledResponse = enforceTransportResponseGuard(
      styledResponse,
      preferredLanguage,
      transportPromptContext,
    )
    const finalAudioUrl = styledResponse === response ? audioUrl : await generateTTS(styledResponse)

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(`[batch] Response in ${elapsed}s (first audio: ${firstAudioMs}ms, ack: ${ackSent}): "${styledResponse.slice(0, 80)}..."`)

    if (!styledResponse || styledResponse.includes('NO_REPLY') || styledResponse.includes('HEARTBEAT_OK')) {
      console.log('[batch] No actionable response')
      return
    }

    // Broadcast the main response (full text + remaining audio)
    const { action_id, expression, expression_weight } = pickAction(styledResponse)
    broadcast({ type: 'speak_audio', audio_url: finalAudioUrl, text: styledResponse, action_id, expression, expression_weight })
    console.log(`[batch] Broadcast: ${action_id}, ${expression}, device: ${audioDevice || 'all'}`)
  } catch (e: any) {
    console.error('[batch] Pipeline error:', e.message)
    // Fallback: non-streaming
    try {
      const response = await askOpenClaw(text)
      const baseStyledResponse = enforceConversationResponseStyle(response, {
        preferredLanguage,
        useProactiveGreeting,
      })
      const alignedResponse = await alignResponseLanguageIfNeeded(baseStyledResponse, preferredLanguage)
      let styledResponse = enforceConversationResponseStyle(alignedResponse, {
        preferredLanguage,
        useProactiveGreeting,
      })
      styledResponse = enforceTransportResponseGuard(
        styledResponse,
        preferredLanguage,
        transportPromptContext,
      )
      const { action_id, expression, expression_weight } = pickAction(styledResponse)
      const audioUrl = await generateTTS(styledResponse)
      broadcast({ type: 'speak_audio', audio_url: audioUrl, text: styledResponse, action_id, expression, expression_weight })
    } catch (fallbackErr: any) {
      console.error('[batch] Fallback also failed:', fallbackErr.message)
      broadcast({ type: 'speak', text: "Sorry, I'm having trouble right now.", action_id: '88_Thinking', expression: 'neutral', expression_weight: 0.5 })
    }
  }
}

/**
 * Handle meeting speech — routes through OpenClaw Gateway HTTP API (streaming).
 * Uses x-openclaw-session-key to maintain a persistent meeting session with full context.
 */
function estimateSentenceCount(text: string): number {
  const matches = text.match(/[。！？.!?]+/g)
  if (!matches) return text.trim() ? 1 : 0
  return Math.max(1, matches.length)
}

async function handleMeetingSpeech(prompt: string, senderWs: WebSocket) {
  console.log(`[meeting] Pipeline...`)
  const startTime = Date.now()

  const broadcastAll = (msg: any) => {
    msg.audio_device = 'meeting'
    const str = JSON.stringify(msg)
    for (const c of clients) { if (c.readyState === WebSocket.OPEN) c.send(str) }
  }

  /* ── Streaming-audio path ── */
  if (isDeviceStreaming(senderWs)) {
    try {
      const { text: response, firstChunkMs } = await streamingAudioPipeline(
        [{ role: 'user', content: prompt }],
        'meeting-avatar',
        broadcastAll,
      )
      console.log(`[meeting-stream] Done ${((Date.now() - startTime) / 1000).toFixed(1)}s, first chunk ${firstChunkMs}ms`)
      return
    } catch (e: any) {
      console.error('[meeting-stream] Error, falling back:', e.message)
    }
  }

  /* ── Batch path (default) ── */
  try {
    const broadcastAck = (ackAudioUrl: string, ackText: string) => {
      broadcastAll({
        type: 'speak_audio', audio_url: ackAudioUrl, text: ackText,
        action_id: '88_Thinking', expression: 'neutral', expression_weight: 0.5,
      })
    }

    const { text: response, audioUrl, firstChunkMs, ackSent } = await streamingPipeline(
      [{ role: 'user', content: prompt }],
      'meeting-avatar',
      { broadcastAck, inputText: prompt },
    )

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(`[meeting-batch] Done in ${elapsed}s (TTS first: ${firstChunkMs}ms, ack: ${ackSent}): "${response.slice(0, 100)}..."`)

    if (!response || response.length < 2 || response.includes('NO_REPLY') || response.includes('HEARTBEAT_OK')) {
      console.log('[meeting-batch] No actionable response')
      return
    }

    const { action_id, expression, expression_weight } = pickAction(response)
    broadcastAll({ type: 'speak_audio', audio_url: audioUrl, text: response, action_id, expression, expression_weight })
    console.log(`[meeting-batch] Broadcast: ${action_id}, ${expression}`)
  } catch (e: any) {
    console.error('[meeting-batch] Pipeline error:', e.message)
  }
}

// --- Multi-device registry ---
interface DeviceInfo {
  ws: WebSocket
  deviceId: string
  deviceType: string
  name: string
  streamingMode: boolean
}

/** Check whether the WS connection has streaming-audio mode enabled. */
function isDeviceStreaming(target: WebSocket): boolean {
  for (const [, dev] of devices) {
    if (dev.ws === target && dev.streamingMode) return true
  }
  return (target as any).__streamingMode === true
}
const devices = new Map<string, DeviceInfo>()

function getDeviceList(): Array<{deviceId: string, deviceType: string, name: string}> {
  return Array.from(devices.values()).map(d => ({
    deviceId: d.deviceId, deviceType: d.deviceType, name: d.name
  }))
}

function findDeviceIdByWs(targetWs: WebSocket): string | undefined {
  for (const [id, info] of devices) {
    if (info.ws === targetWs) return id
  }
  return undefined
}

function broadcastDeviceList() {
  const list = getDeviceList()
  const msg = JSON.stringify({ type: 'device_list', devices: list })
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg)
    }
  }
}

interface BackendProfileState {
  name: string
  avatarImageURL?: string
  avatarInitials?: string
  updatedAt: number
}

interface BackendThemeState {
  theme: string
  updatedAt: number
}

interface BackendCameraState {
  preset: string
  distance?: number
  height?: number
  updatedAt: number
}

interface BackendAvatarConfigState {
  autoBlink: boolean
  idleAnimations: boolean
  touchReactions: boolean
  updatedAt: number
}

interface BackendAvatarModelState {
  id: string
  modelURL: string
  thumbnailID: string
  updatedAt: number
}

interface BackendSyncState {
  version: number
  updatedAt: number
  profile?: BackendProfileState
  theme?: BackendThemeState
  camera?: BackendCameraState
  avatarConfig?: BackendAvatarConfigState
  avatarModel?: BackendAvatarModelState
}

type SyncValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string }

const backendSyncState = loadBackendSyncState()

function isObjectRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function decodeSyncPayload(raw: unknown): Record<string, any> {
  if (isObjectRecord(raw)) return raw
  if (typeof raw !== 'string') return {}

  try {
    const parsed = JSON.parse(raw)
    return isObjectRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function trimToMax(raw: string, maxLength: number): string {
  return raw.trim().slice(0, maxLength)
}

function coerceNumber(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string') {
    const parsed = Number(raw)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function coerceBoolean(raw: unknown): boolean | null {
  if (typeof raw === 'boolean') return raw
  if (typeof raw === 'number') {
    if (raw === 1) return true
    if (raw === 0) return false
  }
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase()
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  }
  return null
}

function isPrivateIPv4Host(host: string): boolean {
  const parts = host.split('.')
  if (parts.length !== 4) return false

  const octets = parts.map((part) => Number(part))
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false
  }

  const [first, second] = octets
  if (first === 10 || first === 127 || first === 0) return true
  if (first === 192 && second === 168) return true
  if (first === 172 && second >= 16 && second <= 31) return true
  if (first === 169 && second === 254) return true
  return false
}

function isPrivateIPv6Host(host: string): boolean {
  const normalized = host.toLowerCase()
  if (normalized === '::1' || normalized === '::') return true
  if (normalized.startsWith('fe80:')) return true
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true
  return false
}

function normalizePublicHTTPURL(raw: unknown): SyncValidationResult<string> {
  if (typeof raw !== 'string') {
    return { ok: false, code: 'invalid_url', message: 'URL must be a string.' }
  }

  const trimmed = raw.trim()
  if (!trimmed) {
    return { ok: false, code: 'invalid_url', message: 'URL cannot be empty.' }
  }
  if (trimmed.length > 2048) {
    return { ok: false, code: 'invalid_url', message: 'URL is too long.' }
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, code: 'invalid_url', message: 'URL format is invalid.' }
  }

  const protocol = parsed.protocol.toLowerCase()
  if (protocol !== 'https:' && protocol !== 'http:') {
    return { ok: false, code: 'invalid_url', message: 'Only HTTP(S) URLs are supported.' }
  }

  const host = parsed.hostname.toLowerCase()
  if (!host || host === 'localhost' || host.endsWith('.local')) {
    return { ok: false, code: 'private_host', message: 'Host must be publicly reachable.' }
  }
  if (isPrivateIPv4Host(host) || isPrivateIPv6Host(host)) {
    return { ok: false, code: 'private_host', message: 'Private network URLs are not allowed.' }
  }

  return { ok: true, value: parsed.toString() }
}

function buildProfileInitials(name: string): string {
  const words = name
    .split(/\s+/)
    .map(word => word.trim())
    .filter(Boolean)

  if (words.length === 0) return 'U'
  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase()
  }
  return (words[0][0] + words[1][0]).toUpperCase()
}

function sanitizeIdentifier(raw: string): string {
  const trimmed = raw.trim().slice(0, 80)
  if (!trimmed) return ''
  return trimmed.replace(/\s+/g, '_')
}

function inferAvatarIdFromModelURL(modelURL: string): string {
  try {
    const parsed = new URL(modelURL)
    const fileName = parsed.pathname.split('/').pop() || ''
    const baseName = fileName.replace(/\.[^.]+$/, '')
    return sanitizeIdentifier(baseName) || 'custom'
  } catch {
    return 'custom'
  }
}

function normalizeProfilePayload(payload: Record<string, any>): SyncValidationResult<Record<string, any>> {
  const normalized: Record<string, any> = {}
  const nameKeys = ['name', 'characterName', 'character_name', 'displayName', 'display_name']
  const avatarKeys = ['avatarImageURL', 'avatar_image_url', 'avatarURL', 'avatar_url', 'imageURL', 'image_url']

  const providedNameKey = nameKeys.find((key) => payload[key] !== undefined)
  if (providedNameKey) {
    const rawName = typeof payload[providedNameKey] === 'string' ? payload[providedNameKey] : ''
    const name = trimToMax(rawName, 48)
    if (!name) {
      return { ok: false, code: 'invalid_profile', message: 'Profile name cannot be empty.' }
    }
    normalized.name = name
    normalized.avatarInitials = buildProfileInitials(name)
  }

  const providedAvatarKey = avatarKeys.find((key) => payload[key] !== undefined)
  if (providedAvatarKey) {
    const rawAvatar = typeof payload[providedAvatarKey] === 'string' ? payload[providedAvatarKey] : ''
    const trimmed = rawAvatar.trim()
    if (!trimmed) {
      normalized.avatarImageURL = ''
    } else {
      const validatedURL = normalizePublicHTTPURL(trimmed)
      if (!validatedURL.ok) {
        return { ok: false, code: validatedURL.code, message: `Profile avatar URL invalid: ${validatedURL.message}` }
      }
      normalized.avatarImageURL = validatedURL.value
    }
  }

  if (Object.keys(normalized).length === 0) {
    return { ok: false, code: 'invalid_profile', message: 'Profile payload must include a name or avatar image URL.' }
  }

  return { ok: true, value: normalized }
}

function normalizeThemePayload(payload: Record<string, any>): SyncValidationResult<Record<string, any>> {
  const rawTheme = typeof payload.theme === 'string' ? payload.theme.trim().toLowerCase() : ''
  if (!ALLOWED_THEME_KEYS.has(rawTheme)) {
    return { ok: false, code: 'invalid_theme', message: 'Theme key is unsupported.' }
  }
  return { ok: true, value: { theme: rawTheme } }
}

function normalizeCameraPayload(payload: Record<string, any>): SyncValidationResult<Record<string, any>> {
  const preset = typeof payload.preset === 'string' ? payload.preset.trim().toLowerCase() : ''
  if (!ALLOWED_CAMERA_PRESETS.has(preset)) {
    return { ok: false, code: 'invalid_camera', message: 'Camera preset is unsupported.' }
  }

  const normalized: Record<string, any> = { preset }
  const distance = coerceNumber(payload.distance)
  const height = coerceNumber(payload.height)

  if (distance !== null) {
    normalized.distance = Math.min(Math.max(distance, 0.5), 2.5)
  }
  if (height !== null) {
    normalized.height = Math.min(Math.max(height, -1.5), 1.5)
  }

  return { ok: true, value: normalized }
}

function normalizeAvatarConfigPayload(payload: Record<string, any>): SyncValidationResult<Record<string, any>> {
  const normalized: Record<string, any> = {}

  const autoBlink = coerceBoolean(payload.autoBlink)
  const idleAnimations = coerceBoolean(payload.idleAnimations)
  const touchReactions = coerceBoolean(payload.touchReactions)

  if (autoBlink !== null) normalized.autoBlink = autoBlink
  if (idleAnimations !== null) normalized.idleAnimations = idleAnimations
  if (touchReactions !== null) normalized.touchReactions = touchReactions

  if (Object.keys(normalized).length === 0) {
    return { ok: false, code: 'invalid_avatar_config', message: 'Avatar config payload is empty or invalid.' }
  }

  return { ok: true, value: normalized }
}

function normalizeAvatarModelPayload(payload: Record<string, any>): SyncValidationResult<Record<string, any>> {
  const rawModelURL =
    (typeof payload.modelURL === 'string' && payload.modelURL)
    || (typeof payload.model_url === 'string' && payload.model_url)
    || (typeof payload.url === 'string' && payload.url)
    || (typeof payload.model === 'string' && payload.model)
    || ''

  const validatedURL = normalizePublicHTTPURL(rawModelURL)
  if (!validatedURL.ok) {
    return { ok: false, code: validatedURL.code, message: `Avatar model URL invalid: ${validatedURL.message}` }
  }

  const rawID = typeof payload.id === 'string' ? payload.id : ''
  const rawThumbnailID =
    (typeof payload.thumbnailID === 'string' && payload.thumbnailID)
    || (typeof payload.thumbnail_id === 'string' && payload.thumbnail_id)
    || ''

  const id = sanitizeIdentifier(rawID) || inferAvatarIdFromModelURL(validatedURL.value)
  const thumbnailID = sanitizeIdentifier(rawThumbnailID) || id

  return {
    ok: true,
    value: {
      id,
      modelURL: validatedURL.value,
      thumbnailID,
    },
  }
}

function emptyBackendSyncState(): BackendSyncState {
  return {
    version: 1,
    updatedAt: Date.now(),
  }
}

function normalizeLoadedBackendSyncState(raw: unknown): BackendSyncState {
  if (!isObjectRecord(raw)) return emptyBackendSyncState()

  const base = emptyBackendSyncState()
  const version = coerceNumber(raw.version)
  if (version !== null && Number.isFinite(version) && version > 0) {
    base.version = Math.floor(version)
  }

  const updatedAt = coerceNumber(raw.updatedAt)
  if (updatedAt !== null && Number.isFinite(updatedAt) && updatedAt > 0) {
    base.updatedAt = Math.floor(updatedAt)
  }

  if (isObjectRecord(raw.profile) && typeof raw.profile.name === 'string' && raw.profile.name.trim()) {
    const profileName = trimToMax(raw.profile.name, 48)
    base.profile = {
      name: profileName,
      avatarImageURL: typeof raw.profile.avatarImageURL === 'string' ? raw.profile.avatarImageURL.trim() || undefined : undefined,
      avatarInitials: typeof raw.profile.avatarInitials === 'string'
        ? trimToMax(raw.profile.avatarInitials, 4).toUpperCase()
        : buildProfileInitials(profileName),
      updatedAt: Math.floor(coerceNumber(raw.profile.updatedAt) ?? base.updatedAt),
    }
  }

  if (isObjectRecord(raw.theme) && typeof raw.theme.theme === 'string') {
    const theme = raw.theme.theme.trim().toLowerCase()
    if (ALLOWED_THEME_KEYS.has(theme)) {
      base.theme = {
        theme,
        updatedAt: Math.floor(coerceNumber(raw.theme.updatedAt) ?? base.updatedAt),
      }
    }
  }

  if (isObjectRecord(raw.camera) && typeof raw.camera.preset === 'string') {
    const preset = raw.camera.preset.trim().toLowerCase()
    if (ALLOWED_CAMERA_PRESETS.has(preset)) {
      base.camera = {
        preset,
        distance: coerceNumber(raw.camera.distance) ?? undefined,
        height: coerceNumber(raw.camera.height) ?? undefined,
        updatedAt: Math.floor(coerceNumber(raw.camera.updatedAt) ?? base.updatedAt),
      }
    }
  }

  if (isObjectRecord(raw.avatarConfig)) {
    const autoBlink = coerceBoolean(raw.avatarConfig.autoBlink)
    const idleAnimations = coerceBoolean(raw.avatarConfig.idleAnimations)
    const touchReactions = coerceBoolean(raw.avatarConfig.touchReactions)
    if (autoBlink !== null && idleAnimations !== null && touchReactions !== null) {
      base.avatarConfig = {
        autoBlink,
        idleAnimations,
        touchReactions,
        updatedAt: Math.floor(coerceNumber(raw.avatarConfig.updatedAt) ?? base.updatedAt),
      }
    }
  }

  if (isObjectRecord(raw.avatarModel)
    && typeof raw.avatarModel.id === 'string'
    && typeof raw.avatarModel.modelURL === 'string') {
    base.avatarModel = {
      id: sanitizeIdentifier(raw.avatarModel.id) || 'custom',
      modelURL: raw.avatarModel.modelURL,
      thumbnailID: sanitizeIdentifier(String(raw.avatarModel.thumbnailID ?? raw.avatarModel.id)) || 'custom',
      updatedAt: Math.floor(coerceNumber(raw.avatarModel.updatedAt) ?? base.updatedAt),
    }
  }

  return base
}

function loadBackendSyncState(): BackendSyncState {
  try {
    mkdirSync(SYNC_STATE_DIR, { recursive: true })
  } catch {}

  const candidates = [SYNC_STATE_PATH, OPENCLAW_SYNC_BACKUP_PATH].filter(Boolean)
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue
      const raw = JSON.parse(readFileSync(candidate, 'utf-8'))
      const normalized = normalizeLoadedBackendSyncState(raw)
      console.log(`[sync] Loaded backend state from ${candidate}`)
      return normalized
    } catch (error: any) {
      console.warn(`[sync] Failed to load sync state from ${candidate}: ${error?.message || error}`)
    }
  }

  return emptyBackendSyncState()
}

function persistBackendSyncState() {
  const serialized = JSON.stringify(backendSyncState, null, 2)

  const targets = [SYNC_STATE_PATH, OPENCLAW_SYNC_BACKUP_PATH].filter(Boolean)
  for (const targetPath of targets) {
    try {
      mkdirSync(dirname(targetPath), { recursive: true })
      writeFileSync(targetPath, serialized)
    } catch (error: any) {
      console.warn(`[sync] Failed to persist state to ${targetPath}: ${error?.message || error}`)
    }
  }
}

function touchBackendSyncState() {
  backendSyncState.version = Math.max(1, Math.floor(backendSyncState.version || 1)) + 1
  backendSyncState.updatedAt = Date.now()
  persistBackendSyncState()
}

function buildBackendStateSnapshotPayload(): Record<string, any> {
  const payload: Record<string, any> = {
    meta: {
      version: backendSyncState.version,
      updatedAt: backendSyncState.updatedAt,
    },
  }

  if (backendSyncState.profile) {
    payload.profile = {
      name: backendSyncState.profile.name,
      avatarImageURL: backendSyncState.profile.avatarImageURL || '',
      avatarInitials: backendSyncState.profile.avatarInitials || buildProfileInitials(backendSyncState.profile.name),
    }
  }

  if (backendSyncState.theme) {
    payload.theme = { theme: backendSyncState.theme.theme }
  }

  if (backendSyncState.camera) {
    payload.camera = {
      preset: backendSyncState.camera.preset,
      ...(backendSyncState.camera.distance !== undefined ? { distance: backendSyncState.camera.distance } : {}),
      ...(backendSyncState.camera.height !== undefined ? { height: backendSyncState.camera.height } : {}),
    }
  }

  if (backendSyncState.avatarConfig) {
    payload.avatar_config = {
      autoBlink: backendSyncState.avatarConfig.autoBlink,
      idleAnimations: backendSyncState.avatarConfig.idleAnimations,
      touchReactions: backendSyncState.avatarConfig.touchReactions,
    }
  }

  if (backendSyncState.avatarModel) {
    payload.avatar_model = {
      id: backendSyncState.avatarModel.id,
      modelURL: backendSyncState.avatarModel.modelURL,
      thumbnailID: backendSyncState.avatarModel.thumbnailID,
    }
  }

  return payload
}

function sendJSONToClient(target: WebSocket, payload: Record<string, any>) {
  if (target.readyState !== WebSocket.OPEN) return
  target.send(JSON.stringify(payload))
}

function broadcastJSONToClients(payload: Record<string, any>) {
  const encoded = JSON.stringify(payload)
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(encoded)
    }
  }
}

function sendSyncError(target: WebSocket, category: string, code: string, message: string) {
  sendJSONToClient(target, {
    type: 'sync_error',
    category,
    code,
    message,
    ts: Date.now(),
  })
}

function sendBackendStateSnapshot(target: WebSocket, requester?: string) {
  const envelope: Record<string, any> = {
    type: 'sync',
    category: 'state_snapshot',
    payload: buildBackendStateSnapshotPayload(),
    origin: 'backend',
    ts: Date.now(),
  }
  if (requester) {
    envelope.requester = requester
  }
  sendJSONToClient(target, envelope)
}

function applyBackendProfileUpdate(patch: Record<string, any>): Record<string, any> {
  const current = backendSyncState.profile || {
    name: 'Reze',
    avatarInitials: 'R',
    updatedAt: 0,
  }

  const next: BackendProfileState = {
    ...current,
    updatedAt: Date.now(),
  }

  if (typeof patch.name === 'string') {
    next.name = patch.name
    next.avatarInitials = typeof patch.avatarInitials === 'string'
      ? trimToMax(patch.avatarInitials, 4).toUpperCase()
      : buildProfileInitials(patch.name)
  }

  if (typeof patch.avatarImageURL === 'string') {
    next.avatarImageURL = patch.avatarImageURL || undefined
  }

  backendSyncState.profile = next
  touchBackendSyncState()

  return {
    name: next.name,
    avatarImageURL: next.avatarImageURL || '',
    avatarInitials: next.avatarInitials || buildProfileInitials(next.name),
  }
}

function applyBackendThemeUpdate(patch: Record<string, any>): Record<string, any> {
  backendSyncState.theme = {
    theme: patch.theme,
    updatedAt: Date.now(),
  }
  touchBackendSyncState()
  return { theme: backendSyncState.theme.theme }
}

function applyBackendCameraUpdate(patch: Record<string, any>): Record<string, any> {
  const current = backendSyncState.camera || {
    preset: 'portrait',
    updatedAt: 0,
  }

  backendSyncState.camera = {
    preset: patch.preset,
    distance: patch.distance ?? current.distance,
    height: patch.height ?? current.height,
    updatedAt: Date.now(),
  }
  touchBackendSyncState()

  return {
    preset: backendSyncState.camera.preset,
    ...(backendSyncState.camera.distance !== undefined ? { distance: backendSyncState.camera.distance } : {}),
    ...(backendSyncState.camera.height !== undefined ? { height: backendSyncState.camera.height } : {}),
  }
}

function applyBackendAvatarConfigUpdate(patch: Record<string, any>): Record<string, any> {
  const current = backendSyncState.avatarConfig || {
    autoBlink: true,
    idleAnimations: true,
    touchReactions: true,
    updatedAt: 0,
  }

  backendSyncState.avatarConfig = {
    autoBlink: typeof patch.autoBlink === 'boolean' ? patch.autoBlink : current.autoBlink,
    idleAnimations: typeof patch.idleAnimations === 'boolean' ? patch.idleAnimations : current.idleAnimations,
    touchReactions: typeof patch.touchReactions === 'boolean' ? patch.touchReactions : current.touchReactions,
    updatedAt: Date.now(),
  }
  touchBackendSyncState()

  return {
    autoBlink: backendSyncState.avatarConfig.autoBlink,
    idleAnimations: backendSyncState.avatarConfig.idleAnimations,
    touchReactions: backendSyncState.avatarConfig.touchReactions,
  }
}

function applyBackendAvatarModelUpdate(patch: Record<string, any>): Record<string, any> {
  backendSyncState.avatarModel = {
    id: patch.id,
    modelURL: patch.modelURL,
    thumbnailID: patch.thumbnailID,
    updatedAt: Date.now(),
  }
  touchBackendSyncState()
  return {
    id: backendSyncState.avatarModel.id,
    modelURL: backendSyncState.avatarModel.modelURL,
    thumbnailID: backendSyncState.avatarModel.thumbnailID,
  }
}

function handleAuthoritativeSyncEnvelope(parsed: Record<string, any>, senderWs: WebSocket): boolean {
  const categoryRaw = typeof parsed.category === 'string' ? parsed.category : ''
  if (!categoryRaw) return false

  const category = categoryRaw.toLowerCase()
  const payload = decodeSyncPayload(parsed.payload)
  const senderOrigin = typeof parsed.origin === 'string' && parsed.origin.trim()
    ? parsed.origin.trim()
    : (findDeviceIdByWs(senderWs) || 'unknown')

  if (category === 'state_request') {
    sendBackendStateSnapshot(senderWs, senderOrigin)
    return true
  }

  if (category === 'state_snapshot') {
    sendSyncError(senderWs, category, 'read_only', 'state_snapshot is generated by backend only.')
    return true
  }

  const broadcast = (normalizedCategory: string, normalizedPayload: Record<string, any>) => {
    broadcastJSONToClients({
      type: 'sync',
      category: normalizedCategory,
      payload: normalizedPayload,
      origin: senderOrigin,
      ts: Date.now(),
      backend_version: backendSyncState.version,
    })
  }

  if (category === 'profile' || category === 'profile_update') {
    const validated = normalizeProfilePayload(payload)
    if (!validated.ok) {
      sendSyncError(senderWs, category, validated.code, validated.message)
      return true
    }
    const normalizedPayload = applyBackendProfileUpdate(validated.value)
    broadcast('profile', normalizedPayload)
    return true
  }

  if (category === 'theme') {
    const validated = normalizeThemePayload(payload)
    if (!validated.ok) {
      sendSyncError(senderWs, category, validated.code, validated.message)
      return true
    }
    const normalizedPayload = applyBackendThemeUpdate(validated.value)
    broadcast('theme', normalizedPayload)
    return true
  }

  if (category === 'camera') {
    const validated = normalizeCameraPayload(payload)
    if (!validated.ok) {
      sendSyncError(senderWs, category, validated.code, validated.message)
      return true
    }
    const normalizedPayload = applyBackendCameraUpdate(validated.value)
    broadcast('camera', normalizedPayload)
    return true
  }

  if (category === 'avatar_config') {
    const validated = normalizeAvatarConfigPayload(payload)
    if (!validated.ok) {
      sendSyncError(senderWs, category, validated.code, validated.message)
      return true
    }
    const normalizedPayload = applyBackendAvatarConfigUpdate(validated.value)
    broadcast('avatar_config', normalizedPayload)
    return true
  }

  if (category === 'avatar_model' || category === 'avatar_update') {
    const validated = normalizeAvatarModelPayload(payload)
    if (!validated.ok) {
      sendSyncError(senderWs, category, validated.code, validated.message)
      return true
    }
    const normalizedPayload = applyBackendAvatarModelUpdate(validated.value)
    broadcast('avatar_model', normalizedPayload)
    return true
  }

  return false
}

// --- Multimodal Memory: Setup ---

// AI analysis callback for multimodal memory (uses OpenClaw Gateway)
multimodalMemory.setAnalyzeCallback(async (params) => {
  try {
    const messages: any[] = []

    if (params.type === 'caption_scene' && params.images?.length) {
      // Vision analysis: send image + context to Gateway
      const content: any[] = [
        { type: 'text', text: params.context },
        ...params.images.map(img => ({
          type: 'image_url',
          image_url: { url: `data:image/jpeg;base64,${img}` },
        })),
      ]
      messages.push(
        { role: 'system', content: 'You are a visual memory system. Describe scenes concisely for memory storage. Focus on people, activities, location, notable details. 1-2 sentences max. No "I see" prefix.' },
        { role: 'user', content },
      )
    } else if (params.type === 'extract_semantic') {
      messages.push(
        { role: 'system', content: 'You extract patterns and knowledge from observations. Return a JSON array of strings with new insights. Be specific and factual.' },
        { role: 'user', content: params.context },
      )
    } else if (params.type === 'detect_mood') {
      messages.push(
        { role: 'system', content: 'Detect the speaker mood from their speech. Return one word: happy, tired, excited, neutral, sad, angry, curious, frustrated.' },
        { role: 'user', content: params.context },
      )
    }

    if (messages.length === 0) return ''

    const resp = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GATEWAY_TOKEN}`,
        'x-openclaw-agent-id': 'main',
        'x-openclaw-session-key': 'multimodal-memory',
      },
      body: JSON.stringify({ model: 'openclaw', messages }),
    })
    if (!resp.ok) return ''
    const data = await resp.json() as any
    return data?.choices?.[0]?.message?.content || ''
  } catch (e: any) {
    console.error('[MultimodalMemory] AI callback error:', e.message)
    return ''
  }
})

// --- Visual Memory: Camera frame ingestion ---

// Set up proactive scene change alerts + multimodal memory integration
visualMemory.setSceneChangeCallback((context: VisualContext) => {
  console.log('[VisualMemory] Scene change detected! Notifying clients + triggering memory...')

  const summaryText = visionLog.getSummaryText()

  // Notify frontend clients
  const msg = JSON.stringify({
    type: 'scene_change_detected',
    sceneChanged: true,
    memorySummary: summaryText,
    frameCount: context.frameCount,
    timestamp: Date.now(),
  })
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg)
    }
  }

  // Trigger multimodal memory auto-captioning, then persist structured vision record.
  void (async () => {
    try {
      const previousMemoryTs = visualMemory.getLatestMemory()?.ts
      await multimodalMemory.onSceneChange(context)
      const latestMemory = visualMemory.getLatestMemory()
      if (!latestMemory || latestMemory.ts === previousMemoryTs) return

      visionLog.addRecord({
        description: latestMemory.description,
        entitiesPresent: detectEntitiesInDescription(latestMemory.description),
        tags: latestMemory.tags || [],
        thumbnailPath: join(process.env.HOME || '', '.openclaw', 'workspace', 'memory', 'visual', 'thumbnails', latestMemory.thumbnail),
        sceneHash: latestMemory.hash,
        source: 'camera',
      })
    } catch (e: any) {
      console.error('[VisionLog] Scene change processing error:', e.message)
    }
  })()
})

function detectEntitiesInDescription(description: string): string[] {
  const lower = description.toLowerCase()
  return entityStore
    .listEntities()
    .filter(entity => {
      const names = [entity.name, ...entity.aliases].filter(Boolean) as string[]
      return names.some(name => lower.includes(name.toLowerCase()))
    })
    .map(entity => entity.id)
}

async function computeFrameHash(base64Image: string): Promise<string> {
  try {
    const raw = base64Image.includes(',') ? base64Image.split(',')[1] : base64Image
    const buffer = Buffer.from(raw, 'base64')
    const pixels = await sharp(buffer)
      .resize(8, 8, { fit: 'fill' })
      .grayscale()
      .raw()
      .toBuffer()

    let sum = 0
    for (let i = 0; i < pixels.length; i++) sum += pixels[i]
    const avg = sum / pixels.length

    let binary = ''
    for (let i = 0; i < pixels.length; i++) {
      binary += pixels[i] >= avg ? '1' : '0'
    }

    let hex = ''
    for (let i = 0; i < 64; i += 4) {
      hex += parseInt(binary.substring(i, i + 4), 2).toString(16)
    }
    return hex
  } catch {
    return '0000000000000000'
  }
}

async function handleCameraFrame(base64Image: string, _senderWs: WebSocket): Promise<{ isDuplicate: boolean; sceneChanged: boolean; stored: boolean; reason?: string }> {
  // Just ingest into ring buffer — no AI call per frame
  const result = await visualMemory.ingestFrame(base64Image)
  const { isDuplicate, sceneChanged } = result

  if (!isDuplicate) {
    // TODO: Replace full-frame hash placeholder with per-face hashes after face detection is implemented.
    const frameHash = await computeFrameHash(base64Image)
    faceTracker.ingestFaces([frameHash])

    const stats = visualMemory.getStats()
    console.log(`[VisualMemory] Frame ingested (buffer: ${stats.bufferFrames}, dup: ${isDuplicate}, sceneΔ: ${sceneChanged})`)
  }

  return result
}

/**
 * Get visual context for AI (called as tool or on demand)
 * Returns deduped frames + memory summary for inclusion in AI context
 */
async function handleGetVisualContext(reason: string, senderWs: WebSocket) {
  const context = visualMemory.getVisualContext(reason)
  
  senderWs.send(JSON.stringify({
    type: 'visual_context_response',
    ...context,
    timestamp: Date.now(),
  }))

  return context
}

/**
 * Store a visual memory after AI has analyzed a scene
 */
async function handleStoreVisualMemory(data: {
  description: string
  tags?: string[]
  location?: string
}) {
  const context = visualMemory.getVisualContext('store_memory')
  if (context.currentFrames.length === 0) {
    console.log('[VisualMemory] No frames to store')
    return null
  }

  // Store the most recent frame with the AI's description
  const record = await visualMemory.storeMemory(
    data.description,
    context.currentFrames[context.currentFrames.length - 1],
    undefined,
    data.tags || [],
    data.location,
  )
  console.log(`[VisualMemory] Stored memory: "${data.description.substring(0, 60)}..."`)
  return record
}

// --- Slash command handler (Telegram-style with inline buttons) ---
function handleSlashCommand(text: string): any | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null

  const parts = trimmed.split(/\s+/)
  const cmd = parts[0].toLowerCase()
  const arg = parts.slice(1).join(' ')

  switch (cmd) {
    case '/help':
    case '/commands':
      return {
        type: 'speak',
        text: 'Available commands:',
        buttons: [
          [{ text: 'Status', callback_data: '/status' }, { text: 'Model', callback_data: '/model' }],
          [{ text: 'Think', callback_data: '/think' }, { text: 'TTS', callback_data: '/tts' }],
          [{ text: 'Usage', callback_data: '/usage' }, { text: 'Sessions', callback_data: '/sessions' }],
          [{ text: 'New Session', callback_data: '/new' }, { text: 'Reset', callback_data: '/reset' }],
        ],
      }

    case '/model':
      if (!arg) {
        return {
          type: 'speak',
          text: 'Choose a model provider:',
          buttons: [
            [{ text: 'OpenAI', callback_data: '/model openai' }],
            [{ text: 'Anthropic', callback_data: '/model anthropic' }],
          ],
        }
      }
      if (arg === 'openai') {
        return {
          type: 'speak',
          text: 'Choose an OpenAI model:',
          buttons: [
            [{ text: 'GPT-4o', callback_data: '/model set openai/gpt-4o' }],
            [{ text: 'GPT-5.2', callback_data: '/model set openai/gpt-5.2' }],
            [{ text: 'GPT-5.2 Codex', callback_data: '/model set openai/gpt-5.2-codex' }],
            [{ text: 'Back', callback_data: '/model' }],
          ],
        }
      }
      if (arg === 'anthropic') {
        return {
          type: 'speak',
          text: 'Choose an Anthropic model:',
          buttons: [
            [{ text: 'Claude Sonnet 4', callback_data: '/model set anthropic/claude-sonnet-4' }],
            [{ text: 'Claude Opus 4.6', callback_data: '/model set anthropic/claude-opus-4-6' }],
            [{ text: 'Back', callback_data: '/model' }],
          ],
        }
      }
      // "set" subcommand — forward to OpenClaw agent
      if (arg.startsWith('set ')) {
        return null  // Let agent handle the actual model switch
      }
      return null

    case '/think':
      return {
        type: 'speak',
        text: 'Set thinking level:',
        buttons: [
          [{ text: 'Off', callback_data: '/think off' }, { text: 'Low', callback_data: '/think low' }],
          [{ text: 'Medium', callback_data: '/think medium' }, { text: 'High', callback_data: '/think high' }],
        ],
      }

    case '/status':
      return null  // Forward to OpenClaw agent for real status

    case '/tts':
      return {
        type: 'speak',
        text: 'Text-to-Speech settings:',
        buttons: [
          [{ text: 'Enable TTS', callback_data: '/tts on' }, { text: 'Disable TTS', callback_data: '/tts off' }],
        ],
      }

    default:
      return null  // Unknown slash command → forward to agent
  }
}

// --- WebSocket server ---
const wss = new WebSocketServer({ port: WS_PORT, host: SERVER_HOST })
const clients = new Set<WebSocket>()
let bridgeRequestSeq = 0
let bridgeQueue: Promise<void> = Promise.resolve()
const pendingBridgeCompletions = new Map<string, { resolve: () => void, reject: (err: Error) => void, timer: ReturnType<typeof setTimeout> }>()

function enqueueBridgeSpeak<T>(task: () => Promise<T>): Promise<T> {
  const run = bridgeQueue.then(task)
  bridgeQueue = run.then(() => undefined, () => undefined)
  return run
}

function waitForBridgeCompletion(requestId: string, timeoutMs = 30000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingBridgeCompletions.delete(requestId)
      reject(new Error(`Timed out waiting for avatar playback completion (${requestId})`))
    }, timeoutMs)
    pendingBridgeCompletions.set(requestId, { resolve, reject, timer })
  })
}

function estimateBridgeSpeechMs(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return 800
  const words = trimmed.split(/\s+/).filter(Boolean).length
  const chars = [...trimmed].length
  const estimated = Math.max(words * 420, chars * 75) + 900
  return Math.max(1200, Math.min(estimated, 12000))
}

function completeBridgeRequest(requestId: string, error?: string): void {
  const pending = pendingBridgeCompletions.get(requestId)
  if (!pending) return
  clearTimeout(pending.timer)
  pendingBridgeCompletions.delete(requestId)
  if (error) pending.reject(new Error(error))
  else pending.resolve()
}

wss.on('connection', (ws, req) => {
  const remoteAddress = req.socket.remoteAddress
  if (ENFORCE_LOOPBACK_WS_CLIENTS && !isLoopbackAddress(remoteAddress)) {
    console.warn(`[ws-guard] Rejected non-loopback client ${remoteAddress || 'unknown'} (relay-only policy).`)
    ws.close(1008, 'relay-only')
    return
  }

  clients.add(ws)
  console.log(`Client connected (${clients.size} total)`)

  ws.on('message', async (data) => {
    // Handle binary audio data from Chrome extension
    if (data instanceof Buffer && (ws as any).__pendingAudioChunk) {
      const meta = (ws as any).__pendingAudioChunk
      delete (ws as any).__pendingAudioChunk
      console.log(`[chrome-audio] Received ${data.length} bytes`)
      // Save to temp file, convert with ffmpeg, transcribe with Whisper
      try {
        const tmpWebm = join(AUDIO_CACHE_DIR, `chunk_${Date.now()}.webm`)
        const tmpWav = tmpWebm.replace('.webm', '.wav')
        writeFileSync(tmpWebm, data)
        // Convert webm to wav for Whisper
        const { execSync } = await import('child_process')
        execSync(`ffmpeg -y -i "${tmpWebm}" -ar 16000 -ac 1 -acodec pcm_s16le "${tmpWav}" 2>/dev/null`, { timeout: 10000 })
        // Transcribe via Whisper API
        const apiKey = process.env.OPENAI_API_KEY ||
          (() => { try { return JSON.parse(readFileSync(resolve(import.meta.dirname ?? '.', '..', '..', '..', '.openclaw/openclaw.json'), 'utf-8')).skills?.entries?.['openai-whisper-api']?.apiKey } catch { return '' } })()
        if (apiKey) {
          const formData = new FormData()
          formData.append('file', new Blob([readFileSync(tmpWav)], { type: 'audio/wav' }), 'audio.wav')
          formData.append('model', 'whisper-1')
          const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${apiKey}` },
            body: formData,
          })
          if (resp.ok) {
            const result = await resp.json() as { text: string }
            const text = (result.text || '').trim()
            if (text && text.length > 1) {
              console.log(`[chrome-audio] Transcribed: "${text}"`)
              const meetingPrompt = `[Meeting Audio] Someone said: "${text}"\n\nRespond naturally if relevant.`
              handleUserSpeech(meetingPrompt, ws).catch(e => console.error('Meeting speech error:', e.message))
            }
          }
        }
        // Cleanup
        try { unlinkSync(tmpWebm) } catch {}
        try { unlinkSync(tmpWav) } catch {}
      } catch (e: any) {
        console.error('[chrome-audio] Processing error:', e.message)
      }
      return
    }

    const msg = data.toString()
    // Skip logging binary-looking messages
    if (msg.length < 500) console.log('Received:', msg)

    let parsed: any
    try { parsed = JSON.parse(msg) } catch { parsed = null }

    // Handle speak command - generate TTS then broadcast audio URL
    if (parsed?.type === 'speak' && parsed.text) {
      try {
        const audioUrl = await generateTTS(parsed.text)
        const audioMsg = JSON.stringify({
          type: 'speak_audio',
          audio_url: audioUrl,
          text: parsed.text,
          action_id: parsed.action_id,
          expression: parsed.expression,
          expression_weight: parsed.expression_weight,
        })
        // Send to ALL clients (including sender, so the frontend gets it)
        for (const client of clients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(audioMsg)
          }
        }
        console.log(`TTS generated: ${audioUrl}`)
      } catch (e: any) {
        console.error('TTS error:', e.message)
        ws.send(JSON.stringify({ type: 'tts_error', message: e.message }))
        // Still broadcast original speak command for fallback lip sync
        for (const client of clients) {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(msg)
          }
        }
      }
      return
    }

    // Handle camera_frame — ingest into visual memory ring buffer
    if (parsed?.type === 'camera_frame' && parsed.image) {
      try {
        const result = await handleCameraFrame(parsed.image, ws)
        if (result.stored) {
          console.log(`[VisualMemory] Auto-stored: ${result.reason || 'scene_change'}`)
        }
      } catch (e: any) {
        console.error('[VisualMemory] Frame ingest error:', e.message)
      }
      return
    }

    // Handle camera_active — toggle camera state
    if (parsed?.type === 'camera_active') {
      visualMemory.setCameraActive(!!parsed.active)
      // On camera open, immediately get context for initial greeting
      if (parsed.active) {
        // Give it a moment to receive first frame
        setTimeout(async () => {
          const context = visualMemory.getVisualContext('camera_opened')
          if (context.frameCount > 0) {
            ws.send(JSON.stringify({
              type: 'visual_context_response',
              reason: 'camera_opened',
              ...context,
              timestamp: Date.now(),
            }))
          }
        }, 3000)
      } else {
        // Clean up temp camera frames
        try {
          const tmpFiles = readdirSync('/tmp').filter(f => f.startsWith('camera-frame-') && f.endsWith('.jpg'))
          for (const f of tmpFiles) unlinkSync(`/tmp/${f}`)
          if (tmpFiles.length > 0) console.log(`[visual] Cleaned up ${tmpFiles.length} temp camera frames`)
        } catch {}
      }
      return
    }

    // Handle get_visual_context — AI requests visual info on demand
    if (parsed?.type === 'get_visual_context') {
      handleGetVisualContext(parsed.reason || 'user_request', ws).catch(e => {
        console.error('Visual context error:', e.message)
      })
      return
    }

    // Handle store_visual_memory — AI stores a scene description
    if (parsed?.type === 'store_visual_memory') {
      handleStoreVisualMemory({
        description: parsed.description || '',
        tags: parsed.tags,
        location: parsed.location,
      }).then(record => {
        ws.send(JSON.stringify({
          type: 'visual_memory_stored',
          success: !!record,
          record,
        }))
      }).catch(e => {
        console.error('[VisualMemory] Store error:', e.message)
        ws.send(JSON.stringify({ type: 'visual_memory_stored', success: false }))
      })
      return
    }

    // Handle get_visual_stats — debug info
    if (parsed?.type === 'get_visual_stats') {
      ws.send(JSON.stringify({
        type: 'visual_stats',
        ...visualMemory.getStats(),
      }))
      return
    }

    // Handle dismiss_face — user/model marks unknown face as passerby
    if (parsed?.type === 'dismiss_face' && parsed.faceHash) {
      faceTracker.dismissFace(parsed.faceHash)
      ws.send(JSON.stringify({ type: 'dismiss_face_result', success: true, faceHash: parsed.faceHash }))
      return
    }

    // Handle dismiss_speaker — user/model marks unknown speaker as not relevant
    if (parsed?.type === 'dismiss_speaker' && parsed.speakerLabel) {
      speakerTracker.dismissSpeaker(parsed.speakerLabel)
      ws.send(JSON.stringify({ type: 'dismiss_speaker_result', success: true, speakerLabel: parsed.speakerLabel }))
      return
    }

    // Handle memory_recall — quick entity recall from text
    if (parsed?.type === 'memory_recall' && parsed.text) {
      const context = entityStore.quickRecall(parsed.text)
      ws.send(JSON.stringify({ type: 'memory_recall_result', context, query: parsed.text }))
      return
    }

    // Handle memory_entities — list all known entities
    if (parsed?.type === 'memory_entities') {
      const entities = entityStore.listEntities()
      ws.send(JSON.stringify({ type: 'memory_entities_result', entities }))
      return
    }

    // Handle memory_update_entity — create or update an entity
    if (parsed?.type === 'memory_update_entity') {
      if (parsed.id) {
        const updated = entityStore.updateEntity(parsed.id, parsed.data || {})
        ws.send(JSON.stringify({ type: 'memory_entity_updated', success: !!updated, entity: updated }))
      } else {
        const created = entityStore.createEntity({ type: 'person', ...parsed.data })
        ws.send(JSON.stringify({ type: 'memory_entity_updated', success: true, entity: created }))
      }
      return
    }

    // Handle get_memory_stats — full multimodal memory stats
    if (parsed?.type === 'get_memory_stats') {
      ws.send(JSON.stringify({
        type: 'memory_stats',
        ...multimodalMemory.getStats(),
      }))
      return
    }

    // Handle get_memory_context — AI-readable memory context
    if (parsed?.type === 'get_memory_context') {
      ws.send(JSON.stringify({
        type: 'memory_context',
        context: multimodalMemory.buildContextForAI(),
      }))
      return
    }

    // Handle add_semantic_memory — manually add a fact/preference
    if (parsed?.type === 'add_semantic_memory' && parsed.knowledge) {
      multimodalMemory.addSemantic({
        knowledge: parsed.knowledge,
        entityIds: parsed.entityIds || ['user'],
        source: parsed.source || 'conversation',
      })
      ws.send(JSON.stringify({ type: 'semantic_memory_added', success: true }))
      return
    }

    // Handle device registration for multi-device sync
    if (parsed?.type === 'register_device') {
      const info: DeviceInfo = {
        ws,
        deviceId: parsed.deviceId || randomUUID(),
        deviceType: parsed.deviceType || 'unknown', // 'ios', 'macos', 'watchos', 'web'
        name: parsed.name || 'Unknown Device',
        streamingMode: false,
      }
      devices.set(info.deviceId, info)
      ws.send(JSON.stringify({ type: 'registered', deviceId: info.deviceId, connectedDevices: getDeviceList() }))
      // Notify all devices of the updated device list
      broadcastDeviceList()
      // Push backend-authoritative snapshot immediately on registration.
      sendBackendStateSnapshot(ws, info.deviceId)
      console.log(`Device registered: ${info.name} (${info.deviceType}) — ${devices.size} devices total`)
      return
    }

    // Handle audio_chunk from Chrome extension — binary audio follows this JSON message
    if (parsed?.type === 'audio_chunk' && parsed.size > 0) {
      // Next binary message will contain the audio data
      (ws as any).__pendingAudioChunk = parsed
      return
    }

    // Handle meeting_response — bridge already has AI response, just do TTS + broadcast
    if (parsed?.type === 'meeting_response' && parsed.text) {
      console.log(`[meeting] Speaking: "${parsed.text}"`)
      const { action_id, expression, expression_weight } = pickAction(parsed.text)
      try {
        const audioUrl = await generateTTS(parsed.text)
        const msg = JSON.stringify({
          type: 'speak_audio',
          audio_url: audioUrl,
          text: parsed.text,
          action_id,
          expression,
          expression_weight,
        })
        for (const client of clients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(msg)
          }
        }
        console.log(`[meeting] TTS sent: ${action_id}, ${expression}`)
      } catch (e: any) {
        console.error('[meeting] TTS error:', e.message)
        // Fallback: send text without audio
        const fallback = JSON.stringify({ type: 'speak', text: parsed.text, action_id, expression, expression_weight })
        for (const client of clients) {
          if (client.readyState === WebSocket.OPEN) client.send(fallback)
        }
      }
      return
    }

    // Relay speak_audio from meeting bridge (or any client) to all OTHER clients
    if (parsed?.type === 'speak_audio' && parsed.audio_url) {
      console.log(`[relay] speak_audio: "${(parsed.text || '').slice(0, 60)}..."`)
      const raw = typeof data === 'string' ? data : data.toString()
      for (const client of clients) {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          client.send(raw)
        }
      }
      return
    }

    // Handle meeting_speech — transcribed audio from virtual meeting bridge
    // Routes through OpenClaw MAIN session (full context: MEMORY.md, SOUL.md, project knowledge)
    if (parsed?.type === 'meeting_speech' && parsed.text) {
      const transcript = parsed.transcript || ''
      const reason = parsed.reason || 'triggered'
      const mode = parsed.mode || 'triggered'
      const speakerLabel = parsed.speakerLabel || parsed.speaker_label
      const sentenceCount = Number.isFinite(parsed.sentenceCount)
        ? parsed.sentenceCount
        : Number.isFinite(parsed.sentence_count)
          ? parsed.sentence_count
          : estimateSentenceCount(parsed.text)

      if (speakerLabel) {
        speakerTracker.ingestSpeech(speakerLabel, sentenceCount, new Set<string>())
      }

      console.log(`[meeting] ${mode}: "${parsed.text.slice(0, 80)}..." (${reason})`)

      // Fast-path for explicit relay/gateway speak dispatch requests in meeting mode.
      const directMeetingCommand = parseDirectRelaySpeakCommand(parsed.text)
      if (directMeetingCommand) {
        const meetingBroadcast = (msg: Record<string, any>) => {
          if (!hasExplicitRoutingFields(msg)) {
            msg.audio_device = 'meeting'
          }
          const raw = JSON.stringify(msg)
          for (const client of clients) {
            if (client.readyState === WebSocket.OPEN) {
              client.send(raw)
            }
          }
        }
        try {
          const dispatchResult = await dispatchDirectRelaySpeakCommand(directMeetingCommand, meetingBroadcast)
          console.log(
            `[meeting-direct-relay] dispatched ${dispatchResult.resolvedType} to ${summarizeRouteTargets(directMeetingCommand.targets)}`,
          )
        } catch (error: any) {
          console.error(`[meeting-direct-relay] failed: ${error?.message || error}`)
          meetingBroadcast({
            type: 'speak',
            text: 'I could not dispatch that relay speak command.',
            action_id: '88_Thinking',
            expression: 'neutral',
            expression_weight: 0.5,
          })
        }
        return
      }
      
      const meetingPrompt = mode === 'proactive'
        ? `[MEETING MODE — Proactive] You are currently in a live Google Meet meeting as a virtual avatar. There's been a pause. Based on the transcript, share a brief insight or ask a question. Be concise (1-2 sentences). If nothing to add, just say one short sentence acknowledging the pause.\n\n[Meeting Transcript]\n${transcript}\n\n[Respond in the same language as the meeting.]\n[Do not tell users to manually send WebSocket/gateway JSON commands.]`
        : `[MEETING MODE — Triggered] You are currently in a live Google Meet meeting as a virtual avatar. Someone just spoke and it's directed at you or relevant. Respond naturally using your full knowledge.\n\n[Meeting Transcript]\n${transcript}\n\n[Latest speech] "${parsed.text}"\n[Trigger reason] ${reason}\n\n[IMPORTANT: Keep response concise (2-4 sentences). Use the same language as the speaker. Reference your knowledge of the Clawatar project, your capabilities, development timeline, etc. when relevant. Do not tell users to manually send WebSocket/gateway JSON commands.]`
      
      handleMeetingSpeech(meetingPrompt, ws).catch(e => {
        console.error('Meeting speech handling error:', e.message)
      })
      return
    }

    // Toggle streaming-audio mode for this connection
    if (parsed?.type === 'set_streaming_mode') {
      const enabled = !!parsed.enabled
      // Update device registry
      const devId = findDeviceIdByWs(ws)
      if (devId) {
        const dev = devices.get(devId)
        if (dev) dev.streamingMode = enabled
      }
      // Fallback flag for unregistered clients
      ;(ws as any).__streamingMode = enabled
      ws.send(JSON.stringify({ type: 'streaming_mode', enabled }))
      console.log(`[streaming] Device ${devId || '?'} streaming mode → ${enabled}`)
      return
    }

    // Handle user_speech — check for slash commands first, then send to OpenClaw agent
    if (parsed?.type === 'user_speech' && parsed.text) {
      const sourceDevice = parsed.source_device || findDeviceIdByWs(ws)
      const sourceDeviceKey = resolveSourceDeviceKey(sourceDevice, ws)
      const now = Date.now()
      if (shouldDropDuplicateUserSpeech(parsed.text, sourceDeviceKey, now)) {
        console.log(`[dedup] Dropped duplicate user_speech from ${sourceDeviceKey}: "${String(parsed.text).slice(0, 80)}"`)
        return
      }

      const slashResponse = handleSlashCommand(parsed.text)
      if (slashResponse) {
        // Slash command handled locally — broadcast response with buttons
        const msg = JSON.stringify(slashResponse)
        for (const client of clients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(msg)
          }
        }
        return
      }

      const speakerLabel = parsed.speakerLabel || parsed.speaker_label
      const sentenceCount = Number.isFinite(parsed.sentenceCount)
        ? parsed.sentenceCount
        : Number.isFinite(parsed.sentence_count)
          ? parsed.sentence_count
          : estimateSentenceCount(parsed.text)
      if (speakerLabel) {
        speakerTracker.ingestSpeech(speakerLabel, sentenceCount, new Set<string>())
      }

      // Pass source_device for focus-based audio routing
      handleUserSpeech(parsed.text, ws, sourceDevice).catch(e => {
        console.error('User speech handling error:', e.message)
        ws.send(JSON.stringify({ type: 'tts_error', message: e.message }))
      })
      return
    }

    if (parsed?.type === 'avatar_performance_complete' && typeof parsed.request_id === 'string') {
      completeBridgeRequest(parsed.request_id)
      return
    }

    if (parsed?.type === 'avatar_performance_error' && typeof parsed.request_id === 'string') {
      completeBridgeRequest(parsed.request_id, typeof parsed.message === 'string' ? parsed.message : 'avatar performance error')
      return
    }

    // Don't re-broadcast ack/status messages — they're responses, not commands
    if (parsed?.status) {
      // Status messages are replies to the sender only; don't flood other clients
      return
    }

    // Backend-authoritative sync handling.
    if (parsed?.type === 'sync' && isObjectRecord(parsed)) {
      const handled = handleAuthoritativeSyncEnvelope(parsed, ws)
      if (handled) {
        return
      }
    }

    // Default: broadcast to all other clients
    for (const client of clients) {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        client.send(msg)
      }
    }
  })

  ws.on('close', () => {
    clients.delete(ws)
    // Remove from device registry
    for (const [id, info] of devices) {
      if (info.ws === ws) {
        devices.delete(id)
        console.log(`Device unregistered: ${info.name} (${info.deviceType})`)
        broadcastDeviceList()
        break
      }
    }
    console.log(`Client disconnected (${clients.size} total)`)
  })
})

console.log(`WebSocket server running on ws://${SERVER_HOST}:${WS_PORT}`)
if (ENFORCE_LOOPBACK_WS_CLIENTS) {
  console.log(`[ws-guard] Loopback-only client policy enabled. Set CLAWATAR_ALLOW_REMOTE_WS_CLIENTS=1 to allow remote WS clients.`)
}
logNetworkEndpoints()

// stdin relay
process.stdin.setEncoding('utf-8')
process.stdin.on('data', (input: string) => {
  const trimmed = input.trim()
  if (!trimmed) return
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(trimmed)
    }
  }
  console.log(`Sent to ${clients.size} clients: ${trimmed}`)
})
