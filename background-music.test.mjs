import test from 'node:test';
import assert from 'node:assert/strict';

import { createBackgroundMusicController } from './background-music.js';

const createAudio = ({ rejectPlay = false } = {}) => ({
  loop: false,
  preload: '',
  volume: 1,
  currentTime: 18,
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

test('starting a challenge configures and plays looping background music', async () => {
  const audio = createAudio();
  const music = createBackgroundMusicController(audio, { volume: 0.16 });

  assert.equal(audio.loop, true);
  assert.equal(audio.preload, 'auto');
  assert.equal(audio.volume, 0.16);
  assert.equal(await music.start(), true);
  assert.equal(audio.playCalls, 1);
});

test('sound toggle pauses and resumes music after a challenge has started', async () => {
  const audio = createAudio();
  const music = createBackgroundMusicController(audio);

  await music.start();
  assert.equal(await music.setEnabled(false), false);
  assert.equal(audio.pauseCalls, 1);
  assert.equal(await music.setEnabled(true), true);
  assert.equal(audio.playCalls, 2);
});

test('returning to vocabulary setup stops and rewinds the track', async () => {
  const audio = createAudio();
  const music = createBackgroundMusicController(audio);

  await music.start();
  music.stop();

  assert.equal(audio.pauseCalls, 1);
  assert.equal(audio.currentTime, 0);
  assert.equal(await music.setEnabled(true), false);
  assert.equal(audio.playCalls, 1);
});

test('browser autoplay rejection is handled without breaking the game', async () => {
  const audio = createAudio({ rejectPlay: true });
  const music = createBackgroundMusicController(audio);

  assert.equal(await music.start(), false);
  assert.equal(audio.playCalls, 1);
});
