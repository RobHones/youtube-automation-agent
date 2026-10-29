const test = require('node:test');
const assert = require('node:assert/strict');
const { ResearchService, ResearchBlockedError } = require('../utils/research-service');
const { contentUnits, auditIsCurrent } = require('../utils/research-contract');

const PASSAGE = 'The pneumatic railway was demonstrated in 1864 at Crystal Palace.';
const retrieval = (url, extra = {}) => ({ id: `r-${url}`, url, type: 'fetch', status: 'completed', tool: 'web_search', completedAt: '2026-10-28T12:00:00.000Z', ...extra });

function source(overrides = {}) {
  return {
    id: 's1', url: 'https://archive.example/railway', title: 'Railway paper', publisher: 'Historical Society',
    publishedAt: '2021-05-01', originUrl: 'https://archive.example/railway', sourceType: 'official',
    evidenceType: 'document', passage: PASSAGE, location: 'page 4', independenceKnown: true, ...overrides
  };
}

function claim(overrides = {}) {
  return {
    id: 'f1', text: 'The railway was demonstrated in 1864.', riskLevel: 'standard', sourceIds: ['s1'],
    evidence: [{ sourceId: 's1', passage: 'demonstrated in 1864', location: 'page 4' }], atomic: true, uncertainty: '', ...overrides
  };
}

function packData(overrides = {}) {
  return { topic: 'Crystal Palace pneumatic railway', summary: 'A documented 1864 experiment.', sources: [source()], claims: [claim()], contradictions: [], exceptions: [], ...overrides };
}

function worker(responses) {
  const prompts = [];
  const queue = [...responses];
  const run = async ({ prompt }) => {
    prompts.push(prompt);
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(prompt) : next;
  };
  run.prompts = prompts;
  return run;
}

function packResult(data = packData(), retrievals) {
  return { data, retrievals: retrievals || (data.sources || []).map(item => retrieval(item.url)), provider: 'chatgpt', model: 'fixture' };
}

function service(run, options = {}) {
  return new ResearchService({}, { provider: 'chatgpt', env: {}, worker: run, ...options });
}

async function blocked(promise, code, label = code) {
  const error = await promise.then(() => null, value => value);
  assert.ok(error instanceof ResearchBlockedError, `${label}: expected ResearchBlockedError, got ${error?.message || 'success'}`);
  if (code) assert.ok(error.exceptions.some(item => item.code === code), `expected ${code}, got ${error.exceptions.map(item => item.code).join(', ')}`);
  return error;
}

