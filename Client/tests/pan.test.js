import test from 'node:test';
import assert from 'node:assert/strict';
import { ImageClient } from '../src/core/ImageClient.js';
import { PanMotion, PAN_SPEED_PX_PER_SECOND, PAN_RELEASE_DISTANCE_PX } from '../src/core/PanMotion.js';
import { cameraForView, cameraTileKeys, viewForCamera, clampCamera, planDesiredTileKeys, zoomTarget } from '../src/core/geometry.js';

const image = { id: 'TEST', name: 'Prueba', width: 15000, height: 13000, virtualSize: 16384, maxZoom: 4 };
const near = (a, b, tolerance = 1e-8) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
const cameraAt = (x, y, zoom = 2) => ({ x: x * 256 / 2 ** zoom, y: y * 256 / 2 ** zoom, size: 1024 / 2 ** zoom });

function fixture(x = 2, y = 3) {
  const client = new ImageClient(), sent = [];
  client.control = { readyState: 1, send: message => sent.push(message) };
  client.sessionId = 'PAN_TEST';
  for (const channel of client.channels.values()) { channel.joined = true; channel.socket = { readyState: 1 }; }
  client.selectedImage = image;
  client.rootInfo = { width: 1024, height: 1024, format: 'RGBA8888' };
  client.view = { zoom: 2, currentX: x, currentY: y, viewId: 'old' };
  client.desiredTileKeys = planDesiredTileKeys(image, 2, x, y);
  client.renderer = {
    camera: cameraAt(x, y), panMotion: new PanMotion(), fallback: null, zoomFrom: null,
    captureFallback() { this.fallback = { camera: { ...this.camera } }; },
    clearFallback() { this.fallback = null; },
    requestDraw() {}, forget() {},
    moveTo(view) { this.zoomFrom = { ...this.camera }; this.camera = cameraForView(image, view); },
    startPan(view) { this.panMotion.startStep(this.camera, cameraForView(image, view), view.zoom, 0); },
  };
  client.schedulePublish = () => client.publish();
  client.publish();
  return { client, sent, viewports: () => sent.filter(message => message.startsWith('VIEWPORT ')) };
}

test('la celda cambia al cruzar medio tile, en ambos ejes y sentidos', () => {
  assert.deepEqual(viewForCamera(image, 2, cameraAt(2.49, 2.51)), { zoom: 2, currentX: 2, currentY: 3 });
  assert.deepEqual(viewForCamera(image, 2, cameraAt(2.5, 3.49)), { zoom: 2, currentX: 3, currentY: 3 });
  assert.deepEqual(viewForCamera(image, 2, cameraAt(2.499, 3.5)), { zoom: 2, currentX: 2, currentY: 4 });
  assert.deepEqual(viewForCamera(image, 2, cameraAt(1.499, 2.499)), { zoom: 2, currentX: 1, currentY: 2 });
});

test('cobertura visual 16 / 20 / 25 y una esquina diagonal ajena a A+B', () => {
  assert.equal(cameraTileKeys(image, 2, cameraAt(2, 3)).length, 16);
  assert.equal(cameraTileKeys(image, 2, cameraAt(2.25, 3)).length, 20);
  const diagonal = cameraTileKeys(image, 2, cameraAt(2.25, 3.25));
  assert.equal(diagonal.length, 25);
  const plan = planDesiredTileKeys(image, 2, 2, 3);
  assert.deepEqual(diagonal.filter(key => !plan.has(key)), ['TEST:2:6:7']);
  assert.ok(cameraTileKeys(image, 2, cameraAt(2 + 1e-12, 3)).length === 16);
});

test('límite de velocidad vectorial y ausencia de saltos tras un frame largo', () => {
  const motion = new PanMotion();
  let camera = cameraAt(2, 3);
  motion.startDrag(camera, 2, 0);
  motion.dragBy(400, 400, image, 2);
  for (let time = 16; time <= 800; time += 16) {
    const next = motion.advance(camera, time).camera;
    const distance = Math.hypot(next.x - camera.x, next.y - camera.y) * 4;
    assert.ok(distance <= PAN_SPEED_PX_PER_SECOND * .016 + 1e-8);
    near(next.x - camera.x, next.y - camera.y);
    camera = next;
  }
  const next = motion.advance(camera, 10000).camera;
  assert.ok(Math.hypot(next.x - camera.x, next.y - camera.y) * 4 <= PAN_SPEED_PX_PER_SECOND * .05 + 1e-8);
});

