import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, localReport, exportAudit } from '../src/engine.js';
import { readJson, readText, atomicJson, atomicText, acquireLock } from '../src/storage.js';
import { validateInput, validateState, assessPairs, relativeLuminance, contrastRatio, itemsFor, requestFor, validateConfig, hash, iso, isId, ROOM } from '../src/model.js';
import { loadConnection, loadEnvironment, validateConnection } from '../src/config.js';
import { makeClient } from '../src/client.js';
import { mockApi, CONFIG, ROOM_CODE, OTHER, ASKER, id } from '../src/mock.js';

const example = await readJson(new URL('../examples/contrast.json', import.meta.url), 65536);
const simple = () => structuredClone(example);
const twoItems = simple;
async function setup(t, input = simple()) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-contrast-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = { value: '2026-01-01T09:00:00.000Z' }, now = () => clock.value;
  const api = mockApi(now);
  const options = { client: api.client, directory, input, config: structuredClone(CONFIG), token: 'offline-fixture-token', room: ROOM_CODE, now };
  return { directory, clock, api, options, run: (extra = {}) => step({ ...options, ...extra }), saved: () => readJson(join(directory, 'state.json')) };
}
const sends = (api) => api.calls.filter((call) => call.method === 'POST').length;
async function decide(s, decisions) {
  let result;
  for (const value of decisions) {
    result = await s.run();
    const pending = result.answers.find(item => item.status === 'pending');
    s.api.answer(pending.questionId, value); result = await s.run();
  }
  return result;
}

test('lost response blocks later classifications; exact-ID recovery reads the original request without resend', async (t) => {
  const s = await setup(t, twoItems()); s.api.controls.loseNext = true;
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal((await s.run()).status, 'create_unknown');
  assert.deepEqual((await s.run({ command: 'find' })).candidates, [{ id: id(1), state: 'pending' }]);
  s.api.answer(id(1), 'normal'); assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'ready');
  assert.equal(sends(s.api), 1);
});

test('malformed create response and empty search never authorize a new POST', async (t) => {
  const s = await setup(t); s.api.controls.malformedNext = true; await assert.rejects(s.run());
  assert.equal((await s.saved()).attempts[0].status, 'creating'); s.api.questions.clear();
  assert.deepEqual((await s.run({ command: 'find' })).candidates, []);
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal(sends(s.api), 1);
});

test('recovery validates exact target, room, request, options, data and non-handoff provenance', async (t) => {
  for (const mutate of [
    (q) => { q.target_user_id = OTHER; }, (q) => { q.room.code = 'WRONG1234567'; }, (q) => { q.prompt = 'Other prompt'; },
    (q) => { q.options[0].primary = true; }, (q) => { q.options[0].destructive = true; }, (q) => { q.options.reverse(); },
    (q) => { q.data.item_id = 'other'; }, (q) => { q.data.input_hash = 'changed'; }, (q) => { delete q.is_handoff; },
    (q) => { q.is_handoff = true; }, (q) => { q.asker.type = 'user'; }, (q) => { q.resolution_policy = 'all'; },
  ]) {
    const s = await setup(t); s.api.controls.loseNext = true; await s.run(); mutate(s.api.questions.get(id(1)));
    await assert.rejects(s.run({ command: 'recover', attachId: id(1) })); assert.equal((await s.saved()).attempts[0].status, 'creating');
    assert.equal(sends(s.api), 1);
  }
});

test('wrong, missing, typed or unsupported answers never resolve a classification', async (t) => {
  for (const mutate of [
    (q) => { q.answer.responder.id = OTHER; }, (q) => { q.answer.responder = null; },
    (q) => { q.answer.text = 'normal'; }, (q) => { q.answer.value = 'unsupported'; }, (q) => { q.answer.label = 'Wrong'; },
  ]) {
    const s = await setup(t); await s.run(); s.api.answer(id(1), 'normal'); mutate(s.api.questions.get(id(1)));
    const result = await s.run(); assert.equal(result.observedStatus, 'invalid_answer'); assert.equal(result.audit, null);
    await s.run(); assert.equal(sends(s.api), 2);
  }
});

