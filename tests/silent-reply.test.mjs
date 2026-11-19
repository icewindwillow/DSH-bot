import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const snippet = readFileSync(new URL('../qqbot-patches/silent-reply.js', import.meta.url), 'utf8');
const buildRouter = new Function(
  'shouldSupersedeDraft', 'stripFillerOpeners', 'limitActionDescriptions', 'chunkMarkdownText',
  `return class { ${snippet}
    return chunks;
  } }`,
);
const Router = buildRouter(async () => false, text => text, text => text, text => [text]);

test('outbound silence markers stay in the router while ordinary replies can be chunked', async () => {
  const router = new Router();
  router.logger = {};
  router.config = { textChunkLimit: 3000 };

  for (const text of [' [silent] ', '【静默】后续草稿', '(沉默)', '静默。', 'SILENT']) {
    assert.equal(await router.send({}, text), undefined, text);
  }
  for (const text of ['静默了一会儿，还是说了', '沉默是金']) {
    assert.deepEqual(await router.send({}, text), [text]);
  }
});