test('al soltar el mouse el frenado es acotado y conserva la fracción', () => {
  const motion = new PanMotion();
  let camera = cameraAt(2.1, 3.2);
  motion.startDrag(camera, 2, 0);
  motion.dragBy(400, 0, image, 2);
  motion.endDrag(camera);
  const start = { ...camera };
  for (let time = 16; time <= 2000 && motion.kind; time += 16) camera = motion.advance(camera, time).camera;
  assert.equal(motion.kind, null);
  near((camera.x - start.x) * 4, PAN_RELEASE_DISTANCE_PX);
  near(camera.y, start.y);
  assert.ok(camera.x / 64 % 1 > 0);
});

test('los bordes se limitan sin acumular desplazamiento invisible', () => {
  const motion = new PanMotion();
  const camera = cameraAt(0, 0);
  motion.startDrag(camera, 2, 0);
  motion.dragBy(-5000, -5000, image, 2);
  near(motion.target.x, 0); near(motion.target.y, 0);
  motion.dragBy(10, 20, image, 2);
  near(motion.target.x, 10); near(motion.target.y, 20);
  assert.deepEqual(clampCamera(image, 2, cameraAt(99, 99)), cameraAt(12, 12));
});

test('movimientos dentro de la celda no envían VIEWPORT; el cruce diagonal envía uno', () => {
  const { client, viewports } = fixture();
  client.commitPanCamera(cameraAt(2.1, 2.9));
  client.commitPanCamera(cameraAt(2.49, 2.51));
  assert.equal(viewports().length, 0);
  client.commitPanCamera(cameraAt(2.51, 2.49));
  assert.deepEqual(viewports(), ['VIEWPORT 1 TEST 2 3 2']);
  client.commitPanCamera(cameraAt(2.7, 2.3));
  assert.equal(viewports().length, 1);
  assert.deepEqual(client.renderer.camera, cameraAt(2.7, 2.3));
  client.commitPanCamera(cameraAt(2.49, 2.51));
  assert.deepEqual(viewports().at(-1), 'VIEWPORT 2 TEST 2 2 3');
});

test('zoom desde una posición fraccional usa la celda y termina en la matriz', () => {
  const { client, viewports } = fixture();
  const camera = cameraAt(2.4, 2.8);
  client.commitPanCamera(camera);
  const target = zoomTarget(image, client.view, 1);
  client.renderer.panMotion.startDrag(camera, 2, 0);
  client.renderer.panMotion.dragBy(100, 100, image, 2);
  client.renderer.panMotion.endDrag(camera);
  assert.equal(client.zoom(1), true);
  assert.equal(client.renderer.panMotion.kind, null);
  assert.deepEqual(client.renderer.zoomFrom, camera);
  assert.deepEqual(client.renderer.camera, cameraForView(image, target));
  assert.deepEqual(viewports(), ['VIEWPORT 1 TEST 3 6 8']);
});

test('cruceta: animación con límite de velocidad, un cruce y destino exacto', () => {
  const { client, viewports } = fixture();
  client.commitPanCamera(cameraAt(2.2, 3.1));
  assert.equal(client.pan(1, 0), true);
  assert.equal(viewports().length, 0);
  assert.equal(client.zoom(1), false);
  assert.equal(client.pan(1, 0), false);
  assert.equal(client.beginDrag(), false);
  let previous = { ...client.renderer.camera };
  for (let time = 16; time < 3000 && client.panning; time += 16) {
    const result = client.renderer.panMotion.advance(previous, time);
    assert.ok(Math.hypot(result.camera.x - previous.x, result.camera.y - previous.y) * 4 <= PAN_SPEED_PX_PER_SECOND * .016 + 1e-8);
    client.commitPanCamera(result.camera);
    previous = result.camera;
    if (result.finished) client.finishPan();
  }
  assert.equal(client.panning, false);
  assert.deepEqual(client.renderer.camera, cameraAt(3, 3));
  assert.deepEqual(viewports(), ['VIEWPORT 1 TEST 2 3 3']);
  assert.equal(client.getSnapshot().canZoomIn, true);
});

