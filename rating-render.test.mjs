import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as game from './game.js';

const source = (await readFile(new URL('./ui.js', import.meta.url), 'utf8'))
  .replace(/import[\s\S]*?from '\.\/[^']+';\r?\n/g, '')
  .split("board.addEventListener('click', handleTileClick);")[0];

const createHarness = () => {
  const elements = new Map();
  const decodes = [];
  const element = () => ({
    hidden: true, dataset: {}, style: {}, children: [], offsetWidth: 231,
    classList: { add() {}, toggle() {} },
    setAttribute() {}, focus() {},
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    decode() { return new Promise((resolve, reject) => decodes.push({ resolve, reject })); },
  });
  const document = {
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, element());
      return elements.get(selector);
    },
    createElement: element,
    createDocumentFragment: element,
  };
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  const window = {
    setTimeout(callback, delay) { timers.set(++nextId, { callback, due: now + delay }); return nextId; },
    clearTimeout(id) { timers.delete(id); },
    setInterval() { return ++nextId; },
    clearInterval() {},
  };
  const audio = () => ({ start() {}, play() {}, setEnabled() {} });
  const ui = vm.runInNewContext(`${source}\n({
    setState(value) { state = value; }, state() { return state; },
    render, renderRating, scheduleMatchResolution, clearScheduledWork, handleRestart
  })`, {
    ...game, document, window, Intl, Date,
    Image: class { decode() { return Promise.resolve(); } },
    createBackgroundMusicController: audio,
    createSuccessSoundController: audio,
    createAuthService: () => ({}),
  });
  return {
    ui,
    overlay: elements.get('#rating-overlay'),
    image: elements.get('#rating-effect'),
    label: elements.get('#rating-label'),
    match() {
      let state = ui.state();
      const left = state.tiles.find(tile => !tile.distractor && !state.matchedPairIds.includes(tile.pairId));
      const right = state.tiles.find(tile => tile.id !== left.id && tile.pairId === left.pairId);
      state = game.selectTile(state, left.id, now);
      ui.setState(game.selectTile(state, right.id, now + 1));
      ui.render();
      ui.scheduleMatchResolution();
    },
    advance(milliseconds) {
      const end = now + milliseconds;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        now = next[1].due;
        timers.delete(next[0]);
        next[1].callback();
      }
      now = end;
    },
    async finishDecode(error) {
      for (const decode of decodes.splice(0)) error ? decode.reject(error) : decode.resolve();
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    },
    glossCount() {
      return ui.state().tiles.filter(tile => game.getTilePresentation(ui.state(), tile).gloss).length;
    },
  };
};

test('rating waits for a decoded image, then lasts 850 ms while glosses last 2000 ms', async () => {
  const harness = createHarness();
  harness.match();
  assert.equal(harness.overlay.hidden, true, 'undecoded artwork must never be displayed');
  harness.advance(300);
  await harness.finishDecode();
  assert.equal(harness.overlay.hidden, false);
  harness.advance(849);
  assert.equal(harness.overlay.hidden, false);
  harness.advance(1);
  assert.equal(harness.overlay.hidden, true);
  assert.equal(harness.glossCount(), 2);
  harness.ui.render();
  assert.equal(harness.overlay.hidden, true, 'a regular render must not replay the same rating');
  harness.advance(849);
  assert.equal(harness.glossCount(), 2);
  harness.advance(1);
  assert.equal(harness.glossCount(), 0);
});

test('repeated ratings reuse the same cached image URL and play again', async () => {
  const harness = createHarness();
  harness.match();
  await harness.finishDecode();
  const firstUrl = harness.image.src;
  harness.advance(2000);
  harness.match();
  await harness.finishDecode();
  assert.equal(harness.image.src, firstUrl);
  assert.equal(harness.overlay.hidden, false);
});

test('a late image decode cannot bring back a rating after restarting the round', async () => {
  const harness = createHarness();
  harness.match();
  harness.ui.handleRestart();
  await harness.finishDecode();
  assert.equal(harness.overlay.hidden, true);
  assert.equal(harness.ui.state().status, 'playing');
});

test('an image decode failure displays the text rating instead of broken artwork', async () => {
  const harness = createHarness();
  harness.match();
  await harness.finishDecode(new Error('image unavailable'));
  assert.equal(harness.overlay.hidden, false);
  assert.equal(harness.image.hidden, true);
  assert.equal(harness.label.hidden, false);
});
