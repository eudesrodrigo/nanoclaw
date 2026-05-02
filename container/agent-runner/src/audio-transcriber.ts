import type { MessageInRow } from './db/messages-in.js';

const MAX_AUDIO_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB — Gemini inline limit

function log(msg: string): void {
  console.error(`[audio-transcriber] ${msg}`);
}

interface AudioAttachment {
  type: string;
  data?: string;
  mimeType?: string;
  name?: string;
  size?: number;
  transcription?: string;
  transcriptionError?: string;
  [key: string]: unknown;
}

function extractFormat(mimeType: string | undefined): string {
  if (!mimeType) return 'ogg';
  // "audio/ogg" → "ogg", "audio/mp3" → "mp3"
  const parts = mimeType.split('/');
  return parts[1] || 'ogg';
}

async function transcribeAudio(base64Data: string, format: string, model: string): Promise<string> {
  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  if (!baseUrl) throw new Error('ANTHROPIC_BASE_URL not set');

  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN || 'placeholder';

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Transcribe this audio message exactly as spoken, in its original language. Return only the transcription text, nothing else.',
            },
            {
              type: 'input_audio',
              input_audio: { data: base64Data, format },
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${response.status} ${body.slice(0, 200)}`);
  }

  const result = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = result.choices?.[0]?.message?.content;
  if (!text) throw new Error('Empty transcription response');
  return text.trim();
}

export async function transcribeAudioInMessages(
  messages: MessageInRow[],
  config: { model: string },
): Promise<void> {
  for (const msg of messages) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(msg.content);
    } catch {
      continue;
    }

    const attachments = parsed.attachments as AudioAttachment[] | undefined;
    if (!Array.isArray(attachments)) continue;

    let changed = false;
    for (const att of attachments) {
      if (att.type !== 'audio' || !att.data) continue;

      const rawSize = att.data.length * 0.75; // base64 → bytes estimate
      if (rawSize > MAX_AUDIO_SIZE_BYTES) {
        log(`Skipping oversized audio (${Math.round(rawSize / 1024 / 1024)}MB) in ${msg.id}`);
        att.transcriptionError = 'Audio too large for inline transcription';
        delete att.data;
        changed = true;
        continue;
      }

      const format = extractFormat(att.mimeType);
      try {
        log(`Transcribing audio (${att.mimeType}, ~${Math.round(rawSize / 1024)}KB) via ${config.model}`);
        att.transcription = await transcribeAudio(att.data, format, config.model);
        log(`Transcribed: "${att.transcription.slice(0, 100)}${att.transcription.length > 100 ? '…' : ''}"`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log(`Transcription failed for ${msg.id}: ${errMsg}`);
        att.transcriptionError = errMsg;
      }

      delete att.data;
      changed = true;
    }

    if (changed) {
      msg.content = JSON.stringify(parsed);
    }
  }
}
