import test from 'node:test';
import assert from 'node:assert/strict';
import { cameraForView, zoomTarget, tileWorldRect, projectRect, interpolateCamera, planDesiredTileKeys, visibleTileKeys } from '../src/core/geometry.js';
import { decodePixels } from '../src/core/pixels.js';

const image = { id: 'IMG001', width: 15000, height: 13000, virtualSize: 16384, maxZoom: 4 };
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);

test('ROOT → nivel 1 y zoom in mantienen el mismo centro virtual', () => {
  let view = { zoom: 0, currentX: 0, currentY: 0 };
  for (let z = 1; z <= image.maxZoom; z++) {
    const before = cameraForView(image, view);
    view = zoomTarget(image, view, 1);
    const after = cameraForView(image, view);
    near(before.x + before.size / 2, after.x + after.size / 2);
    near(before.y + before.size / 2, after.y + after.size / 2);
    near(before.size / 2, after.size);
  }
  assert.equal(zoomTarget(image, view, 1), null);
});

test('zoom out con origen impar/bordes usa coordenadas de tiles y conserva la alineación', () => {
  for (const x of [0, 1, 5, 28]) {
    const view = { zoom: 3, currentX: x, currentY: x };
    const target = zoomTarget(image, view, -1);
    const oldTile = tileWorldRect({ zoom: 3, tileX: x, tileY: x, width: 256, height: 256 });
    const parent = tileWorldRect({ zoom: 2, tileX: Math.floor(x / 2), tileY: Math.floor(x / 2), width: 256, height: 256 });
    const camera = cameraForView(image, target);
    const projectedOld = projectRect(oldTile, camera), projectedParent = projectRect(parent, camera);
    near(projectedOld.width, 128);
    near(projectedOld.x - projectedParent.x, x % 2 * 128);
    near(projectedOld.y - projectedParent.y, x % 2 * 128);
    assert.ok(target.currentX >= 0 && target.currentX <= 12);
  }
});

test('todos los niveles comparten la proyección durante la animación', () => {
  const from = cameraForView(image, { zoom: 2, currentX: 5, currentY: 7 });
  const to = cameraForView(image, { zoom: 3, currentX: 12, currentY: 16 });
  for (const progress of [0, .1, .25, .5, .75, 1]) {
    const camera = interpolateCamera(from, to, progress);
    for (const z of [1, 2, 3, 4]) {
      const tile = tileWorldRect({ zoom: z, tileX: 2 ** (z - 1), tileY: 2 ** (z - 1), width: 256, height: 256 });
      const projected = projectRect(tile, camera);
      near(projected.x, (128 - camera.x) * 1024 / camera.size);
      near(projected.y, (128 - camera.y) * 1024 / camera.size);
    }
  }
  const last = interpolateCamera(from, to, 1);
  near(last.x, to.x); near(last.y, to.y); near(last.size, to.size);
});

test('plan A+B+C+D acotado y con los 16 visibles en todas las esquinas', () => {
  for (let z = 1; z <= 4; z++) {
    const max = 2 ** (z + 2) - 4;
    for (const x of [0, 1, max]) for (const y of [0, 1, max]) {
      const plan = planDesiredTileKeys(image, z, x, y);
      assert.ok(plan.size <= 64);
      for (const key of visibleTileKeys(image, { zoom: z, currentX: x, currentY: y })) assert.ok(plan.has(key));
      for (const key of plan) {
        const [, level, tx, ty] = key.split(':').map((part, i) => i ? Number(part) : part);
        assert.ok(level >= 1 && level <= 4);
        assert.ok(tx >= 0 && tx < 2 ** (level + 2));
        assert.ok(ty >= 0 && ty < 2 ** (level + 2));
      }
    }
  }
});

test('ROOT pequeña se muestra completa, sin asumir un tamaño de 1024', () => {
  const small = { id: 'SMALL', virtualSize: 512, maxZoom: 0 };
  assert.deepEqual(cameraForView(small, { zoom: 0 }), { x: 0, y: 0, size: 512 });
  assert.equal(zoomTarget(small, { zoom: 0 }, 1), null);
});

test('RGBA4444 big endian y alfa coinciden con el protocolo', () => {
  assert.deepEqual([...decodePixels(new Uint8Array([0xf0, 0x0f, 0x12, 0x34, 0, 0]), 3, 1, 'RGBA4444')],
    [255, 0, 0, 255, 17, 34, 51, 68, 0, 0, 0, 0]);
  assert.throws(() => decodePixels(new Uint8Array(1), 2, 2, 'RGBA4444'));
});
