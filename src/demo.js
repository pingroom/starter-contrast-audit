import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson } from './storage.js';
import { step, exportAudit } from './engine.js';
import { CONFIG, ROOM_CODE, mockApi } from './mock.js';

const example = await readJson(new URL('../examples/contrast.json', import.meta.url), 65536);
const passing = structuredClone(example);
passing.pairs.find(pair => pair.id === 'body-fail').foreground = '#767676';
for (const [scenario, input, choices, expected] of [
  ['Applicable text passes; logo text is excluded', passing, ['normal', 'normal', 'exempt', 'large'], 'pass'],
  ['Known contrast failure remains exportable', example, ['normal', 'normal', 'exempt', 'large'], 'fail'],
  ['Unknown usage withholds the complete audit', example, ['normal', 'normal', 'exempt', 'unknown'], null],
]) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-contrast-demo-'));
  try {
    const now = () => '2026-11-06T05:00:00.000Z', api = mockApi(now);
    const options = { client: api.client, directory, input, config: CONFIG, token: 'offline-fixture-token', room: ROOM_CODE, now }; let result;
    for (const choice of choices) {
      const pending = await step(options);
      api.answer(pending.answers.find(answer => answer.status === 'pending').questionId, choice);
      result = await step(options);
    }
    assert.equal(result.status, expected === null ? 'unknown' : 'complete');
    assert.equal(api.calls.filter(call => call.method === 'POST').length, 4);
    if (expected === null) { assert.equal(result.audit, null); await assert.rejects(exportAudit(directory, input)); }
    else { const output = await exportAudit(directory, input); assert.equal(output.finding, expected); assert.deepEqual((await readJson(output.path)).audit, result.audit); }
    console.log(JSON.stringify({ scenario, status: result.status, finding: result.audit?.finding ?? null,
      overallPass: result.audit?.overallPass ?? null, rows: result.rows.map(({ id, role, ratio, passed }) => ({ id, role, ratio, passed })) }, null, 2));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
console.log('Offline SDK mock demo only. No live pings, rendered-page inspection or external changes.');
