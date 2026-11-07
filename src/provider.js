/**
 * The metered AI call: an OpenAI-compatible chat-completions request using
 * the owner's server-side key. The prompt is the same strict extractor
 * prompt the Android app uses in BYOK mode (BibleService.parseWithAI), sent
 * as a single user message, so credits mode behaves identically.
 * Returns null from the factory when no provider is configured.
 */

export function buildPrompt(rawText) {
  return `You are a strict extractor. Output ONLY the final answer. No preamble, no explanation, no <think> tags, no reasoning, no markdown.
Task: Extract Bible references (Book, Chapter, Verse) from the transcript.

Rules:
1. Return ONLY the USFM code(s) in the format BOOK.CHAPTER.VERSE the book is a 3 character code (e.g., JHN.3.16).
2. If multiple references are found, return them separated by commas.
3. If a range of verses is specified in the same chapter return it as a range (e.g., JHN.3.16-18).
4. If NO valid reference (Book + Chapter at minimum) is found, return 'NONE'.
5. The reference might be "sandwiched" in the middle of long speech.
6. Ignore partial mentions like just a book name without a chapter.

Transcript: "${rawText}"`;
}

function extractContent(json) {
  const msg = json && json.choices && json.choices[0] && json.choices[0].message;
  if (!msg) return null;
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.filter((p) => p && p.type === 'text').map((p) => p.text || '').join('');
  }
  return null;
}

export function createProvider(cfg, fetchImpl = fetch) {
  if (!cfg.providerBaseUrl || !cfg.providerApiKey || !cfg.providerModel) return null;
  const isOpenRouter = cfg.providerBaseUrl.includes('openrouter.ai');

  return {
    /**
     * Resolves to { result, costMicros (integer | null), usage (raw | null) }.
     * costMicros is the provider-reported cost when the API reports one
     * (OpenRouter usage.cost, in USD). It is informational only — users are
     * charged a flat 1 credit per successful call, never the provider cost.
     */
    async format(text) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), cfg.providerTimeoutMs);
      let res;
      try {
        const body = {
          model: cfg.providerModel,
          temperature: 0,
          max_tokens: 512,
          messages: [{ role: 'user', content: buildPrompt(text) }],
        };
        if (isOpenRouter) body.usage = { include: true };
        res = await fetchImpl(`${cfg.providerBaseUrl}/chat/completions`, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${cfg.providerApiKey}`,
          },
          body: JSON.stringify(body),
        });
      } catch (e) {
        const err = new Error(`AI provider unreachable: ${e.message}`);
        err.status = 502;
        err.error = 'provider_error';
        throw err;
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        const err = new Error(`AI provider returned HTTP ${res.status}`);
        err.status = 502;
        err.error = 'provider_error';
        throw err;
      }
      const json = await res.json();
      const content = extractContent(json);
      if (content === null || content.trim() === '') {
        const err = new Error('AI provider returned an unreadable response');
        err.status = 502;
        err.error = 'provider_error';
        throw err;
      }
      let costMicros = null;
      if (json.usage && Number.isFinite(json.usage.cost)) {
        costMicros = Math.max(0, Math.round(json.usage.cost * 1_000_000));
      }
      return { result: content.trim(), costMicros, usage: json.usage || null };
    },
  };
}
