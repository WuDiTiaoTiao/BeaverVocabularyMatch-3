import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

test('the page wires local audio assets to challenge, match, and round-end events', async () => {
  const [html, ui] = await Promise.all([
    readFile(new URL('./index.html', import.meta.url), 'utf8'),
    readFile(new URL('./ui.js', import.meta.url), 'utf8'),
  ]);

  assert.match(html, /id="background-music"[^>]+study-session-lofi\.mp3/);
  assert.match(html, /id="success-sound"[^>]+dingdong-sound\.mp3/);
  assert.match(html, /id="victory-sound"[^>]+round-victory-sound\.mp3/);
  assert.match(ui, /if \(state\.status === 'wave-cleared'\) \{\s+void victorySound\.play\(\);/);

  await Promise.all([
    access(new URL('./assets/study-session-lofi.mp3', import.meta.url)),
    access(new URL('./assets/dingdong-sound.mp3', import.meta.url)),
    access(new URL('./assets/round-victory-sound.mp3', import.meta.url)),
  ]);
});