test('original asker, lifetime and intent remain bound across reads and across classifications', async (t) => {
  for (const mutate of [
    (q) => { q.asker.id = OTHER; },
    (q) => { q.created_at = '2026-01-01T09:00:01.000Z'; q.expires_at = '2026-01-01T09:15:01.000Z'; },
  ]) {
    const s = await setup(t); await s.run(); mutate(s.api.questions.get(id(1))); await assert.rejects(s.run(), /identity or lifetime/);
  }
  const s = await setup(t, twoItems()); await s.run(); s.api.answer(id(1), 'normal'); await s.run();
  s.api.controls.loseNext = true; await s.run(); s.api.questions.get(id(2)).asker.id = OTHER;
  await assert.rejects(s.run({ command: 'recover', attachId: id(2) }), /different asking registrations/);
  const other = await setup(t); other.api.controls.loseNext = true; await other.run();
  const q = other.api.questions.get(id(1)); q.created_at = '2026-01-01T08:58:59.000Z'; q.expires_at = '2026-01-01T09:13:59.000Z';
  await assert.rejects(other.run({ command: 'recover', attachId: id(1) }), /predates/);
});

test('expiry accepts delayed processing but rejects premature and implausibly future resolution on replay', async (t) => {
  const s = await setup(t); await s.run(); s.clock.value = '2026-01-01T09:16:00.000Z';
  s.api.terminal(id(1), 'expired'); s.api.questions.get(id(1)).resolved_at = '2026-01-01T09:15:30.000Z';
  assert.equal((await s.run()).status, 'ready'); assert.equal((await localReport(s.directory, s.options.input)).audit, null);
  const original = await s.saved();
  for (const timestamp of ['2026-01-01T09:14:59.999Z', '2026-01-01T09:17:00.001Z']) {
    const saved = structuredClone(original); saved.attempts[0].observation.resolvedAt = timestamp;
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run(), /resolution time/); assert.equal(s.api.calls.length, calls);
    const live = await setup(t); await live.run(); live.clock.value = s.clock.value; live.api.terminal(id(1), 'expired');
    live.api.questions.get(id(1)).resolved_at = timestamp; await assert.rejects(live.run(), /resolution time/);
  }
});

test('answer and resolution times must agree and answer/cancellation cannot occur after expiry', async (t) => {
  const s = await setup(t); await s.run(); s.api.answer(id(1), 'normal');
  s.api.questions.get(id(1)).answer.answered_at = '2026-01-01T09:00:01.000Z';
  assert.equal((await s.run()).observedStatus, 'invalid_answer');
  for (const terminal of ['answered', 'cancelled']) {
    const other = await setup(t); await other.run(); other.clock.value = '2026-01-01T09:16:00.000Z';
    if (terminal === 'answered') other.api.answer(id(1), 'normal'); else other.api.terminal(id(1), terminal);
    await assert.rejects(other.run(), /resolution time/);
  }
});

test('checked time follows response; future creation, wrong TTL and answer on pending fail', async (t) => {
  const s = await setup(t); await s.run(); const get = s.api.client.questions.get.bind(s.api.client.questions);
  s.api.client.questions.get = async (...args) => { s.clock.value = '2026-01-01T09:02:00.000Z'; s.api.answer(id(1), 'normal'); return get(...args); };
  await s.run(); assert.equal((await s.saved()).attempts[0].observation.checkedAt, s.clock.value);
  for (const mutate of [
    (q) => { q.created_at = '2027-01-01T09:00:00.000Z'; q.expires_at = '2027-01-01T09:15:00.000Z'; },
    (q) => { q.expires_at = '2026-01-01T10:00:00.000Z'; }, (q) => { q.answer = {}; },
  ]) { const other = await setup(t); await other.run(); mutate(other.api.questions.get(id(1))); await assert.rejects(other.run()); }
  assert.equal(iso('2026-01-01T09:00:00+00:00'), '2026-01-01T09:00:00.000Z'); assert.throws(() => iso('2026-02-30T09:00:00Z'));
});

