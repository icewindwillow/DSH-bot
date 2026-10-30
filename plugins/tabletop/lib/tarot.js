/**
 * 塔罗抽牌（韦特体系，78 张）。
 *
 * 大阿卡纳 22 张逐一给出正位 / 逆位关键词；
 * 小阿卡纳 56 张按「花色主题 × 数字阶段」组合出含义，避免堆 112 条死记文本。
 * 抽牌用 crypto 洗牌，正逆位各 50%。
 */
import { randomInt } from 'node:crypto';

const MAJORS = [
  ['愚者', 'The Fool', '新的开始、冒险、纯真、跳出去', '鲁莽、逃避、看不清风险'],
  ['魔术师', 'The Magician', '行动力、资源齐备、把想法落地', '操控、夸口、资源没用对'],
  ['女祭司', 'The High Priestess', '直觉、内在知识、等待时机', '忽视直觉、秘密、表里不一'],
  ['女皇', 'The Empress', '丰盛、滋养、创造力、身体', '过度依赖、停滞、忽略自己'],
  ['皇帝', 'The Emperor', '秩序、权威、规则、掌控', '僵化、专制、失控'],
  ['教皇', 'The Hierophant', '传统、指引、体系、学习', '教条、反叛、形式主义'],
  ['恋人', 'The Lovers', '结合、选择、价值一致', '犹豫、错配、价值观冲突'],
  ['战车', 'The Chariot', '前进、意志、胜利、掌控方向', '失控、内耗、方向不明'],
  ['力量', 'Strength', '温柔的坚定、耐心、驯服本能', '自我怀疑、压不住情绪'],
  ['隐士', 'The Hermit', '独处、内省、寻找答案', '孤立、逃避、过度封闭'],
  ['命运之轮', 'Wheel of Fortune', '转机、周期、运气变化', '卡住、重复老问题、时机未到'],
  ['正义', 'Justice', '公平、因果、权衡、诚实', '偏颇、推卸、代价'],
  ['倒吊人', 'The Hanged Man', '换个角度、暂停、甘愿等待', '白等、拖延、不肯松手'],
  ['死神', 'Death', '结束与转化、断舍离', '抗拒改变、拖着不死不活'],
  ['节制', 'Temperance', '调和、节奏、耐心融合', '失衡、过量、急躁'],
  ['恶魔', 'The Devil', '欲望、束缚、执念', '挣脱、看清诱惑、解除依赖'],
  ['高塔', 'The Tower', '突变、崩解、真相暴露', '延迟的崩塌、勉强维持'],
  ['星星', 'The Star', '希望、疗愈、灵感', '失望、信心动摇、看不到光'],
  ['月亮', 'The Moon', '潜意识、模糊、不安与想象', '迷雾散去、谎言识破、焦虑减轻'],
  ['太阳', 'The Sun', '成功、清晰、活力、被看见', '短暂的阴云、过度乐观'],
  ['审判', 'Judgement', '觉醒、召唤、重新评估', '自我怀疑、拖延决定'],
  ['世界', 'The World', '完成、整合、一个周期结束', '差最后一步、未收尾'],
];

const SUITS = {
  权杖: { en: 'Wands', theme: '行动与热情' },
  圣杯: { en: 'Cups', theme: '情感与关系' },
  宝剑: { en: 'Swords', theme: '思维与冲突' },
  星币: { en: 'Pentacles', theme: '现实与物质' },
};

const RANKS = [
  ['Ace', '开端、种子、机会'],
  ['2', '平衡、取舍、合作'],
  ['3', '协作、初步成果、扩展'],
  ['4', '稳定、停滞、守住现状'],
  ['5', '冲突、损失、被排挤'],
  ['6', '和谐、给予、回到正轨'],
  ['7', '评估、坚持、守住立场'],
  ['8', '推进、专注、重复练习'],
  ['9', '接近完成、独自承受'],
  ['10', '圆满或过载、一个阶段的终点'],
  ['侍从', '消息、学习、新手的好奇'],
  ['骑士', '行动、追求、快或慢的推进'],
  ['皇后', '内在的掌控、滋养与成熟'],
  ['国王', '外在的掌控、责任与权威'],
];

const SPREADS = {
  1: ['单张'],
  3: ['过去', '现在', '未来'],
  5: ['现状', '阻碍', '建议', '结果', '潜在因素'],
  7: ['过去', '现在', '未来', '你的态度', '对方态度', '阻碍', '建议'],
};

function buildDeck() {
  const deck = MAJORS.map(([zh, en, up, rev]) => ({
    name: `${zh}`,
    alt: en,
    upright: up,
    reversed: rev,
  }));
  for (const [suit, meta] of Object.entries(SUITS)) {
    for (const [rank, stage] of RANKS) {
      const label = `${suit}${rank}`;
      deck.push({
        name: label,
        alt: `${rank} of ${meta.en}`,
        upright: `${meta.theme}：${stage}`,
        reversed: `${meta.theme}走偏或受阻——${stage}的反面（拖延、过头或逃避）`,
      });
    }
  }
  return deck;
}

const DECK = buildDeck();

/** Fisher–Yates，随机源用 crypto */
function shuffled(array) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = randomInt(0, i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * 抽 count 张牌，每张独立判定正逆位。
 * @param {number} count - 1–7
 * @param {string} [question] - 占卜问题（原样回显，不影响抽牌）
 */
export function drawTarot(count = 1, question = '') {
  const n = Number(count);
  if (!Number.isInteger(n) || n < 1 || n > 7) throw new Error('抽牌张数需要是 1–7 的整数');
  const picked = shuffled(DECK).slice(0, n);
  const positions = SPREADS[n] ?? picked.map((_, i) => `第 ${i + 1} 张`);
  const cards = picked.map((card, i) => {
    const reversed = randomInt(0, 2) === 1;
    return {
      position: positions[i],
      name: card.name,
      alt: card.alt,
      orientation: reversed ? '逆位' : '正位',
      meaning: reversed ? card.reversed : card.upright,
    };
  });
  return {
    question: String(question ?? '').trim(),
    count: n,
    spread: SPREADS[n] ? `${n} 张牌阵` : '自由抽牌',
    cards,
  };
}
