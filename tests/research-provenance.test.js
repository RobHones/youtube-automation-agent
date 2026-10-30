const test = require('node:test');
const assert = require('node:assert/strict');
const { ProvenanceService } = require('../utils/provenance-service');
const { ScriptWriterAgent } = require('../agents/script-writer-agent');
const { contentFingerprint, evidenceFingerprint, contentUnits, hash } = require('../utils/research-contract');

function fixture() {
  const passage = 'The railway was demonstrated in 1864.';
  const source = {
    id: 'source_archive', url: 'https://archive.example/railway', title: 'Railway archive',
    publisher: 'Historical Archive', publishedAt: '1864-10-08T00:00:00.000Z',
    accessedAt: '2026-10-28T12:00:00.000Z', sourceType: 'official',
    passage, location: 'page 44', evidenceHash: hash(passage), originId: 'archive-record',
    originUrl: 'https://archive.example/railway', evidenceType: 'document'
  };
  const claim = {
    id: 'fact_demonstration', text: passage, riskLevel: 'standard', status: 'supported',
    sourceIds: [source.id], evidence: [{ sourceId: source.id, passage, location: 'page 44', evidenceHash: hash(passage) }]
  };
  const factPack = { topic: 'Pneumatic railway', sources: [source], claims: [claim], exceptions: [], contradictions: [] };
  const production = {
    strategy: { researchRequired: true, factPack },
    script: { title: 'The pneumatic railway', fullScript: passage, claims: [{ text: 'A writer-supplied claim must not replace the audit.' }] },
    seo: { title: 'The pneumatic railway', description: passage }, thumbnail: { text: '1864 railway' }
  };
  const audit = {
    status: 'passed', complete: true, machineChecked: true,
    contentFingerprint: contentFingerprint(production), evidenceFingerprint: evidenceFingerprint(factPack),
    claims: [{ ...claim, id: 'audit_demonstration', factIds: [claim.id] }], exceptions: [],
    coverage: contentUnits(production).map(unit => ({
      unitId: unit.id, text: unit.text, classification: 'factual', claimIds: ['audit_demonstration']
    })), checkedAt: '2026-10-28T12:05:00.000Z', checkedBy: { provider: 'claude', model: 'sonnet' }
  };
  production.research = { required: true, factPack, audit };
  let stored;
  const db = {
    getContentProvenance: async () => stored ? JSON.parse(JSON.stringify(stored)) : null,
    saveContentProvenance: async (_id, value) => { stored = JSON.parse(JSON.stringify(value)); }
  };
  return { production, factPack, audit, service: new ProvenanceService(db) };
}

test('a passing machine audit verifies the episode with no human review', async () => {
  const { production, service } = fixture();
  const provenance = await service.initialize('episode', production);
  assert.equal(provenance.status, 'verified');
  assert.ok(provenance.reviewedAt);
  assert.equal(provenance.summary.machineChecked, true);
  assert.equal(provenance.claims[0].id, 'audit_demonstration');
  assert.equal(provenance.sources[0].location, 'page 44');
  assert.equal(provenance.claims[0].evidence[0].passage, 'The railway was demonstrated in 1864.');
  assert.equal(service.assertResearchCurrent(production, provenance), true);
});

test('content and publish override edits invalidate research at the approval gate', async () => {
  const { production, service } = fixture();
  const provenance = await service.initialize('episode', production);
  for (const changed of [
    { ...production, script: { ...production.script, fullScript: 'It opened in 1865.' } },
    { ...production, editorData: { title: 'The fastest railway ever built' } },
    { ...production, thumbnail: { text: '100 mph!' } }
  ]) {
    assert.throws(() => service.assertResearchCurrent(changed, provenance), { code: 'RESEARCH_AUDIT_REQUIRED' });
  }
});

test('missing audit or empty extracted claims cannot become not-required provenance', async () => {
  for (const mutation of [value => { value.research.audit = null; }, value => { value.research.audit.claims = []; }]) {
    const { production, service } = fixture();
    mutation(production);
    const provenance = await service.initialize('episode', production);
    assert.equal(provenance.status, 'blocked');
    assert.throws(() => service.assertResearchCurrent(production, provenance), { code: 'RESEARCH_AUDIT_REQUIRED' });
  }
});

test('the disclosure toggle keeps the machine evidence and its passing audit', async () => {
  const { production, service } = fixture();
  const original = await service.initialize('episode', production);
  const disclosed = await service.setSyntheticMediaDisclosure('episode', true);
  assert.equal(disclosed.containsSyntheticMedia, true);
  assert.equal(disclosed.status, 'verified');
  assert.deepEqual(disclosed.claims, original.claims);
  assert.equal(service.assertResearchCurrent(production, disclosed), true);
});