test('room preflight refuses public/unsupported rooms and missing reviewer before a POST', async (t) => {
  for (const mutate of [(rooms) => { rooms[0].is_public = true; }, (rooms) => { rooms[0].type = 'dm'; }, (rooms) => { rooms[0].members = [{ user_id: OTHER }]; }]) {
    const s = await setup(t); mutate(s.api.rooms); await assert.rejects(s.run()); assert.equal(sends(s.api), 0);
  }
});

test('reservation write failure sends nothing; answer save failure resumes the original question', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 2) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal(sends(s.api), 0); await s.run(); s.api.answer(id(1), 'normal');
  await assert.rejects(s.run({ write: async () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal((await s.saved()).attempts[0].status, 'pending'); assert.equal((await s.run()).status, 'ready'); assert.equal(sends(s.api), 1);
});

test('post-create save failure leaves uncertain intent for verified recovery without another POST', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 3) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal((await s.run()).status, 'create_unknown');
  assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'pending'); assert.equal(sends(s.api), 1);
});

test('failed reads preserve evidence and corrupted request/provenance fail before network', async (t) => {
  const s = await setup(t); await s.run(); const before = await readFile(join(s.directory, 'state.json'), 'utf8');
  s.api.controls.readError = true; await assert.rejects(s.run()); assert.equal(await readFile(join(s.directory, 'state.json'), 'utf8'), before);
  s.api.controls.readError = false; s.api.answer(id(1), 'normal'); await s.run(); const original = await s.saved();
  for (const mutate of [
    (saved) => { saved.attempts[0].request.ttl = 60; }, (saved) => { saved.attempts.push(saved.attempts[0]); },
    (saved) => { saved.attempts[0].pair = 'other::pair'; }, (saved) => { saved.attempts[0].observation.answer.responderId = OTHER; },
  ]) {
    const saved = structuredClone(original); mutate(saved); assert.throws(() => validateState(saved, s.options.input));
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run()); assert.equal(s.api.calls.length, calls);
  }
});

test('bounded file reads reject malformed, oversized, invalid UTF-8 and symlink data without revealing contents', async (t) => {
  const s = await setup(t), path = join(s.directory, 'bad.json');
  await writeFile(path, '{"secret":"PRIVATE_TOKEN",bad');
  await assert.rejects(readJson(path), (error) => !error.message.includes('PRIVATE_TOKEN') && error.message.includes('malformed'));
  await writeFile(path, Buffer.from([0xff])); await assert.rejects(readJson(path), /UTF-8/);
  await writeFile(path, 'x'.repeat(100)); await assert.rejects(readJson(path, 50), /size limit/);
  await symlink(path, join(s.directory, 'linked')); await assert.rejects(readJson(join(s.directory, 'linked')));
});

test('private lock excludes other commands; report is offline and private', async (t) => {
  const s = await setup(t); await s.run(); const release = await acquireLock(s.directory);
  await assert.rejects(s.run(), /lock exists/); await assert.rejects(localReport(s.directory, s.options.input), /lock exists/);
  await release(); const before = s.api.calls.length;
  assert.equal((await localReport(s.directory, s.options.input, { save: true })).audit, null); assert.equal(s.api.calls.length, before);
  assert.equal((await stat(join(s.directory, 'report.json'))).mode & 0o777, 0o600);
});

test('partial or blank environment overrides never combine with saved credentials', async (t) => {
  const s = await setup(t); await atomicJson(s.directory, 'credentials.json', { token: 'saved', room: ROOM_CODE });
  await assert.rejects(loadConnection(s.directory, { PINGROOM_TOKEN: '' })); await assert.rejects(loadConnection(s.directory, { PINGROOM_ROOM: ROOM_CODE }));
  assert.equal((await loadConnection(s.directory, { PINGROOM_TOKEN: 'explicit', PINGROOM_ROOM: ROOM_CODE.toLowerCase() })).token, 'explicit');
});

test('transport rejects unrelated writes, redirects and oversized responses', async () => {
  let count = 0; const client = makeClient({ token: 'fixture', fetchImpl: async () => { count++; return new Response(null, { status: 302 }); } });
  await assert.rejects(client.questions.get(id(1))); assert.equal(count, 1); await assert.rejects(client.questions.cancel(id(1))); assert.equal(count, 1);
  const large = makeClient({ token: 'fixture', fetchImpl: async () => new Response('x'.repeat(512 * 1024 + 1)) }); await assert.rejects(large.questions.get(id(1)));
});

