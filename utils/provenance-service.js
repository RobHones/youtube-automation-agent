const crypto = require('crypto');
const { auditIsCurrent } = require('./research-contract');

const SOURCE_TYPES = new Set(['article', 'video', 'dataset', 'official', 'asset', 'other']);
const SOURCE_STATUSES = new Set(['pending', 'verified', 'rejected']);
const CLAIM_RISKS = new Set(['standard', 'high']);
const CLAIM_STATUSES = new Set(['pending', 'supported', 'unsupported']);
const clone = value => JSON.parse(JSON.stringify(value));

class ProvenanceService {
  constructor(db) {
    this.db = db;
  }

  async initialize(productionId, production = {}) {
    const existing = await this.db.getContentProvenance(productionId);
    const incomingResearch = production.research;
    if (existing && !incomingResearch) return existing;

    const required = incomingResearch?.required === true || production.strategy?.researchRequired === true;
    const factPack = incomingResearch?.factPack || production.strategy?.factPack;
    const audit = incomingResearch?.audit;
    const machinePassed = required && auditIsCurrent(audit, production, factPack);
    const sources = this.normalizeSources((factPack?.sources || production.strategy?.researchSources || []).map(source => ({
      ...source,
      ...(required ? { status: machinePassed ? 'verified' : 'pending', machineCheckStatus: machinePassed ? 'checked' : 'pending' } : {})
    })));
    const sourceIdByUrl = new Map(sources.map(source => [source.url, source.id]));
    // Only researched episodes carry checked claims; without research nothing is reviewed.
    const claims = required ? this.normalizeClaims((audit?.claims || factPack?.claims || []).map(claim => ({
      ...claim, status: machinePassed ? 'supported' : 'pending', machineCheckStatus: machinePassed ? 'checked' : 'pending'
    })), sources, sourceIdByUrl) : [];
    const research = required ? {
      required: true, factPack, audit,
      evidenceReviewFingerprint: this.reviewFingerprint(sources, claims)
    } : undefined;
    const provenance = this.build({ sources, claims, research, production, containsSyntheticMedia: production.containsSyntheticMedia === true });
    await this.db.saveContentProvenance(productionId, provenance);
    return this.db.getContentProvenance(productionId);
  }

  async setSyntheticMediaDisclosure(productionId, containsSyntheticMedia) {
    const existing = await this.db.getContentProvenance(productionId) || {};
    await this.db.saveContentProvenance(productionId, { ...existing, containsSyntheticMedia: containsSyntheticMedia === true });
    return this.db.getContentProvenance(productionId);
  }

  build(input = {}) {
    const sources = this.normalizeSources(input.sources || []);
    const sourceIds = new Set(sources.map(source => source.id));
    const claims = this.normalizeClaims(input.claims || [], sources);
    for (const claim of claims) claim.sourceIds = claim.sourceIds.filter(id => sourceIds.has(id));

    // The machine audit is the only review: researched episodes pass or block on it,
    // and episodes without research need no evidence review at all.
    const research = input.research;
    const machinePassed = research?.required === true && !research.invalidatedAt &&
      research.audit?.status === 'passed' && research.audit?.complete === true && research.audit?.machineChecked === true &&
      claims.length > 0 && research.evidenceReviewFingerprint === this.reviewFingerprint(sources, claims) &&
      (!input.production || auditIsCurrent(research.audit, input.production, research.factPack));
    const status = research?.required ? (machinePassed ? 'verified' : 'blocked') : 'not_required';
    const resolvedClaims = claims.filter(claim => claim.status === 'supported').length;

    return {
      sources,
      claims,
      containsSyntheticMedia: input.containsSyntheticMedia === true,
      ...(research ? { research } : {}),
      status,
      reviewedAt: status === 'verified' ? new Date().toISOString() : null,
      summary: {
        sourceCount: sources.length,
        verifiedSources: sources.filter(source => source.status === 'verified').length,
        claimCount: claims.length,
        resolvedClaims,
        highRiskClaims: claims.filter(claim => claim.riskLevel === 'high').length,
        unresolvedClaims: claims.length - resolvedClaims,
        ...(research?.required ? { machineChecked: machinePassed, researchExceptions: research.audit?.exceptions?.length || research.factPack?.exceptions?.length || 0 } : {})
      }
    };
  }

  normalizeSources(items = []) {
    if (!Array.isArray(items)) throw this.invalid('Sources must be an array');
    const seenUrls = new Set();
    return items.slice(0, 50).map((item, index) => {
      const url = this.validUrl(item?.url);
      if (!url) throw this.invalid(`Source ${index + 1} requires a valid http or https URL`);
      if (seenUrls.has(url)) throw this.invalid(`Duplicate source URL: ${url}`);
      seenUrls.add(url);
      return {
        id: this.id(item?.id, 'source'),
        url,
        title: this.text(item?.title, 300) || url,
        publisher: this.text(item?.publisher, 200),
        publishedAt: this.date(item?.publishedAt),
        accessedAt: this.date(item?.accessedAt) || new Date().toISOString(),
        sourceType: SOURCE_TYPES.has(item?.sourceType) ? item.sourceType : 'other',
        status: SOURCE_STATUSES.has(item?.status) ? item.status : 'pending',
        notes: this.text(item?.notes, 1000),
        ...(item?.machineCheckStatus ? { machineCheckStatus: item.machineCheckStatus } : {}),
        ...(item?.passage ? { passage: this.text(item.passage, 4000) } : {}),
        ...(item?.location ? { location: this.text(item.location, 1000) } : {}),
        ...(item?.evidenceHash ? { evidenceHash: this.text(item.evidenceHash, 100) } : {}),
        ...(item?.originUrl ? { originUrl: this.validUrl(item.originUrl) } : {}),
        ...(item?.originId ? { originId: this.text(item.originId, 300) } : {}),
        ...(item?.evidenceType ? { evidenceType: this.text(item.evidenceType, 30) } : {})
      };
    });
  }

