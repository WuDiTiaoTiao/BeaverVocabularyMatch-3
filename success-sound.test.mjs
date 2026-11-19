import test from 'node:test';
import assert from 'node:assert/strict';

import { createSuccessSoundController } from './success-sound.js';

const createAudio = ({ rejectPlay = false } = {}) => ({
  preload: '',
  volume: 1,
  currentTime: 8,
  playCalls: 0,
  pauseCalls: 0,
  play() {
    this.playCalls += 1;
    return rejectPlay ? Promise.reject(new Error('blocked')) : Promise.resolve();
  },
  pause() {
    this.pauseCalls += 1;
  },
});

test('a successful match plays the supplied sound from the beginning', async () => {
  const audio = createAudio();
  const sound = createSuccessSoundController(audio, { volume: 0.7 });

  assert.equal(audio.preload, 'auto');
  assert.equal(audio.volume, 0.7);
  assert.equal(await sound.play(), true);
  assert.equal(audio.currentTime, 0);
  assert.equal(audio.playCalls, 1);
});

test('the sound toggle suppresses and restores the success sound', async () => {
  const audio = createAudio();
  const sound = createSuccessSoundController(audio);

  sound.setEnabled(false);
  assert.equal(audio.pauseCalls, 1);
  assert.equal(await sound.play(), false);
  assert.equal(audio.playCalls, 0);

  sound.setEnabled(true);
  assert.equal(await sound.play(), true);
  assert.equal(audio.playCalls, 1);
});

test('playback rejection does not interrupt successful match handling', async () => {
  const audio = createAudio({ rejectPlay: true });
  const sound = createSuccessSoundController(audio);

  assert.equal(await sound.play(), false);
  assert.equal(audio.playCalls, 1);
});