test('transport deadlines bound stalled fetch/body and allow abort through infinite ready empty chunks', async () => {
  const stalled = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: () => new Promise(() => {}) }); await assert.rejects(stalled.questions.get(id(1)));
  const body = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })) }); await assert.rejects(body.questions.get(id(1)));
  const controller = new AbortController();
  const empty = makeClient({ token: 'fixture', signal: controller.signal, fetchImpl: async () => new Response(new ReadableStream({ pull: (out) => out.enqueue(new Uint8Array()) })) });
  const timer = setTimeout(() => controller.abort(), 20); try { await assert.rejects(empty.questions.get(id(1))); } finally { clearTimeout(timer); }
});

test('abort before reservation sends nothing; after reservation it preserves unresolved intent', async (t) => {
  const s = await setup(t), stopped = new AbortController(); stopped.abort(); await assert.rejects(s.run({ signal: stopped.signal })); assert.equal(sends(s.api), 0);
  const controller = new AbortController(); let writes = 0;
  await assert.rejects(s.run({ signal: controller.signal, write: async (...args) => { await atomicJson(...args); if (++writes === 2) controller.abort(); } }));
  assert.equal(sends(s.api), 0); assert.equal((await s.run()).status, 'create_unknown');
});


test('partial external credentials cannot borrow the room from dotenv', async (t) => {
  const s = await setup(t), path = join(s.directory, '.env');
  await writeFile(path, 'PINGROOM_TOKEN=file-token\nPINGROOM_ROOM=DEMO12345678\n');
  const partial = { PINGROOM_TOKEN: 'shell-token' }; await loadEnvironment(partial, path);
  assert.equal(partial.PINGROOM_ROOM, undefined); await assert.rejects(loadConnection(s.directory, partial));
  const env = {}; await loadEnvironment(env, path); assert.deepEqual(await loadConnection(s.directory, env), { token: 'file-token', room: ROOM_CODE });
});


test('observation time cannot regress across reads or precede a durable intent on disk',async t=>{
  const s=await setup(t);await s.run();s.clock.value='2026-01-01T09:01:00.000Z';await s.run();
  const before=await readFile(join(s.directory,'state.json'),'utf8');s.clock.value='2026-01-01T09:00:30.000Z';
  await assert.rejects(s.run(),/regressed/);assert.equal(await readFile(join(s.directory,'state.json'),'utf8'),before);
  const saved=await s.saved();saved.attempts[0].observation.checkedAt='2026-01-01T08:59:59.000Z';
  assert.throws(()=>validateState(saved,s.options.input),/predates/);
});

const reference = (await readJson(new URL('./srgb-reference.json', import.meta.url), 65536)).channels.map(Number);
const gray = byte => '#' + byte.toString(16).padStart(2, '0').repeat(3);
const oracleLuminance = value => [0.2126, 0.7152, 0.0722].reduce((sum, weight, i) => sum + weight * reference[Number('0x' + value.slice(1 + 2 * i, 3 + 2 * i))], 0);
const oracleRatio = (a, b) => { const values = [oracleLuminance(a), oracleLuminance(b)].sort((x, y) => x - y); return (values[1] + 0.05) / (values[0] + 0.05); };
const rolesFor = (input, role) => Object.fromEntries(input.pairs.map(pair => [pair.id, role]));
const onePair = (foreground = '#777777', background = '#FFFFFF') => ({ auditId: 'one', title: 'One text pair', pairs: [{ id: 'body', foreground, background, usage: '16 CSS px regular text.' }] });

test('all 256 channel values match a 70-digit Decimal reference, including both transfer-function branches', () => {
  for (let byte = 0; byte < 256; byte++) assert.ok(Math.abs(relativeLuminance(gray(byte)) - reference[byte]) < 1e-15);
  assert.ok(Math.abs(relativeLuminance('#0A0A0A') - (10 / 255 / 12.92)) < 1e-16);
  assert.ok(relativeLuminance('#0B0B0B') > 11 / 255 / 12.92);
  assert.equal(relativeLuminance('#FF0000'), 0.2126); assert.equal(relativeLuminance('#00FF00'), 0.7152); assert.equal(relativeLuminance('#0000FF'), 0.0722);
});

