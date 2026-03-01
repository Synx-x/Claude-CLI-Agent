import { OPENROUTER_API_KEY } from './config.js';

export interface OpenRouterModel {
  id: string;
  name: string;
  isFree: boolean;
}

let cachedModels: OpenRouterModel[] | null = null;

export async function fetchOpenRouterModels(): Promise<OpenRouterModel[]> {
  if (cachedModels) return cachedModels;
  const res = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}` },
  });
  if (!res.ok) throw new Error(`OpenRouter models fetch failed: ${res.status}`);
  const json = await res.json() as {
    data: Array<{ id: string; name: string; pricing: { prompt: string; completion: string } }>;
  };
  cachedModels = json.data
    .map(m => ({
      id: m.id,
      name: m.name,
      isFree: m.pricing.prompt === '0' && m.pricing.completion === '0',
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return cachedModels;
}

export async function runOpenRouter(message: string, model: string): Promise<string> {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: `You are ${model}, running via OpenRouter. If asked what model you are, say "${model} via OpenRouter".` },
        { role: 'user', content: message },
      ],
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${err}`);
  }
  const json = await res.json() as { choices?: Array<{ message: { content: string } }> };
  return json.choices?.[0]?.message?.content ?? '(no response)';
}
