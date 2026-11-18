// Display only: never use these derived fields as the stored text or recall input.
const kindLabels = new Map([
  ['对话总结', '对话总结'], ['日报', '群聊日报'], ['近况汇总', '人物近况'], ['近况', '人物近况'],
  ['约定', '群内约定'], ['关系', '人物关系'], ['经历', '共同经历'], ['兴趣', '兴趣与偏好'],
  ['事件', '事件记录'], ['事件沉淀', '事件记录'], ['其他', '其他记录'],
]);
const eventKinds = new Map([['episode', '经历'], ['commitment', '约定'], ['relation', '关系']]);
const datePrefix = /^(\d{4}-\d{2}-\d{2})[ \t]+/;
const machineWord = /^(?:memory-gate|archived|once|一次性|中期|长期|汇总|人物卡|事件沉淀)$/i;
const opaqueName = /^(?:(?:qq|qqbot|openid):|\d{5,}$|[a-f0-9]{24,}$)/i;
const readableName = (value = '') => {
  const name = cleanText(value).trim();
  return name && !opaqueName.test(name) && !/^(?:其他人|无法判断|未知|\[表情\])$/.test(name) ? name : '';
};

function cleanText(value) {
  return value.replace(/<faceType\s*=[^>\r\n]*(?:>|(?=\r?\n|$))/gi, '[表情]');
}

export function memoryPresentation(row) {
  const rawText = String(row.text ?? '');
  const tags = String(row.tags ?? '').split(/\s+/).filter(Boolean);
  const tagValue = (key) => tags.find((tag) => tag.startsWith(`${key}:`))?.slice(key.length + 1) ?? '';
  const technicalTags = tags.filter((tag) => tag.includes(':') || machineWord.test(tag) || opaqueName.test(tag));
  let body = cleanText(rawText).trim();
  let recordDate = body.match(datePrefix)?.[1] ?? '';
  body = body.replace(datePrefix, '');
  const prefix = body.match(/^\[([^\]\r\n]+)\]\s*/);
  const kind = [prefix?.[1], eventKinds.get(tagValue('kind')), ...tags].find((value) => kindLabels.has(value)) || '其他';
  if (prefix && kindLabels.has(prefix[1])) body = body.slice(prefix[0].length);
  if (kind === '日报') {
    recordDate ||= body.match(datePrefix)?.[1] ?? '';
    body = body.replace(datePrefix, '');
  }

  let name = '', period = '';
  const cardHeader = kind === '对话总结' && body.match(/^([^\r\n]+?)(?:[（(]更新\s*[^）)\r\n]+[）)])?[ \t]*\r?\n/);
  const statusHeader = kind === '近况汇总' && body.match(/^([^（\r\n]+)[（]([^）\r\n]+)[）][：:]\s*/);
  const namedHeader = kind !== '其他' || prefix?.[1] === '其他' || tagValue('subject')
    ? body.match(/^([^：:\r\n]{1,80})[：:]\s*/) : null;
  const header = cardHeader || statusHeader || namedHeader;
  if (header) {
    name = header[1].trim();
    period = statusHeader ? statusHeader[2] : '';
    body = body.slice(header[0].length);
  }
  if (kind === '对话总结' && /^\{\s*"card"\s*:/.test(body)) {
    try {
      const { card } = JSON.parse(body);
      body = typeof card === 'string' ? card : '';
    } catch { body = ''; } // A truncated legacy JSON card is still available verbatim in raw details.
  }
  body = cleanText(body).replace(/^[ \t]*[-*][ \t]+/gm, '• ').trim();
  const subjectName = kind === '日报' ? '' : readableName(name) || readableName(tagValue('subject').replace(/_/g, ' '));
  const speakerName = readableName(tagValue('speaker').replace(/_/g, ' '));
  const subjectId = tagValue('subject-id');
  const subjectKey = subjectName ? subjectId || `name:${subjectName}` : '';
  const source = kind === '日报' ? '自动日报' : kind === '对话总结' ? '自动对话总结' : kind === '近况汇总' ? '自动近况汇总'
    : tags.includes('事件沉淀') ? '自动事件整理' : speakerName ? `${speakerName} 的群聊发言` : '群聊记录';
  const kindLabel = kindLabels.get(kind);
  const summary = body && !/^(?:\[表情\]\s*)+$/.test(body) ? body : body ? '这条记录只包含表情。' : '没有可显示的正文，可展开核对原始记录。';
  const humanTags = [...new Set(tags.filter((tag) => !technicalTags.includes(tag) && !kindLabels.has(tag)
    && !/^\d{4}-\d{2}-\d{2}$/.test(tag) && ![name, subjectName, speakerName].some((label) => label.split(/\s+/).includes(tag))))];
  return {
    humanTitle: [subjectName, kind === '近况汇总' ? '近况汇总' : kindLabel].filter(Boolean).join(' · '),
    summary, kind, kindLabel, subjectName, subjectKey, source, recordDate, period,
    humanTags, technicalTags, rawText, archived: tags.includes('archived'),
  };
}