test('65,536 grayscale pairs and 4,096 mixed-color pairs match independent lookup ratios and symmetry', () => {
  for (let a = 0; a < 256; a++) for (let b = 0; b < 256; b++) assert.ok(Math.abs(contrastRatio(gray(a), gray(b)) - oracleRatio(gray(a), gray(b))) < 1e-12);
  for (let i = 0; i < 4096; i++) {
    const a = '#' + ((i * 7919) % 16777216).toString(16).padStart(6, '0'), b = '#' + ((i * 3571 + 999) % 16777216).toString(16).padStart(6, '0');
    const ratio = contrastRatio(a, b); assert.ok(Math.abs(ratio - oracleRatio(a, b)) < 1e-12);
    assert.equal(ratio, contrastRatio(b, a)); assert.ok(ratio >= 1 && ratio <= 21);
  }
  assert.equal(contrastRatio('#000000', '#FFFFFF'), 21); assert.equal(contrastRatio('#AbCdEf', '#abcdef'), 1);
});

test('unrounded normal and large thresholds decide every grayscale-on-white pair, including near-boundary colors', () => {
  for (const role of ['normal', 'large']) for (let byte = 0; byte < 256; byte++) {
    const input = onePair(gray(byte)), threshold = role === 'normal' ? 4.5 : 3;
    const result = assessPairs(input, { body: role }); assert.equal(result.rows[0].passed, oracleRatio(gray(byte), '#FFFFFF') >= threshold);
    assert.equal(result.rows[0].threshold, threshold); assert.equal(result.audit.overallPass, result.rows[0].passed);
  }
  assert.equal(assessPairs(onePair('#767676'), { body: 'normal' }).audit.finding, 'pass');
  const below = assessPairs(onePair('#777777'), { body: 'normal' }); assert.equal(below.audit.finding, 'fail');
  assert.equal(below.rows[0].ratio.toFixed(1), '4.5'); assert.ok(below.rows[0].ratio < 4.5);
  assert.equal(assessPairs(onePair('#777777'), { body: 'large' }).audit.finding, 'pass');
  assert.equal(assessPairs(onePair('#949494'), { body: 'large' }).audit.finding, 'pass');
  assert.equal(assessPairs(onePair('#959595'), { body: 'large' }).audit.finding, 'fail');
});

test('all-exempt is no-applicable with null pass; all-failed remains a complete negative audit', () => {
  const input = simple(), exempt = assessPairs(input, rolesFor(input, 'exempt'));
  assert.equal(exempt.status, 'complete'); assert.equal(exempt.audit.finding, 'no_applicable_pairs'); assert.equal(exempt.audit.overallPass, null);
  assert.equal(exempt.audit.excludedPairIds.length, 4); assert.deepEqual(exempt.audit.applicablePairIds, []);
  assert.ok(exempt.rows.every(row => row.passed === null && row.threshold === null && row.finding === 'excluded'));
  for (const pair of input.pairs) pair.foreground = pair.background;
  const failed = assessPairs(input, rolesFor(input, 'normal')); assert.equal(failed.status, 'complete'); assert.equal(failed.audit.finding, 'fail');
  assert.equal(failed.audit.failedPairIds.length, 4); assert.equal(failed.audit.overallPass, false);
});

test('Unknown or missing at every position withholds full audit while retaining mathematical facts and known findings', () => {
  const input = simple();
  for (const value of ['unknown', null]) for (const pair of input.pairs) {
    const roles = rolesFor(input, 'normal'); roles[pair.id] = value;
    const result = assessPairs(input, roles); assert.equal(result.audit, null); assert.equal(result.status, value === null ? 'incomplete' : 'unknown');
    const row = result.rows.find(row => row.id === pair.id); assert.equal(row.passed, null); assert.equal(row.threshold, null); assert.ok(row.ratio >= 1);
    assert.equal(result.rows.filter(row => row.passed !== null).length, 3);
  }
  assert.equal(assessPairs(input, rolesFor(input, 'unknown')).audit, null);
});

