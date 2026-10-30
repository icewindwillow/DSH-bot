/**
 * dsh-tabletop —— 跑团小工具集：
 *   roll_dice   掷骰（DND / COC 记法）
 *   draw_tarot  塔罗抽牌（韦特 78 张）
 *
 * 设计成零依赖：工具定义直接使用 JSON Schema，不引入 @deepseek-ai/dsh-tools，
 * 这样以本地目录 link 安装时也不会出现模块解析问题。
 * 纯本地计算，不联网、不读文件；随机源为 node:crypto。
 */
import { rollDice } from './lib/dice.js';
import { drawTarot } from './lib/tarot.js';

export const name = 'dsh-tabletop';
export const inject = ['tools'];

function formatDice(result) {
  return `🎲 ${result.expression} = **${result.total}**\n${result.detail}`;
}

function formatTarot(result) {
  const lines = [];
  if (result.question) lines.push(`问题：${result.question}`);
  lines.push(`牌阵：${result.spread}`);
  for (const card of result.cards) {
    lines.push(`· ${card.position}：${card.name}（${card.alt}）${card.orientation} — ${card.meaning}`);
  }
  return lines.join('\n');
}

const rollDiceTool = {
  name: 'roll_dice',
  description: [
    '掷骰子，返回真实随机结果。expression 支持 DND 记法与 COC 百分骰：',
    '1d20+5、2d6+1d4、4d6kh3（取最高 3 个）、2d20kl1（劣势）、',
    '1d100b1（COC 奖励骰）、1d100p1（COC 惩罚骰）。需要随机数时用它，不要自己编。',
  ].join(''),
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      expression: {
        type: 'string',
        description: '骰子表达式，如 1d20+5、4d6kh3、1d100b1',
      },
      reason: {
        type: 'string',
        description: '这次投骰的用途（如「力量检定」），仅用于展示',
      },
    },
    required: ['expression'],
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        expression: { type: 'string' },
        total: { type: 'number' },
        detail: { type: 'string' },
      },
      required: ['expression', 'total', 'detail'],
    },
    render: (_args, value) => [{ type: 'text', text: formatDice(value) }],
  },
  isConcurrencySafe: () => true,
  execute(args) {
    const expression = args && args.expression;
    if (typeof expression !== 'string' || expression.trim() === '')
      throw new Error('expression 必须是非空字符串，例如 1d20+5');
    const result = rollDice(expression);
    return { expression: result.expression, total: result.total, detail: result.detail };
  },
  presentCall: (args) => (args.reason ? `掷骰：${args.expression}（${args.reason}）` : `掷骰：${args.expression}`),
};

const drawTarotTool = {
  name: 'draw_tarot',
  description: [
    '抽塔罗牌（韦特体系 78 张，含正逆位）。',
    'count 是张数 1–7：1 单张、3 过去/现在/未来、5 现状/阻碍/建议/结果/潜在、7 简化凯尔特十字。',
    '抽完结合牌面含义与用户的问题解读；这是象征性参考，不要说成确定性预言。',
  ].join(''),
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      count: { type: 'number', description: '抽几张，1–7，默认 1' },
      question: { type: 'string', description: '占卜的问题，原样回显' },
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        question: { type: 'string' },
        count: { type: 'number' },
        spread: { type: 'string' },
        cards: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              position: { type: 'string' },
              name: { type: 'string' },
              alt: { type: 'string' },
              orientation: { type: 'string' },
              meaning: { type: 'string' },
            },
            required: ['position', 'name', 'alt', 'orientation', 'meaning'],
          },
        },
      },
      required: ['question', 'count', 'spread', 'cards'],
    },
    render: (_args, value) => [{ type: 'text', text: formatTarot(value) }],
  },
  isConcurrencySafe: () => true,
  execute(args) {
    const count = args && args.count === undefined ? 1 : Number(args.count);
    const question = args && typeof args.question === 'string' ? args.question : '';
    return drawTarot(count, question);
  },
  presentCall: (args) => `抽塔罗：${(args && args.count) ?? 1} 张${args && args.question ? `（${args.question}）` : ''}`,
};

export function apply(ctx) {
  ctx.tools.register(rollDiceTool);
  ctx.tools.register(drawTarotTool);
  console.log('[dsh-tabletop] 已注册工具 roll_dice / draw_tarot');
  ctx.logger?.info?.('[dsh-tabletop] 已注册 roll_dice / draw_tarot');
}

export { rollDice, drawTarot, rollDiceTool, drawTarotTool };
