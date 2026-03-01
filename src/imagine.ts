import { GoogleGenAI } from '@google/genai';
import { GOOGLE_API_KEY } from './config.js';

const MODEL = 'gemini-3.1-flash-image-preview';

export async function generateImage(prompt: string): Promise<Buffer> {
  if (!GOOGLE_API_KEY) throw new Error('GOOGLE_API_KEY not set in .env');

  const ai = new GoogleGenAI({ apiKey: GOOGLE_API_KEY });

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      responseModalities: ['IMAGE', 'TEXT'],
    },
  });

  const parts = response.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    if (part.inlineData?.data) {
      return Buffer.from(part.inlineData.data, 'base64');
    }
  }

  throw new Error('No image returned from Gemini');
}