test('complete SDK review exports mixed results with immutable source and authenticated per-pair evidence', async t => {
  const s = await setup(t), result = await decide(s, ['normal', 'normal', 'exempt', 'large']);
  assert.equal(result.status, 'complete'); assert.deepEqual(result.audit.failedPairIds, ['body-fail']); assert.deepEqual(result.audit.excludedPairIds, ['brand']);
  assert.equal(result.audit.overallPass, false); assert.equal(result.audit.renderedContentInspected, false); assert.equal(result.audit.fullWcagConformanceAssessed, false);
  assert.ok(result.answers.every(answer => answer.responderId === CONFIG.participant.id && answer.askerId === ASKER && answer.answeredAt));
  const exported = await exportAudit(s.directory, s.options.input), saved = await readJson(exported.path);
  assert.deepEqual(saved.audit, result.audit); assert.deepEqual(saved.source, validateInput(s.options.input)); assert.equal(exported.finding, 'fail');
  assert.equal((await stat(exported.path)).mode & 0o777, 0o600); assert.equal(sends(s.api), 4);
  assert.equal((await s.run()).status, 'complete'); assert.equal(sends(s.api), 4);
});

test('SDK missing, Unknown, cancelled, expired or invalid evidence cannot be exported as a complete audit', async t => {
  for (const outcome of ['missing', 'unknown', 'cancelled', 'expired', 'invalid']) {
    const s = await setup(t); await assert.rejects(exportAudit(s.directory, s.options.input));
    if (outcome === 'missing') { await s.run(); }
    else if (outcome === 'unknown') { assert.equal((await decide(s, ['unknown', 'normal', 'exempt', 'large'])).status, 'unknown'); }
    else {
      await s.run();
      if (outcome === 'invalid') { s.api.answer(id(1), 'normal'); s.api.questions.get(id(1)).answer.responder.id = OTHER; }
      else { if (outcome === 'expired') s.clock.value = '2026-01-01T09:16:00.000Z'; s.api.terminal(id(1), outcome); }
      await s.run(); await decide(s, ['normal', 'exempt', 'large']);
    }
    assert.equal((await localReport(s.directory, s.options.input)).audit, null); await assert.rejects(exportAudit(s.directory, s.options.input));
    assert.equal(await readJson(join(s.directory, 'audit.json')), null);
  }
});

test('pair permutation and hex case canonicalize without changing evidence; color, meaning and participant changes do', async t => {
  const s = await setup(t); await decide(s, ['normal', 'normal', 'exempt', 'large']);
  const permuted = simple(); permuted.pairs.reverse(); for (const pair of permuted.pairs) pair.background = pair.background.toLowerCase();
  assert.equal(hash(validateInput(permuted)), hash(validateInput(simple()))); assert.deepEqual(await localReport(s.directory, permuted), await localReport(s.directory, simple()));
  for (const mutate of [input => { input.pairs[0].foreground = '#000000'; }, input => { input.pairs[0].usage = 'Another context'; }, input => { input.title = 'Another title'; }]) {
    const input = simple(); mutate(input); const calls = s.api.calls.length; await assert.rejects(s.run({ input })); assert.equal(s.api.calls.length, calls);
  }
  const config = structuredClone(CONFIG); config.participant.id = OTHER; await assert.rejects(s.run({ config }), /another connection/);
});

test('exact schemas reject color shortcuts, alpha, gradients, omitted fields, merged keys and unsupported declarations', async t => {
  const badColors = ['#FFF', '#FFFFFFFF', '#12345G', '#FFFFFF\n', 'FFFFFF', 'rgb(0,0,0)', 'transparent', 'linear-gradient(#000000,#FFFFFF)', null, 0];
  for (const value of badColors) { const input = onePair(); input.pairs[0].foreground = value; assert.throws(() => validateInput(input)); assert.throws(() => relativeLuminance(value)); }
  for (const mutate of [
    input => { input.pairs[0].opacity = 0.5; }, input => { delete input.pairs[0].background; },
    input => { input.pairs[0]['foreground,background'] = '#FFFFFF'; delete input.pairs[0].foreground; delete input.pairs[0].background; },
    input => { input['auditId,title'] = 'merged'; delete input.auditId; delete input.title; },
    input => { input.pairs.push(structuredClone(input.pairs[0])); }, input => { input.pairs = []; },
    input => { input.pairs[0].id = 'constructor'; }, input => { input.pairs[0].id = 'prototype'; },
  ]) { const input = onePair(); mutate(input); const s = await setup(t, input); await assert.rejects(s.run()); assert.equal(s.api.calls.length, 0); }
  assert.throws(() => assessPairs(onePair(), { body: 'normal', extra: 'large' })); assert.throws(() => assessPairs(onePair(), { body: 'Normal text' }));
});