test('la cruceta puede volver al centro de la celda límite tras un arrastre corto', () => {
  const { client, viewports } = fixture(0, 0);
  client.commitPanCamera(cameraAt(.2, .1));
  assert.equal(client.getSnapshot().pan.left, true);
  assert.equal(client.pan(-1, 0), true);
  for (let time = 16; time < 2000 && client.panning; time += 16) {
    const result = client.renderer.panMotion.advance(client.renderer.camera, time);
    client.commitPanCamera(result.camera);
    if (result.finished) client.finishPan();
  }
  assert.deepEqual(client.renderer.camera, cameraAt(0, 0));
  assert.equal(viewports().length, 0);
});

test('arrastre convierte coordenadas CSS y libera el gesto al cancelar', () => {
  const { client } = fixture();
  assert.equal(client.beginDrag(), true);
  client.dragBy(100, -50, 512, 512);
  near(client.renderer.panMotion.target.x, 128 - 50);
  near(client.renderer.panMotion.target.y, 192 + 25);
  assert.equal(client.zoom(1), false);
  client.endDrag(true);
  assert.equal(client.dragging, false);
  assert.equal(client.renderer.panMotion.kind, null);
  assert.deepEqual(client.renderer.camera, cameraAt(2, 3));
});

test('una esquina recibida tarde permanece mientras siga siendo visible', () => {
  const { client, sent } = fixture();
  client.preparePan();
  client.commitPanCamera(cameraAt(2.2, 3.2));
  const corner = 'TEST:2:6:7';
  assert.equal(client.desiredTileKeys.has(corner), false);
  assert.ok(client.pinnedTileKeys.has(corner));
  client.handleData('CURRENT', 'TILE_STREAM_START 7 stale TEST CURRENT 2 RGBA4444 256 131072 1 6,7');
  client.handleData('CURRENT', new ArrayBuffer(131072));
  client.handleData('CURRENT', 'TILE_STREAM_END 7 1');
  assert.ok(client.tileCache.has(corner));
  for (const key of client.actualVisibleKeys()) {
    const [imageId, z, x, y] = key.split(':');
    client.tileCache.set(key, { imageId, zoom: +z, tileX: +x, tileY: +y, buffer: new Uint8Array(2), receivedAt: performance.now() - 1000 });
  }
  client.releaseCoveredFallback();
  assert.equal(client.renderer.fallback, null);
  assert.ok(client.tileCache.has(corner));
  client.commitPanCamera(cameraAt(2, 3));
  assert.equal(client.tileCache.has(corner), false);
  assert.equal(sent.at(-1), 'TILE_EVICT TEST 2 6 7');
});

test('un fondo diagonal incompleto no se libera al completar solo los 16 centrales', () => {
  const { client } = fixture();
  client.preparePan();
  client.commitPanCamera(cameraAt(2.2, 3.2));
  for (const key of client.desiredTileKeys) {
    const [imageId, z, x, y] = key.split(':');
    client.tileCache.set(key, { imageId, zoom: +z, tileX: +x, tileY: +y, buffer: new Uint8Array(2), receivedAt: performance.now() - 1000 });
  }
  client.releaseCoveredFallback();
  assert.ok(client.renderer.fallback);
  client.publish();
  assert.equal(client.getSnapshot().visibleReady, 24);
  assert.equal(client.getSnapshot().visibleTotal, 25);
});

test('recorrer muchas posiciones y diagonales no acumula la caché', () => {
  const { client } = fixture();
  for (let i = 0; i < 120; i++) {
    const x = 1 + (i % 9) + .2, y = 1 + (Math.floor(i / 9) % 9) + .3;
    client.commitPanCamera(cameraAt(x, y));
    for (const key of [...client.desiredTileKeys, ...client.pinnedTileKeys]) {
      const [imageId, z, tx, ty] = key.split(':');
      client.tileCache.set(key, { imageId, zoom: +z, tileX: +tx, tileY: +ty, buffer: new Uint8Array(2), receivedAt: performance.now() });
    }
    assert.ok(client.tileCache.size <= 65);
    assert.ok(client.pinnedTileKeys.size <= 1);
  }
});

test('perder un canal durante el arrastre detiene el movimiento', () => {
  const { client, viewports } = fixture();
  client.beginDrag();
  client.channels.get('NEXT').joined = false;
  client.commitPanCamera(cameraAt(2.8, 3));
  assert.equal(client.dragging, false);
  assert.equal(client.renderer.panMotion.kind, null);
  assert.equal(viewports().length, 0);
});
