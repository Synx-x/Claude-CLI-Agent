import { readFileSync, renameSync } from 'fs';
import { basename, dirname, resolve } from 'path';
import { request } from 'https';
import { GROQ_API_KEY, OPENAI_API_KEY, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, GOOGLE_API_KEY, UNREAL_SPEECH_API_KEY } from './config.js';
import { logger } from './logger.js';

export function voiceCapabilities(): { sttGroq: boolean; sttOpenai: boolean; tts: boolean } {
  return {
    sttGroq: !!GROQ_API_KEY,
    sttOpenai: !!OPENAI_API_KEY,
    tts: !!(ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID) || !!OPENAI_API_KEY || !!UNREAL_SPEECH_API_KEY,
  };
}

function ensureOgg(filePath: string): string {
  if (filePath.endsWith('.oga')) {
    const newPath = filePath.replace(/\.oga$/, '.ogg');
    renameSync(filePath, newPath);
    return newPath;
  }
  return filePath;
}

export async function transcribeAudioGroq(filePath: string): Promise<string> {
  const finalPath = ensureOgg(filePath);
  const fileData = readFileSync(finalPath);
  const fileName = basename(finalPath);
  const boundary = `----FormBoundary${Date.now()}`;

  const parts: Buffer[] = [];
  // file field
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: audio/ogg\r\n\r\n`
  ));
  parts.push(fileData);
  parts.push(Buffer.from('\r\n'));
  // model field
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-large-v3\r\n`
  ));
  parts.push(Buffer.from(`--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  return new Promise((resolve, reject) => {
    const req = request({
      hostname: 'api.groq.com',
      path: '/openai/v1/audio/transcriptions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const responseBody = Buffer.concat(chunks).toString();
        try {
          const json = JSON.parse(responseBody);
          resolve(json.text ?? '');
        } catch {
          reject(new Error(`Groq STT parse error: ${responseBody}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

export async function transcribeAudioOpenai(filePath: string): Promise<string> {
  const { default: OpenAI } = await import('openai');
  const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  const { createReadStream } = await import('fs');

  const transcription = await openai.audio.transcriptions.create({
    file: createReadStream(filePath),
    model: 'whisper-1',
  });

  return transcription.text;
}

export async function transcribeAudio(filePath: string): Promise<string> {
  const caps = voiceCapabilities();
  if (caps.sttGroq) {
    return transcribeAudioGroq(filePath);
  }
  if (caps.sttOpenai) {
    return transcribeAudioOpenai(filePath);
  }
  throw new Error('No STT provider configured');
}

async function synthesizeSpeechElevenLabs(text: string): Promise<Buffer> {
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
    throw new Error('ElevenLabs not configured');
  }

  const payload = JSON.stringify({
    text,
    model_id: 'eleven_turbo_v2_5',
    voice_settings: { stability: 0.5, similarity_boost: 0.75 },
  });

  return new Promise((resolvePromise, reject) => {
    const req = request({
      hostname: 'api.elevenlabs.io',
      path: `/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          const body = Buffer.concat(chunks).toString();
          reject(new Error(`ElevenLabs error ${res.statusCode}: ${body}`));
          return;
        }
        resolvePromise(Buffer.concat(chunks));
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function synthesizeSpeechOpenAI(text: string): Promise<Buffer> {
  if (!OPENAI_API_KEY) {
    throw new Error('OpenAI not configured');
  }

  const { default: OpenAI } = await import('openai');
  const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  const response = await openai.audio.speech.create({
    model: 'tts-1',
    voice: 'alloy',
    input: text,
    response_format: 'mp3',
  });
  return Buffer.from(await response.arrayBuffer());
}

async function synthesizeSpeechUnrealSpeech(text: string): Promise<Buffer> {
  if (!UNREAL_SPEECH_API_KEY) {
    throw new Error('Unreal Speech not configured');
  }

  const payload = JSON.stringify({
    Text: text,
    VoiceId: 'Scarlett',
    Bitrate: '192k',
    Speed: '0',
    Pitch: '1',
    OutputFormat: 'uri',
  });

  return new Promise((resolvePromise, reject) => {
    const req = request({
      hostname: 'api.v7.unrealspeech.com',
      path: '/speech',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${UNREAL_SPEECH_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', async () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`Unreal Speech error ${res.statusCode}: ${Buffer.concat(chunks).toString()}`));
          return;
        }
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString());
          const audioUrl: string = json.OutputUri;
          // Fetch the MP3 from the returned URL
          const urlObj = new URL(audioUrl);
          const audioReq = request({
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: 'GET',
          }, (audioRes) => {
            const audioChunks: Buffer[] = [];
            audioRes.on('data', (c: Buffer) => audioChunks.push(c));
            audioRes.on('end', () => resolvePromise(Buffer.concat(audioChunks)));
          });
          audioReq.on('error', reject);
          audioReq.end();
        } catch (err) {
          reject(new Error(`Failed to parse Unreal Speech response: ${err}`));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

export async function synthesizeSpeech(text: string): Promise<Buffer> {
  if (ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID) {
    try {
      return await synthesizeSpeechElevenLabs(text);
    } catch (err) {
      logger.warn({ err }, 'ElevenLabs TTS failed, trying OpenAI');
    }
  }

  if (OPENAI_API_KEY) {
    try {
      return await synthesizeSpeechOpenAI(text);
    } catch (err) {
      logger.warn({ err }, 'OpenAI TTS failed, trying Unreal Speech');
    }
  }

  if (UNREAL_SPEECH_API_KEY) {
    return await synthesizeSpeechUnrealSpeech(text);
  }

  throw new Error('No TTS provider configured');
}
