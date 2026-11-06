import { createHash } from 'node:crypto';

export const TTL = 900;
export const CLOCK_SKEW_MS = 60000;
export const TOKEN = /^[^\s\x00-\x1f\x7f]{1,8192}(?![\s\S])/;
export const ROOM = /^[A-Z0-9]{12}$(?![\s\S])/;
export const isId = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/.test(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => {
  if (!record(value)) return false;
  const actual = Object.keys(value).sort(), wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
};
const word = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$(?![\s\S])/.test(value);
const line = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && value.isWellFormed()
  && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) && value.trim() === value;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function iso(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$(?![\s\S])/.test(raw)) throw new Error('Expected a UTC timestamp.');
  const time = Date.parse(raw);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== raw.slice(0, 19)) throw new Error('Invalid UTC timestamp.');
  return new Date(time).toISOString();
}


const safeId = value => word(value) && value.length <= 16 && !['constructor', 'prototype', '__proto__'].includes(value);
export const STANDARD = 'WCAG 2.2 SC 1.4.3 AA text contrast';
export const ROLES = ['normal', 'large', 'exempt', 'unknown'];
const COLOR = /^#[0-9a-fA-F]{6}(?![\s\S])/;
function color(value) {
  if (typeof value !== 'string' || !COLOR.test(value)) throw new Error('Use exact opaque six-digit #RRGGBB sRGB colors; alpha, gradients and other formats are unsupported.');
  return value.toUpperCase();
}
export function validateInput(input) {
  if (!keys(input, ['auditId', 'title', 'pairs']) || !word(input.auditId) || !line(input.title, 40) || !Array.isArray(input.pairs) || input.pairs.length < 1 || input.pairs.length > 8) throw new Error('Supply an audit ID, title and 1–8 text color pairs.');
  const ids = new Set(), pairs = input.pairs.map(pair => {
    if (!keys(pair, ['id', 'foreground', 'background', 'usage']) || !safeId(pair.id) || ids.has(pair.id) || !line(pair.usage, 100)) throw new Error('Pairs need unique safe IDs and a usage description up to 100 UTF-16 units.');
    ids.add(pair.id); return { ...pair, foreground: color(pair.foreground), background: color(pair.background) };
  });
  pairs.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { auditId: input.auditId, title: input.title, pairs };
}
export function validateConfig(config) {
  if (!keys(config, ['participant']) || !keys(config.participant, ['id', 'label']) || !isId(config.participant.id) || !line(config.participant.label, 60)) throw new Error('Config requires an exact reviewer UUID and label.');
  return structuredClone(config);
}
export const itemsFor = input => validateInput(input).pairs;
export function requestFor(rawInput, config, itemId, attemptId) {
  const input = validateInput(rawInput), item = input.pairs.find(pair => pair.id === itemId); validateConfig(config);
  if (!item || !isId(attemptId)) throw new Error('Invalid pair or attempt.');
  const prompt = `${input.title}\nPair ${item.id}: ${item.foreground} on ${item.background}\nUsage: ${item.usage}\nClassify text. Large: at least 18pt regular or 14pt bold. Exempt only SC1.4.3 incidental text (inactive UI, pure decoration, invisible, or in a picture with significant other visual content), or text in a logo/brand name. Otherwise Normal; Unknown if unsure.`;
  if (prompt.length > 500) throw new Error('Contrast prompt exceeds 500 characters.');
  const key = `contrast-${attemptId}`;
  return { prompt, context: `To ${config.participant.id}`,
    options: [['normal', 'Normal text'], ['large', 'Large text'], ['exempt', 'Exempt'], ['unknown', 'Unknown']].map(([value, label]) => ({ value, label, style: 'default' })),
    responder_scope: 'direct', target_user_id: config.participant.id, ttl: TTL, correlation_id: key,
    data: { input_hash: hash(input), item_id: item.id, attempt_id: attemptId }, idempotencyKey: key };
}

/** WCAG 2.2 relative luminance for opaque 8-bit sRGB colors. */
export function relativeLuminance(value) {
  const hex = color(value), channels = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255);
  const [red, green, blue] = channels.map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}
