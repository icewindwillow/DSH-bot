/**
 * 骰子解析与投掷。
 *
 * 支持的写法：
 *   1d20            普通骰
 *   2d6+1d4-1       多组骰子 + 常数修正
 *   4d6kh3          keep highest：4d6 取最高的 3 个
 *   2d20kl1         keep lowest：2d20 取最低的 1 个（劣势）
 *   d100            省略数量默认为 1
 *   1d100b1 / 1d100p1   COC 7e 的奖励骰 / 惩罚骰（b=bonus, p=penalty）
 *
 * 全部使用 crypto 随机源，避免 Math.random 的可预测性。
 */
import { randomInt } from 'node:crypto';

const TOKEN_RE = /^([+-]?)(\d*)d(\d+)(?:(kh|kl)(\d+))?(?:([bp])(\d+))?$/i;
const CONST_RE = /^([+-]?)(\d+)$/;

const face = (sides) => randomInt(1, sides + 1);

/** COC 百分骰：tens 骰决定十位，units 骰决定个位；0/0 记作 100 */
function rollPercentile(bonusDice = 0, penaltyDice = 0) {
  const pool = Math.max(bonusDice, penaltyDice) + 1;
  const tens = [];
  for (let i = 0; i < pool; i += 1) tens.push(randomInt(0, 10));
  const units = randomInt(0, 10);
  const toValue = (t) => (t === 0 && units === 0 ? 100 : t * 10 + units);
  const values = tens.map(toValue);
  const pick = bonusDice > 0 ? Math.max(...values) : penaltyDice > 0 ? Math.min(...values) : values[0];
  const dropped = values.filter((v) => v !== pick);
  return {
    total: pick,
    note: `d100${bonusDice ? ` 奖励骰×${bonusDice}` : ''}${penaltyDice ? ` 惩罚骰×${penaltyDice}` : ''} → 十位 [${tens.join(', ')}] 个位 ${units}`,
    dropped,
  };
}

/** 解析单个骰子项并投掷 */
function rollTerm(token) {
  const diceMatch = token.match(TOKEN_RE);
  if (diceMatch) {
    const sign = diceMatch[1] === '-' ? -1 : 1;
    const count = diceMatch[2] === '' ? 1 : Number(diceMatch[2]);
    const sides = Number(diceMatch[3]);
    const keepMode = diceMatch[4];
    const keepCount = diceMatch[5] === undefined ? undefined : Number(diceMatch[5]);
    const cocMode = diceMatch[6] === undefined ? undefined : diceMatch[6].toLowerCase();
    const cocCount = diceMatch[7] === undefined ? undefined : Number(diceMatch[7]);

    if (count < 1 || count > 100) throw new Error('骰子数量需要在 1–100 之间');
    if (sides < 2 || sides > 1000) throw new Error('骰子面数需要在 2–1000 之间');
    if (keepCount !== undefined && (keepCount < 1 || keepCount > count))
      throw new Error('kh/kl 的保留数量必须在 1 到骰子数量之间');

    if (cocMode !== undefined) {
      if (sides !== 100) throw new Error('奖励骰 / 惩罚骰只能用于 d100');
      if (count !== 1) throw new Error('奖励骰 / 惩罚骰只支持 1d100');
      const bonus = cocMode === 'b' ? cocCount : 0;
      const penalty = cocMode === 'p' ? cocCount : 0;
      const result = rollPercentile(bonus, penalty);
      return {
        sign,
        subtotal: result.total,
        detail: result.note + (result.dropped.length ? `（舍弃 ${result.dropped.join(', ')}）` : ''),
      };
    }

    const faces = [];
    for (let i = 0; i < count; i += 1) faces.push(face(sides));

    let kept = faces;
    let keepNote = '';
    if (keepMode !== undefined) {
      const sorted = [...faces].sort((a, b) => (keepMode === 'kh' ? b - a : a - b));
      kept = sorted.slice(0, keepCount);
      keepNote = '';
    }
    const subtotal = kept.reduce((sum, v) => sum + v, 0);
    const flat = keepMode !== undefined
      ? `${faces.join(' + ')} → ${kept.join(' + ')} = ${subtotal}`
      : (kept.length === 1 ? `${kept[0]}` : `${kept.join(' + ')} = ${subtotal}`);
    return { sign, subtotal, detail: `${count}d${sides}: ${flat}` };
  }

  const constMatch = token.match(CONST_RE);
  if (constMatch) {
    const sign = constMatch[1] === '-' ? -1 : 1;
    return { sign, subtotal: Number(constMatch[2]), detail: constMatch[2] };
  }

  throw new Error(`看不懂这个骰子写法：${token}`);
}

/**
 * 投掷一个完整表达式。
 * @param {string} expression - 例如 "2d20kh1+5"、"4d6"、"1d100b1"
 * @returns {{ expression: string, total: number, detail: string, negative: boolean }}
 */
export function rollDice(expression) {
  const raw = String(expression ?? '').trim();
  if (raw === '') throw new Error('需要给出骰子表达式，例如 1d20+5');
  // 允许空格与中文逗号，统一处理
  const normalized = raw.replace(/\s+/g, '').replace(/，/g, '+').toLowerCase();
  // 在 +/- 处切分，但保留符号
  const tokens = normalized.match(/[+-]?[^+-]+/g);
  if (!tokens || tokens.length === 0) throw new Error(`无法解析：${expression}`);

  let total = 0;
  const details = [];
  for (const token of tokens) {
    const term = rollTerm(token);
    total += term.sign * term.subtotal;
    details.push((term.sign < 0 ? '− ' : '') + term.detail);
  }
  return {
    expression: raw,
    total,
    detail: details.join('；'),
  };
}