  normalizeClaims(items = [], sources = [], sourceIdByUrl = new Map()) {
    if (!Array.isArray(items)) throw this.invalid('Claims must be an array');
    const validSourceIds = new Set(sources.map(source => source.id));
    return items.slice(0, 100).map((item, index) => {
      const text = this.text(item?.text || item?.claim, 1000);
      if (!text) throw this.invalid(`Claim ${index + 1} requires text`);
      const mappedUrls = Array.isArray(item?.sourceUrls)
        ? item.sourceUrls.map(url => sourceIdByUrl.get(this.validUrl(url))).filter(Boolean)
        : [];
      const sourceIds = [...new Set([
        ...(Array.isArray(item?.sourceIds) ? item.sourceIds : []),
        ...(Array.isArray(item?.evidence) ? item.evidence.map(evidence => evidence.sourceId) : []),
        ...mappedUrls
      ].map(value => String(value)).filter(id => validSourceIds.has(id)))];
      return {
        id: this.id(item?.id, 'claim'),
        text,
        riskLevel: CLAIM_RISKS.has(item?.riskLevel) ? item.riskLevel : 'standard',
        sourceIds,
        status: CLAIM_STATUSES.has(item?.status) ? item.status : 'pending',
        notes: this.text(item?.notes, 1000),
        ...(item?.machineCheckStatus ? { machineCheckStatus: item.machineCheckStatus } : {}),
        ...(Array.isArray(item?.factIds) ? { factIds: item.factIds.map(String) } : {}),
        ...(Array.isArray(item?.evidence) ? { evidence: clone(item.evidence) } : {}),
        ...(item?.uncertainty ? { uncertainty: this.text(item.uncertainty, 1000) } : {})
      };
    });
  }

  reviewFingerprint(sources, claims) {
    const evidence = {
      sources: sources.map(({ id, url, title, publisher, publishedAt, passage, location, evidenceHash, originUrl, originId }) =>
        ({ id, url, title, publisher, publishedAt, passage, location, evidenceHash, originUrl, originId })),
      claims: claims.map(({ id, text, riskLevel, sourceIds, factIds, evidence, uncertainty }) =>
        ({ id, text, riskLevel, sourceIds, factIds, evidence, uncertainty }))
    };
    return crypto.createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
  }

  assertResearchCurrent(production = {}, provenance = {}) {
    const required = production.research?.required === true || production.strategy?.researchRequired === true || provenance.research?.required === true;
    if (!required) return true;
    const research = provenance.research || production.research;
    if (!research || research.invalidatedAt || !Array.isArray(provenance.claims) || !provenance.claims.length ||
      !auditIsCurrent(research.audit, production, research.factPack) ||
      research.evidenceReviewFingerprint !== this.reviewFingerprint(provenance.sources || [], provenance.claims || []) ||
      provenance.status !== 'verified') {
      const error = new Error('Research audit is missing, incomplete, or stale. Re-run research and audit before approval or publication.');
      error.status = 409;
      error.code = 'RESEARCH_AUDIT_REQUIRED';
      throw error;
    }
    return true;
  }

  async recordAudit(productionId, production, audit) {
    const existing = await this.db.getContentProvenance(productionId) || {};
    const factPack = existing.research?.factPack || production.research?.factPack || production.strategy?.factPack;
    if (!factPack) throw this.invalid('Research must produce a fact pack before auditing content.');
    const initialized = await this.initialize(productionId, {
      ...production,
      research: { required: true, factPack, audit }
    });
    initialized.containsSyntheticMedia = existing.containsSyntheticMedia ?? initialized.containsSyntheticMedia;
    await this.db.saveContentProvenance(productionId, initialized);
    return this.db.getContentProvenance(productionId);
  }

  id(value, prefix) {
    const normalized = String(value || '').trim();
    if (/^[a-zA-Z0-9_-]{1,100}$/.test(normalized)) return normalized;
    return `${prefix}_${crypto.randomUUID()}`;
  }

  validUrl(value) {
    try {
      const url = new URL(String(value || '').trim());
      return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
    } catch (_error) {
      return '';
    }
  }

  text(value, limit) {
    return String(value || '').trim().slice(0, limit);
  }

  date(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  invalid(message) {
    const error = new Error(message);
    error.status = 400;
    return error;
  }
}

module.exports = { ProvenanceService };
