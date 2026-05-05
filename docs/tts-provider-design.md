# Clawatar TTS Provider Design

## Goal

Refactor Clawatar's hardcoded ElevenLabs speech path into a small provider abstraction that supports:

1. **ElevenLabs streaming** (existing behavior)
2. **OpenAI-compatible batch TTS** (for Kokoros and similar local endpoints)

## Why

Current state:
- `server/ws-server.ts` is tightly coupled to ElevenLabs
- batch-ish speech (`generateTTS`) is still ElevenLabs-only
- streaming voice mode depends on ElevenLabs WebSocket streaming

Desired state:
- provider selected by config
- streaming-capable providers use low-latency streaming path
- batch-only providers degrade gracefully by collecting full text before synthesis

## Proposed Config Shape

```json5
{
  voice: {
    provider: "openai-compatible", // or "elevenlabs"

    elevenlabs: {
      voiceId: "...",
      model: "eleven_turbo_v2_5",
      apiKey: "${ELEVENLABS_API_KEY}"
    },

    openaiCompatible: {
      endpoint: "http://127.0.0.1:8772/v1/audio/speech",
      model: "tts-1",
      voice: "af_bella",
      responseFormat: "mp3",
      apiKey: "" // optional, usually empty for local Kokoros
    }
  }
}
```

## Provider Interface

```ts
interface TtsProvider {
  kind: 'streaming' | 'batch'

  synthesize(text: string): Promise<{ audioUrl: string }>

  synthesizeStreaming?(args: {
    messages: Array<{ role: string; content: any }>
    sessionKey: string
    broadcastToClients: (msg: any) => void
    getVoiceSystemPrompt: () => string
    pickAction: (text: string) => { action_id: string; expression: string; expression_weight: number }
  }): Promise<{ text: string; firstChunkMs: number }>
}
```

## Behavioral Rules

### If provider is `elevenlabs`
- preserve current behavior
- `generateTTS()` uses REST/stream endpoint
- `streamingAudioPipeline()` uses ElevenLabs WS streaming path

### If provider is `openai-compatible`
- `generateTTS()` uses one HTTP POST to `/v1/audio/speech`
- `streamingTTS()` becomes collect-then-synthesize batch mode
- `streamingAudioPipeline()` becomes collect full LLM output, then batch synthesize, then emit audio result

## Non-goals for this pass

- true token-streaming OpenAI-compatible TTS
- multi-provider runtime failover
- browser-side TTS provider switching
- generalized plugin framework

## Minimal Refactor Plan

1. Extract provider config resolution from `ws-server.ts`
2. Add provider discriminator (`elevenlabs` | `openai-compatible`)
3. Move current ElevenLabs code into provider-specific helpers
4. Add OpenAI-compatible batch helper
5. Route `generateTTS()` through provider selector
6. Route `streamingAudioPipeline()` based on provider kind
7. Keep changes small and local to `server/ws-server.ts` for first pass

## First Target

Get this working cleanly for Annie's local stack:
- provider: `openai-compatible`
- endpoint: `http://127.0.0.1:8772/v1/audio/speech`
- voice: `af_bella`
- model: `tts-1`
