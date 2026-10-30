const crypto = require('crypto');

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined)
      .map(key => [key, canonical(value[key])]));
  }
  return value;
}

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

// These are the text surfaces an audience can hear or read. Claims, evidence,
// generation prompts and timing metadata are deliberately outside this set.
function contentSurfaces(production = {}) {
  const script = production.script || {};
  const seo = production.seo || {};
  const thumbnail = production.thumbnail || {};
  const editor = production.editorData || production.content || {};
  const surfaces = {};
  const add = (name, value) => {
    if (typeof value === 'string' && value.trim()) surfaces[name] = value.trim();
    else if (Array.isArray(value)) value.forEach((item, index) => add(`${name}.${index}`, item));
    else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        if (!['duration', 'type', 'visuals', 'timing', 'sourceIds', 'factIds', 'claims', 'metadata'].includes(key)) {
          add(`${name}.${key}`, item);
        }
      }
    }
  };
  for (const key of ['title', 'fullScript', 'hook', 'introduction', 'mainContent', 'conclusion', 'callToAction', 'onScreenText', 'captions']) {
    add(`script.${key}`, script[key]);
  }
  for (const key of ['title', 'description', 'tags', 'chapters', 'hashtags', 'onScreenText']) add(`seo.${key}`, editor[key] ?? seo[key]);
  for (const key of ['text', 'textOverlay', 'textOverlays', 'headline', 'title', 'subtitle', 'overlayText', 'onScreenText', 'elements', 'primaryText', 'secondaryText']) {
    add(`thumbnail.${key}`, thumbnail[key]);
    add(`thumbnail.concept.${key}`, thumbnail.concept?.[key]);
  }
  add('onScreenText', production.onScreenText);
  return surfaces;
}

function contentFingerprint(production = {}) {
  return hash(contentSurfaces(production));
}

function contentUnits(production = {}) {
  const units = [];
  for (const [surface, value] of Object.entries(contentSurfaces(production))) {
    // Preserve every nonempty character, including headings and brief overlays.
    // Semantic classification belongs to the independent audit worker.
    const parts = value.split(/\n+|(?<=[.!?])\s+(?=[A-Z0-9“"'])/u).map(text => text.trim()).filter(Boolean);
    parts.forEach((text, index) => units.push({ id: `${surface}:${index}`, surface, text }));
  }
  return units;
}

function evidenceFingerprint(factPack = {}) {
  return hash({ topic: factPack.topic, sources: factPack.sources || [], claims: factPack.claims || [], contradictions: factPack.contradictions || [], exceptions: factPack.exceptions || [] });
}

function validateAudit(audit, { production, factPack } = {}) {
  const errors = [];
  if (!audit || audit.status !== 'passed' || audit.complete !== true || audit.machineChecked !== true) {
    errors.push('A complete, successful machine research audit is required.');
  }
  if (!factPack || !Array.isArray(factPack.claims) || !factPack.claims.length) errors.push('The fact pack is missing.');
  if (audit?.contentFingerprint !== contentFingerprint(production)) errors.push('The factual audit does not match this content revision.');
  if (audit?.evidenceFingerprint !== evidenceFingerprint(factPack)) errors.push('The factual audit does not match this evidence revision.');
  if (!Array.isArray(audit?.claims) || !audit.claims.length) errors.push('The factual audit has no extracted claims.');
  if (!Array.isArray(audit?.exceptions) || audit.exceptions.length) errors.push('The factual audit contains unresolved exceptions.');
  const units = contentUnits(production);
  const coverage = Array.isArray(audit?.coverage) ? audit.coverage : [];
  const auditedIds = new Set();
  const claimIds = new Set((audit?.claims || []).filter(claim => claim.status === 'supported').map(claim => claim.id));
  for (const entry of coverage) {
    const unit = units.find(item => item.id === entry.unitId);
    if (!unit || auditedIds.has(entry.unitId) || entry.text !== unit.text) {
      errors.push('Audit coverage contains an unknown, duplicate or changed text unit.');
      continue;
    }
    auditedIds.add(entry.unitId);
    if (entry.classification === 'factual') {
      if (!Array.isArray(entry.claimIds) || !entry.claimIds.length || entry.claimIds.some(id => !claimIds.has(id))) {
        errors.push(`Unsupported factual text: ${entry.unitId}.`);
      }
    } else if (entry.classification !== 'non_factual' || !String(entry.reason || '').trim()) {
      errors.push(`Text was not fully classified: ${entry.unitId}.`);
    }
  }
  if (!units.length || units.some(unit => !auditedIds.has(unit.id))) errors.push('The factual audit omitted audience-facing text.');
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

function auditIsCurrent(audit, production, factPack) {
  return validateAudit(audit, { production, factPack }).valid;
}

module.exports = { hash, contentSurfaces, contentFingerprint, contentUnits, evidenceFingerprint, validateAudit, auditIsCurrent };