export function contrastRatio(foreground, background) {
  const a = relativeLuminance(foreground), b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
export function assessPairs(rawInput, roles) {
  const input = validateInput(rawInput);
  if (!keys(roles, input.pairs.map(pair => pair.id)) || Object.values(roles).some(role => role !== null && !ROLES.includes(role))) throw new Error('Supply one exact role or null for every pair.');
  const rows = input.pairs.map(pair => {
    const role = roles[pair.id], ratio = contrastRatio(pair.foreground, pair.background), threshold = role === 'normal' ? 4.5 : role === 'large' ? 3 : null;
    const passed = threshold === null ? null : ratio >= threshold;
    return { ...pair, role, foregroundLuminance: relativeLuminance(pair.foreground), backgroundLuminance: relativeLuminance(pair.background),
      ratio, threshold, passed, finding: role === null ? 'unresolved' : role === 'unknown' ? 'unknown' : role === 'exempt' ? 'excluded' : passed ? 'pass' : 'fail' };
  });
  const missingPairIds = rows.filter(row => row.role === null).map(row => row.id), unknownPairIds = rows.filter(row => row.role === 'unknown').map(row => row.id);
  const applicablePairIds = rows.filter(row => row.threshold !== null).map(row => row.id), excludedPairIds = rows.filter(row => row.role === 'exempt').map(row => row.id), failedPairIds = rows.filter(row => row.passed === false).map(row => row.id);
  const status = missingPairIds.length ? 'incomplete' : unknownPairIds.length ? 'unknown' : 'complete';
  const audit = status === 'complete' ? { standard: STANDARD, finding: applicablePairIds.length === 0 ? 'no_applicable_pairs' : failedPairIds.length ? 'fail' : 'pass',
    overallPass: applicablePairIds.length === 0 ? null : failedPairIds.length === 0, applicablePairIds, excludedPairIds, failedPairIds,
    conditionalOnDeclaredColorsAndReviewedUsage: true, renderedContentInspected: false, fullWcagConformanceAssessed: false, rows } : null;
  return { status, rows, missingPairIds, unknownPairIds, audit };
}

export function validateState(state, rawInput) {
  const input = validateInput(rawInput);
  if (!keys(state, ['version', 'inputHash', 'config', 'room', 'credentialHash', 'startedAt', 'attempts']) || state.version !== 1
    || state.inputHash !== hash(input) || typeof state.room !== 'string' || !ROOM.test(state.room)
    || typeof state.credentialHash !== 'string' || !/^[0-9a-f]{64}$(?![\s\S])/.test(state.credentialHash)
    || !Array.isArray(state.attempts) || state.attempts.length > itemsFor(input).length || iso(state.startedAt) !== state.startedAt) throw new Error('Invalid state or changed contrast audit. Restore the original input and configuration.');
  validateConfig(state.config);
  const items = itemsFor(input), ids = new Set(), questionIds = new Set(); let previous = state.startedAt, askerId;
  for (const [index, attempt] of state.attempts.entries()) {
    if (!keys(attempt, ['id', 'itemId', 'createdAt', 'request', 'questionId', 'status', 'observation']) || !isId(attempt.id) || ids.has(attempt.id)
      || attempt.itemId !== items[index].id || iso(attempt.createdAt) !== attempt.createdAt || attempt.createdAt < previous
      || hash(attempt.request) !== hash(requestFor(input, state.config, attempt.itemId, attempt.id))
      || !['creating', 'pending', 'answered', 'expired', 'cancelled', 'invalid_answer'].includes(attempt.status)) throw new Error('Invalid saved text classification or order.');
    ids.add(attempt.id); previous = attempt.createdAt;
    if (attempt.status === 'creating') {
      if (attempt.questionId !== null || attempt.observation !== null) throw new Error('Invalid uncertain creation state.');
    } else {
      if (!isId(attempt.questionId) || questionIds.has(attempt.questionId)) throw new Error('Invalid or repeated Question ID.');
      questionIds.add(attempt.questionId); validateObservation(attempt.observation, attempt.status, attempt.request);
      if (attempt.observation.checkedAt < attempt.createdAt) throw new Error('Observation predates its saved creation intent.');
      previous = attempt.observation.checkedAt;
      if (Date.parse(attempt.observation.createdAt) < Date.parse(attempt.createdAt) - CLOCK_SKEW_MS) throw new Error('Question predates its saved creation intent.');
      if (askerId !== undefined && attempt.observation.askerId !== askerId) throw new Error('Questions belong to different asking registrations.');
      askerId = attempt.observation.askerId;
    }
    if (['creating', 'pending'].includes(attempt.status) && index !== state.attempts.length - 1) throw new Error('Only the last confirmation may have an active Question.');
  }
  return state;
}



export function report(state, rawInput) {
  const input = validateInput(rawInput); validateState(state, input);
  const answers = input.pairs.map(pair => {
    const attempt = state.attempts.find(a => a.itemId === pair.id), answer = attempt?.observation?.answer;
    return { pairId: pair.id, status: attempt?.status === 'creating' ? 'create_unknown' : attempt?.status ?? 'unasked',
      choice: answer?.value ?? null, label: answer?.label ?? null, questionId: attempt?.questionId ?? null, attemptId: attempt?.id ?? null,
      responderId: answer?.responderId ?? null, answeredAt: answer?.answeredAt ?? null, askerId: attempt?.observation?.askerId ?? null, observedAt: attempt?.observation?.checkedAt ?? null };
  });
  const calculation = assessPairs(input, Object.fromEntries(answers.map(answer => [answer.pairId, answer.choice])));
  const active = answers.find(answer => ['create_unknown', 'pending'].includes(answer.status));
  const status = active?.status ?? (answers.some(answer => answer.status === 'unasked') ? 'ready' : calculation.status);
  return { auditId: input.auditId, sourceHash: hash(input), source: input, participant: state.config.participant, room: state.room,
    configHash: hash(state.config), answers, ...calculation, status, actionsExecuted: false };
}

function validateObservation(observation, status, request) {
  if (!keys(observation, ['createdAt', 'expiresAt', 'checkedAt', 'askerId', 'resolvedAt', 'answer']) || !isId(observation.askerId)) throw new Error('Invalid saved observation.');
  for (const key of ['createdAt', 'expiresAt', 'checkedAt']) if (iso(observation[key]) !== observation[key]) throw new Error('Invalid saved timestamp.');
  const duration = Date.parse(observation.expiresAt) - Date.parse(observation.createdAt);
  if (duration < TTL * 1000 - 1000 || duration > TTL * 1000 + 1000) throw new Error('Question lifetime differs from the saved request.');
  const latest = Date.parse(observation.checkedAt) + CLOCK_SKEW_MS;
  if (Date.parse(observation.createdAt) > latest) throw new Error('Question creation is implausibly in the future. Check the local clock.');
  if (status === 'pending') {
    if (observation.resolvedAt !== null) throw new Error('Pending Question has a resolution timestamp.');
  } else if (iso(observation.resolvedAt) !== observation.resolvedAt || observation.resolvedAt < observation.createdAt
    || Date.parse(observation.resolvedAt) > latest
    || (status === 'expired' ? observation.resolvedAt < observation.expiresAt : observation.resolvedAt > observation.expiresAt)) throw new Error('Invalid Question resolution time.');
  if (status === 'answered') {
    const answer = observation.answer;
    if (!keys(answer, ['value', 'label', 'responderId', 'answeredAt']) || answer.responderId !== request.target_user_id
      || !request.options.some((option) => option.value === answer.value && option.label === answer.label)
      || iso(answer.answeredAt) !== answer.answeredAt || answer.answeredAt !== observation.resolvedAt
      || answer.answeredAt < observation.createdAt || answer.answeredAt > observation.expiresAt) throw new Error('Invalid saved text classification evidence.');
  } else if (observation.answer !== null) throw new Error('Unanswered text classifications must not contain text classification evidence.');
}

export function observeQuestion(q, request, questionId, room, checkedAt) {
  if (!isId(questionId) || q?.id !== questionId || q.kind !== 'question' || q.is_handoff !== false
    || q.asker?.type !== 'agent' || !isId(q.asker?.id) || q.prompt !== request.prompt || q.context !== request.context
    || q.responder_scope !== 'direct' || q.target_user_id !== request.target_user_id || q.resolution_policy !== 'first'
    || q.results !== null || q.text_input !== null || q.correlation_id !== request.correlation_id || q.reply_to !== null || hash(q.data) !== hash(request.data)
    || (q.room_code ?? q.room?.code) !== room || q.room_code !== undefined && q.room_code !== room
    || q.room !== undefined && q.room?.code !== room || !['pending', 'answered', 'expired', 'cancelled'].includes(q.state)
    || !Array.isArray(q.options) || q.options.length !== request.options.length
    || q.options.some((option, index) => option?.value !== request.options[index].value || option?.label !== request.options[index].label
      || option?.primary !== false || option?.destructive !== false)) throw new Error('Question does not match the saved configuration, room, or reviewer.');
  const observation = { createdAt: iso(q.created_at), expiresAt: iso(q.expires_at), checkedAt: iso(checkedAt), askerId: q.asker.id,
    resolvedAt: q.resolved_at === null ? null : iso(q.resolved_at), answer: null };
  let status = q.state === 'answered' ? 'invalid_answer' : q.state;
  if (q.state !== 'answered' && q.answer !== null) throw new Error('Unresolved Question includes an unexpected answer.');
  if (q.state === 'answered') {
    const answer = q.answer;
    try {
      if (!answer || answer.text !== null || answer.responder?.id !== request.target_user_id
        || !request.options.some((option) => option.value === answer.value && option.label === answer.label)) throw new Error('Invalid answer.');
      observation.answer = { value: answer.value, label: answer.label, responderId: answer.responder.id, answeredAt: iso(answer.answered_at) };
      validateObservation(observation, 'answered', request); status = 'answered';
    } catch { observation.answer = null; }
  }
  validateObservation(observation, status, request);
  return { status, observation };
}

export function assertParticipantRoom(rooms, room, participantId) {
  if (!Array.isArray(rooms) || rooms.length > 1000) throw new Error('Invalid room inventory.');
  const matches = rooms.filter((item) => item?.invite_code === room), selected = matches[0];
  if (matches.length !== 1 || selected.type !== 'standard' || selected.is_public !== false || !Array.isArray(selected.members)
    || selected.members.length > 1000 || !selected.members.some((member) => member?.user_id === participantId)) throw new Error('Use a granted standard private room containing the named participant.');
}
