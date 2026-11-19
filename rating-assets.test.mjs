import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const tiers = ['unbelievable', 'amazing', 'excellent', 'perfect', 'good'];
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

test('every rating tier uses the supplied transparent PNG artwork', async () => {
  const ui = await readFile(new URL('./ui.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('./styles.css', import.meta.url), 'utf8');

  assert.match(ui, /\$\{presentation\.asset\}-effect\.png/);
  assert.match(styles, /\.rating-effect[^}]+animation:\s*rating-pop 1\.8s/);

  for (const tier of tiers) {
    const image = await readFile(new URL(`./assets/${tier}-effect.png`, import.meta.url));
    assert.deepEqual(image.subarray(0, 8), pngSignature, `${tier} should be a PNG`);
  }
});