test('strict bounds reject newline IDs, rooms, credentials, Unicode controls and excess text before any API call', async t => {
  for (const mutate of [
    input => { input.auditId += '\n'; }, input => { input.pairs[0].id += '\n'; }, input => { input.pairs[0].id = 'a'.repeat(17); },
    input => { input.title = 'a'.repeat(41); }, input => { input.pairs[0].usage = 'a'.repeat(101); },
    input => { input.pairs[0].usage = ' \t'; }, input => { input.pairs[0].usage = 'bad\u202Etext'; },
    input => { input.pairs[0].usage = 'bad\ud800'; }, input => { input.title = 'Bad\nline'; },
    input => { input.pairs = Array.from({ length: 9 }, (_, i) => ({ ...input.pairs[0], id: 'p' + i })); },
  ]) { const input = onePair(); mutate(input); const s = await setup(t, input); await assert.rejects(s.run()); assert.equal(s.api.calls.length, 0); }
  assert.equal(isId(id(1) + '\n'), false); assert.equal(ROOM.test(ROOM_CODE + '\n'), false);
  assert.throws(() => validateConnection({ token: 'fixture\n', room: ROOM_CODE })); assert.throws(() => validateConnection({ token: 'fixture', room: ROOM_CODE + '\n' }));
  const config = structuredClone(CONFIG); config.participant.id += '\n'; assert.throws(() => requestFor(onePair(), config, 'body', id(1)));
  const s = await setup(t); await assert.rejects(s.run({ token: 'fixture\n' })); await assert.rejects(s.run({ room: ROOM_CODE + '\n' })); assert.equal(s.api.calls.length, 0);
});

test('eight maximum Unicode prompts include full colors and usage within the 500-unit contract', async t => {
  const input = { auditId: 'a'.repeat(40), title: '🟦'.repeat(20), pairs: Array.from({ length: 8 }, (_, i) => ({ id: 'p'.repeat(15) + i, foreground: '#000000', background: '#FFFFFF', usage: '🟨'.repeat(50) })) };
  const config = structuredClone(CONFIG); config.participant.label = '🟩'.repeat(30);
  for (const pair of input.pairs) {
    const request = requestFor(input, config, pair.id, id(1)); assert.equal(request.prompt.length, 449); assert.ok(request.context.length <= 40);
    for (const text of [pair.foreground, pair.background, pair.usage, '18pt regular or 14pt bold', 'SC1.4.3', 'Unknown if unsure']) assert.ok(request.prompt.includes(text));
    assert.deepEqual(request.options.map(option => option.value), ['normal', 'large', 'exempt', 'unknown']);
  }
  const s = await setup(t, input); assert.equal((await decide(s, Array(8).fill('normal'))).audit.finding, 'pass');
  await s.run(); assert.equal(sends(s.api), 8);
});

test('export lock and corrupted evidence cannot overwrite a previously valid artifact', async t => {
  const s = await setup(t); await decide(s, ['normal', 'normal', 'exempt', 'large']); const exported = await exportAudit(s.directory, s.options.input);
  const original = await readFile(exported.path, 'utf8'), release = await acquireLock(s.directory);
  await assert.rejects(exportAudit(s.directory, s.options.input), /lock exists/); await release();
  const saved = await s.saved(); saved.attempts[0].observation.answer.label = 'Another classification'; await atomicJson(s.directory, 'state.json', saved);
  await assert.rejects(exportAudit(s.directory, s.options.input)); assert.equal(await readFile(exported.path, 'utf8'), original);
});