test('a fresh audit refreshes the content revision and keeps the disclosure', async () => {
  const { production, service, audit, factPack } = fixture();
  await service.initialize('episode', production);
  await service.setSyntheticMediaDisclosure('episode', true);
  const changed = { ...production, seo: { ...production.seo, title: 'An experimental railway' } };
  assert.throws(() => service.assertResearchCurrent(changed, production.provenance), { code: 'RESEARCH_AUDIT_REQUIRED' });
  const refreshedAudit = {
    ...audit, contentFingerprint: contentFingerprint(changed), evidenceFingerprint: evidenceFingerprint(factPack),
    coverage: contentUnits(changed).map(unit => ({ unitId: unit.id, text: unit.text, classification: 'factual', claimIds: ['audit_demonstration'] }))
  };
  const refreshed = await service.recordAudit('episode', changed, refreshedAudit);
  assert.equal(refreshed.status, 'verified');
  assert.equal(refreshed.containsSyntheticMedia, true);
  assert.equal(service.assertResearchCurrent(changed, refreshed), true);
});

function writer(response) {
  const saved = [];
  const agent = new ScriptWriterAgent({ saveScript: async value => saved.push(value) }, {});
  agent.aiTextService = { isAvailable: () => true, providerName: 'fixture', generateText: async () => JSON.stringify(response) };
  const { factPack } = fixture();
  const strategy = { topic: 'Pneumatic railway', contentType: 'Story', keywords: ['railway'], researchRequired: true, factPack, researchSources: factPack.sources };
  return { agent, saved, strategy };
}

function groundedResponse() {
  return {
    title: 'The pneumatic railway', hook: 'The railway was demonstrated in 1864.',
    introduction: { greeting: '', topicIntro: 'The railway was demonstrated in 1864.', valueProposition: '', credibility: '' },
    sections: [{ title: 'A demonstration', content: ['The railway was demonstrated in 1864.'], duration: 45 }],
    conclusion: { recap: ['The railway was demonstrated in 1864.'], finalThought: '' },
    cta: 'Subscribe for more history.',
    claims: [{ text: 'The railway was demonstrated in 1864.', factIds: ['fact_demonstration'], sourceUrls: ['https://archive.example/railway'] }]
  };
}

test('researched writer keeps grounded introduction, conclusion and fact references', async () => {
  const response = groundedResponse();
  const { agent, strategy, saved } = writer(response);
  const script = await agent.generateScript(strategy);
  assert.equal(script.introduction.topicIntro, response.introduction.topicIntro);
  assert.deepEqual(script.conclusion.recap, response.conclusion.recap);
  assert.deepEqual(script.claims[0].factIds, ['fact_demonstration']);
  assert.equal(saved.length, 1);
  assert.equal(agent.getCredibilityStatement(strategy), '');
});

test('researched writer fails closed on failed generation, missing facts and fabricated IDs', async () => {
  const response = groundedResponse();
  const { agent, strategy, saved } = writer(response);
  agent.aiTextService.generateText = async () => { throw new Error('subscription unavailable'); };
  await assert.rejects(agent.generateScript(strategy), /Grounded script generation failed/);
  assert.equal(saved.length, 0);
  const unavailable = writer(response);
  unavailable.agent.aiTextService.isAvailable = () => false;
  await assert.rejects(unavailable.agent.generateScript(unavailable.strategy), /requires an AI text provider/);
  const invalid = writer({ ...response, claims: [{ text: 'Invented claim', factIds: ['made_up'] }] });
  await assert.rejects(invalid.agent.generateScript(invalid.strategy), /valid fact IDs/);
  const empty = writer(response);
  empty.strategy.factPack.claims = [];
  await assert.rejects(empty.agent.generateScript(empty.strategy), /nonempty fact pack/);
});

test('without research, script claims never wait for a review', async () => {
  const { service } = fixture();
  const production = {
    strategy: { researchSources: [{ url: 'https://example.com/document', title: 'Background reading' }] },
    script: { title: 'A video', claims: [{ text: 'An unsourced claim.', riskLevel: 'high' }] }
  };
  const provenance = await service.initialize('plain', production);
  assert.equal(provenance.status, 'not_required');
  assert.deepEqual(provenance.claims, []);
  assert.equal(provenance.sources.length, 1);
  assert.equal(service.assertResearchCurrent(production, provenance), true);
});
