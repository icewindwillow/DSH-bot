const codexName = /\b(?:Codex|GPT|SOL|Astra|OpenAI)\b/iu;
const dshName = /(?:\bDSH\b|\bDeepSeek\b|\bGLM\b|\bKimi\b|\bQwen\b|深度求索|智谱|月之暗面|通义)/iu;
const codexIntent = /(?:代码审查|架构审查|\breview\b|PPTX|PPT|幻灯片|演示文稿)/iu;
const parallelIntent = /(?:同时|一起|并行|各自|分别|两个版本|两份|双版本|各做|都做|都要)/u;
const noParallelIntent = /(?:不要|别|不用|不需要)(?:一起|同时|并行|各自|都做)/u;

function modelOf(intent) {
  const model = typeof intent?.model === 'string' ? intent.model.trim() : '';
  const provider = typeof intent?.provider === 'string' ? intent.provider.trim() : '';
  return { ...(model && { model }), ...(provider && { provider }) };
}

/**
 * Choose the execution lane from the user's original message.
 *
 * Explicit lane names always beat content keywords such as "PPT" or "review".
 * When both lanes are named together with a parallel word, both run.
 * An intent already produced by the LLM classifier takes precedence.
 */
export function selectTaskBackend(text, { intent, forceDsh = false } = {}) {
  const value = String(text ?? '').trim();
  if (intent?.parallel === true || intent?.backend === 'both') {
    return { backend: 'both', ...modelOf(intent) };
  }
  if (intent?.backend === 'codex') return { backend: 'codex', ...modelOf(intent) };
  if (intent?.backend === 'dsh') return { backend: 'dsh', ...modelOf(intent) };

  const wantsCodex = codexName.test(value);
  const wantsDsh = dshName.test(value);
  if (wantsCodex && wantsDsh && parallelIntent.test(value) && !noParallelIntent.test(value)) return { backend: 'both' };
  if (wantsDsh && !wantsCodex) return { backend: 'dsh' };
  if (forceDsh && !wantsCodex) return { backend: 'dsh' };
  if (wantsCodex && !wantsDsh) return { backend: 'codex' };
  if (wantsDsh && wantsCodex) return { backend: 'codex' };
  return codexIntent.test(value) ? { backend: 'codex' } : { backend: 'dsh' };
}
