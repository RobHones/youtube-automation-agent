const test = require('node:test');
const assert = require('node:assert/strict');
const { SceneRepairService } = require('../utils/scene-repair-service');

const scenes = () => [
  { id: 'a', duration: 60, narrationStatus: 'current', audioPath: 'x/000_r1.mp3' },
  { id: 'b', duration: 120, narrationStatus: 'current', audioPath: 'x/001_r1.mp3' },
  { id: 'c', duration: 360, narrationStatus: 'current', audioPath: 'x/002_r1.mp3' }
];

test('scene timings are scaled to the measured narration length', () => {
  const service = new SceneRepairService({}, {});
  const fitted = service.fitScenesToNarration(scenes(), 270);
  assert.deepEqual(fitted.map(scene => scene.duration), [30, 60, 180]);
});

test('scene timings are left alone when the narration length is unknown or already close', () => {
  const service = new SceneRepairService({}, {});
  assert.deepEqual(service.fitScenesToNarration(scenes(), null).map(scene => scene.duration), [60, 120, 360]);
  assert.deepEqual(service.fitScenesToNarration(scenes(), 540.5).map(scene => scene.duration), [60, 120, 360]);
});

test('a rebuild re-splits narration that was cut past the end of the audio', async () => {
  const updates = [];
  const db = { updateProductionScene: async (_id, sceneId, changes) => { updates.push({ sceneId, ...changes }); return { id: sceneId, ...changes }; } };
  const service = new SceneRepairService(db, { isUsableAudioFile: async () => true }, { getMediaDuration: async () => 270 });
  service.initializeAudioSegments = async (_bundle, items) => service.fitScenesToNarration(items, 270);
  const repaired = await service.repairNarrationSegments({ id: 'prod', assets: { audio: { path: 'full.mp3' } } }, scenes());
  assert.deepEqual(repaired.map(scene => scene.duration), [30, 60, 180]);
  assert.equal(updates.length, 3);
});

test('a rebuild keeps scenes that were re-voiced individually', async () => {
  const service = new SceneRepairService({}, { isUsableAudioFile: async () => true }, { getMediaDuration: async () => 270 });
  const items = scenes();
  items[1].audioPath = 'x/001_r2.mp3';
  const kept = await service.repairNarrationSegments({ id: 'prod', assets: { audio: { path: 'full.mp3' } } }, items);
  assert.deepEqual(kept.map(scene => scene.duration), [60, 120, 360]);
});