test('a well-supported fact pack is normalized and fingerprinted', async () => {
  const pack = await service(worker([packResult()])).buildFactPack({ topic: 'Crystal Palace pneumatic railway' });
  assert.equal(pack.attempts, 1);
  assert.equal(pack.sources[0].originId, 'archive.example');
  assert.equal(pack.sources[0].passageVerified, false);
  assert.equal(pack.claims[0].status, 'supported');
  assert.match(pack.evidenceFingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(pack.exceptions, []);
});

test('research is opt-in even when a ChatGPT or Claude subscription is configured', () => {
  const subscribed = { aiProvider: { provider: 'chatgpt', model: 'gpt-5.6-luna' } };
  assert.equal(new ResearchService(subscribed, { env: { CODEX_RUNTIME: 'local' } }).isEnabled(), false);
  assert.equal(new ResearchService(subscribed, { env: {}, provider: 'auto' }).provider, 'chatgpt');
  assert.equal(new ResearchService({}, { env: { CLAUDE_RUNTIME: 'local' }, provider: 'auto' }).provider, 'claude');
  assert.equal(new ResearchService({}, { env: {}, provider: 'auto' }).isEnabled(), false);
  assert.equal(new ResearchService({}, { env: { RESEARCH_PROVIDER: 'claude' } }).provider, 'claude');
});

test('disabled research blocks instead of silently writing unsourced content', async () => {
  const research = service(worker([packResult()]), { provider: 'disabled' });
  assert.equal(research.isEnabled(), false);
  await blocked(research.buildFactPack({ topic: 'Any topic' }), 'disabled');
});

test('retrieval failures block the pack', async () => {
  await blocked(service(worker([packResult(packData(), [])]), { maxAttempts: 1 }).buildFactPack({ topic: 'x' }), 'retrieval_failure');
  // A source that was never opened in the recorded events cannot support a claim.
  const unopened = packResult(packData(), [retrieval('https://elsewhere.example/page')]);
  await blocked(service(worker([unopened]), { maxAttempts: 1 }).buildFactPack({ topic: 'x' }), 'unretrieved_source');
  await blocked(service(worker([new Error('network down')]), { maxAttempts: 1 }).buildFactPack({ topic: 'x' }), 'retrieval_failure');
});

test('captured page content must contain the quoted passage', async () => {
  const mismatch = packResult(packData(), [retrieval('https://archive.example/railway', { content: 'An unrelated page about canals.' })]);
  await blocked(service(worker([mismatch]), { maxAttempts: 1 }).buildFactPack({ topic: 'x' }), 'passage_mismatch');
  const matched = packResult(packData(), [retrieval('https://archive.example/railway', { content: `Intro. ${PASSAGE} More text.` })]);
  const pack = await service(worker([matched])).buildFactPack({ topic: 'x' });
  assert.equal(pack.sources[0].passageVerified, true);
});

test('claim evidence must be an excerpt of the saved source passage', async () => {
  const data = packData({ claims: [claim({ evidence: [{ sourceId: 's1', passage: 'reached 100 mph', location: 'page 4' }] })] });
  await blocked(service(worker([packResult(data)]), { maxAttempts: 1 }).buildFactPack({ topic: 'x' }), 'unsupported_passage');
});

test('compound claims must be split before writing', async () => {
  const data = packData({ claims: [claim({ text: 'It was demonstrated in 1864 between two stations.', atomic: false })] });
  await blocked(service(worker([packResult(data)]), { maxAttempts: 1 }).buildFactPack({ topic: 'x' }), 'compound_claim');
});

test('copied accounts count as one evidence chain for high-risk claims', async () => {
  const copied = packData({
    sources: [source(), source({ id: 's2', url: 'https://blog.example/copy', publisher: 'Blog', originUrl: 'https://archive.example/railway' })],
    claims: [claim({ riskLevel: 'high', sourceIds: ['s1', 's2'], evidence: [
      { sourceId: 's1', passage: 'demonstrated in 1864', location: 'page 4' },
      { sourceId: 's2', passage: 'demonstrated in 1864', location: 'page 4' }
    ] })]
  });
  await blocked(service(worker([packResult(copied)]), { maxAttempts: 1 }).buildFactPack({ topic: 'x' }), 'corroboration');

  const independent = JSON.parse(JSON.stringify(copied));
  independent.sources[1] = source({ id: 's2', url: 'https://museum.example/record', publisher: 'Museum', originUrl: 'https://museum.example/record' });
  const pack = await service(worker([packResult(independent)])).buildFactPack({ topic: 'x' });
  assert.equal(pack.claims[0].riskLevel, 'high');

  const unknownOrigin = JSON.parse(JSON.stringify(independent));
  unknownOrigin.sources[1].independenceKnown = false;
  await blocked(service(worker([packResult(unknownOrigin)]), { maxAttempts: 1 }).buildFactPack({ topic: 'x' }), 'corroboration');
});

test('conflicting dates remain exceptions until reconciled with evidence', async () => {
  const conflict = { claimIds: ['f1'], description: 'Sources date the demonstration to 1864 and 1865.' };
  await blocked(service(worker([packResult(packData({ contradictions: [{ ...conflict, status: 'unresolved' }] }))]), { maxAttempts: 1 })
    .buildFactPack({ topic: 'x' }), 'contradiction');
  // Claiming resolution without stating how is still unresolved.
  await blocked(service(worker([packResult(packData({ contradictions: [{ ...conflict, status: 'resolved', resolution: '' }] }))]), { maxAttempts: 1 })
    .buildFactPack({ topic: 'x' }), 'contradiction');
  const pack = await service(worker([packResult(packData({ contradictions: [{ ...conflict, status: 'resolved', resolution: '1865 refers to the second season, per page 6.' }] }))]))
    .buildFactPack({ topic: 'x' });
  assert.equal(pack.contradictions[0].status, 'resolved');
});

test('worker-declared evidence gaps and an omitted exceptions list both block', async () => {
  await blocked(service(worker([packResult(packData({ exceptions: [{ message: 'Station locations are unrecorded.' }] }))]), { maxAttempts: 1 })
    .buildFactPack({ topic: 'x' }), 'evidence_gap');
  const data = packData();
  delete data.exceptions;
  await blocked(service(worker([packResult(data)]), { maxAttempts: 1 }).buildFactPack({ topic: 'x' }), 'missing_exceptions');
  await blocked(service(worker([packResult(packData({ claims: [] }))]), { maxAttempts: 1 }).buildFactPack({ topic: 'x' }), 'empty_pack');
});

test('thin evidence moves to the next candidate topic with feedback', async () => {
  const run = worker([packResult(packData({ exceptions: [{ message: 'Too little evidence.' }] })), packResult(packData({ topic: 'Atmospheric railway' }))]);
  const pack = await service(run).buildFactPack({ topic: 'Thin topic', candidateTopics: [{ topic: 'Atmospheric railway' }] });
  assert.equal(pack.attempts, 2);
  assert.equal(pack.topic, 'Atmospheric railway');
  assert.match(run.prompts[0], /"Thin topic"/);
  assert.match(run.prompts[1], /"Atmospheric railway"/);
  assert.match(run.prompts[1], /Too little evidence/);
});

function production(overrides = {}) {
  return {
    script: { title: 'The railway under the park', fullScript: 'The railway was demonstrated in 1864.\nSubscribe for more history.' },
    seo: { title: 'The railway under the park', description: 'The railway was demonstrated in 1864.', tags: ['history'] },
    thumbnail: { text: '1864' },
    ...overrides
  };
}

function auditData(content, pack, overrides = {}) {
  const factual = contentUnits(content).filter(unit => /1864/.test(unit.text));
  return {
    complete: true,
    claims: [{
      id: 'a1', text: 'The railway was demonstrated in 1864.', unitIds: factual.map(unit => unit.id), factIds: [pack.claims[0].id], sourceIds: ['s1'],
      atomic: true, allPartsSupported: true, riskLevel: 'standard', status: 'supported',
      evidence: [{ sourceId: 's1', passage: 'demonstrated in 1864', location: 'page 4' }], reason: 'The excerpt states the year of the demonstration.'
    }],
    coverage: contentUnits(content).map(unit => factual.some(item => item.id === unit.id)
      ? { unitId: unit.id, text: unit.text, classification: 'factual', claimIds: ['a1'] }
      : { unitId: unit.id, text: unit.text, classification: 'non_factual', claimIds: [], reason: 'Title, tag or call to action without an external assertion.' }),
    exceptions: [],
    ...overrides
  };
}

async function builtPack() {
  return service(worker([packResult()])).buildFactPack({ topic: 'x' });
}

const auditResult = data => ({ data, retrievals: [retrieval('https://archive.example/railway')], provider: 'chatgpt', model: 'fixture' });

test('a complete audit passes and becomes stale after any audience-facing edit', async () => {
  const pack = await builtPack();
  const content = production();
  const audit = await service(worker([auditResult(auditData(content, pack))])).auditContent(content, pack);
  assert.equal(audit.status, 'passed');
  assert.equal(auditIsCurrent(audit, content, pack), true);
  assert.equal(auditIsCurrent(audit, { ...content, seo: { ...content.seo, title: 'The fastest railway ever built' } }, pack), false);
  assert.equal(auditIsCurrent(audit, { ...content, thumbnail: { text: '100 mph!' } }, pack), false);
  // Changing the evidence after the audit also invalidates it.
  const edited = JSON.parse(JSON.stringify(pack));
  edited.claims[0].text = 'The railway was demonstrated in 1865.';
  assert.equal(auditIsCurrent(audit, content, edited), false);
});

test('an audit that omits text, links the wrong unit or invents facts is blocked', async () => {
  const pack = await builtPack();
  const content = production();
  const omitted = auditData(content, pack);
  omitted.coverage = omitted.coverage.filter(entry => !entry.unitId.startsWith('thumbnail'));
  await blocked(service(worker([auditResult(omitted)])).auditContent(content, pack), 'incomplete_audit');

  const wrongUnit = auditData(content, pack);
  wrongUnit.claims[0].unitIds = wrongUnit.claims[0].unitIds.filter(id => !id.startsWith('thumbnail'));
  await blocked(service(worker([auditResult(wrongUnit)])).auditContent(content, pack), 'coverage_mismatch');

  // A claim's text unit cannot simultaneously be declared non-factual.
  const relabelled = auditData(content, pack);
  relabelled.coverage = relabelled.coverage.map(entry => entry.unitId.startsWith('thumbnail')
    ? { ...entry, classification: 'non_factual', claimIds: [], reason: 'Decorative overlay.' } : entry);
  await blocked(service(worker([auditResult(relabelled)])).auditContent(content, pack), 'coverage_mismatch', 'relabelled');

  const invented = auditData(content, pack);
  invented.claims[0].factIds = ['f_invented'];
  await blocked(service(worker([auditResult(invented)])).auditContent(content, pack), 'unsupported_claim');

  const compound = auditData(content, pack);
  compound.claims[0].allPartsSupported = false;
  await blocked(service(worker([auditResult(compound)])).auditContent(content, pack), 'compound_claim');

  await blocked(service(worker([auditResult(auditData(content, pack, { claims: [] }))])).auditContent(content, pack), 'incomplete_audit');
});

test('the auditor cannot downgrade a high-risk fact to avoid corroboration', async () => {
  const pack = await builtPack();
  const risky = JSON.parse(JSON.stringify(pack));
  risky.claims[0].riskLevel = 'high';
  const { evidenceFingerprint } = require('../utils/research-contract');
  risky.evidenceFingerprint = evidenceFingerprint(risky);
  const content = production();
  await blocked(service(worker([auditResult(auditData(content, risky))])).auditContent(content, risky), 'corroboration');
});

test('a changed or unresolved fact pack cannot be audited', async () => {
  const pack = await builtPack();
  const tampered = { ...pack, claims: [{ ...pack.claims[0], text: 'It reached 100 mph.' }] };
  await blocked(service(worker([auditResult({})])).auditContent(production(), tampered), 'invalid_pack');
});

test('audit failures trigger bounded repairs with only the actionable feedback', async () => {
  const pack = await builtPack();
  const draft = production({ seo: { title: 'The railway under the park', description: 'It reached 100 mph in 1864.', tags: ['history'] } });
  const repaired = production();
  const failing = auditData(draft, pack, { exceptions: [{ message: 'Speed is unsupported.', proposedResolution: 'Remove the speed.' }] });
  const repairs = [];
  const result = await service(worker([auditResult(failing), auditResult(auditData(repaired, pack))])).auditAndRepair(draft, {
    factPack: pack,
    repair: async (_content, feedback) => { repairs.push(feedback); return repaired; }
  });
  assert.equal(result.repairAttempts, 1);
  assert.equal(result.audit.status, 'passed');
  assert.equal(repairs.length, 1);
  assert.ok(repairs[0].exceptions.some(item => /Speed is unsupported/.test(item.message)));

  // The repair budget is bounded; an unrepairable draft surfaces its exceptions.
  let calls = 0;
  const error = await blocked(service(worker([auditResult(failing)]), { maxRepairs: 1 }).auditAndRepair(draft, {
    factPack: pack, repair: async () => { calls += 1; return draft; }
  }), 'audit_exception');
  assert.equal(calls, 1);
  assert.ok(error.factPack);
});

test('workers never exceed the configured concurrency', async () => {
  let active = 0;
  let peak = 0;
  const slow = async () => {
    active += 1; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 20));
    active -= 1;
    return packResult();
  };
  const research = service(slow, { concurrency: 1 });
  await Promise.all([research.buildFactPack({ topic: 'a' }), research.buildFactPack({ topic: 'b' }), research.buildFactPack({ topic: 'c' })]);
  assert.equal(peak, 1);
});

test('the time budget bounds queued workers', async () => {
  const research = service(async () => { await new Promise(resolve => setTimeout(resolve, 80)); return packResult(); }, { concurrency: 1, maxAttempts: 1 });
  const first = research.buildFactPack({ topic: 'a' });
  const second = research.buildFactPack({ topic: 'b' }, { deadline: Date.now() + 20 });
  await blocked(second, 'time_limit');
  await first;
});
