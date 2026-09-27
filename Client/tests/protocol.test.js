import test from 'node:test';
import assert from 'node:assert/strict';
import { ImageClient } from '../src/core/ImageClient.js';
import { PanMotion } from '../src/core/PanMotion.js';
import { cameraForView } from '../src/core/geometry.js';

function fixture() {
  const client = new ImageClient();
  const sent = [];
  client.control = { readyState: 1, send: message => sent.push(message) };
  client.sessionId = 'SESSION_TEST';
  for (const channel of client.channels.values()) { channel.joined = true; channel.socket = { readyState: 1 }; }
  client.selectedImage = { id: 'TEST', name: 'Prueba', width: 15000, height: 13000, virtualSize: 16384, maxZoom: 4 };
  client.rootInfo = { width: 1024, height: 1024, format: 'RGBA8888' };
  client.renderer = {
    panMotion: new PanMotion(),
    camera: cameraForView(client.selectedImage, client.view),
    fallback: null,
    captureFallback() { this.fallback = {}; },
    clearFallback() { this.fallback = null; },
    requestDraw() {}, forget() {},
    moveTo(view) { this.camera = cameraForView(client.selectedImage, view); },
    reset() {},
  };
  client.schedulePublish = () => client.publish();
  return { client, sent };
}

test('zoom bloqueado mientras transiciona; volver a ROOT envía CANCEL sin otra ROOT', () => {
  const { client, sent } = fixture();
  assert.equal(client.zoom(1), true);
  assert.equal(client.zoom(1), false);
  assert.equal(client.zoom(-1), false);
  assert.equal(sent.filter(s => s.startsWith('VIEWPORT')).length, 1);
  assert.equal(client.getSnapshot().canZoomIn, false);
  assert.equal(client.getSnapshot().canZoomOut, false);
  client.finishTransition();
  assert.equal(client.zoom(-1), true);
  assert.ok(sent.includes('CANCEL 1'));
  assert.equal(sent.filter(s => s.startsWith('ROOT ')).length, 0);
});

test('la capa anterior permanece tras el segundo si faltan tiles', () => {
  const { client } = fixture();
  client.zoom(1);
  client.finishTransition();
  client.releaseCoveredFallback();
  assert.ok(client.renderer.fallback);
  assert.equal(client.getSnapshot().canZoomIn, true);
  assert.equal(client.view.zoom, 1);
});

test('un tile tardío útil se acepta por identidad; uno inútil recibe ACK y EVICT', () => {
  const { client, sent } = fixture();
  client.zoom(1);
  client.handleData('CURRENT', 'TILE_STREAM_START 7 999 TEST CURRENT 1 RGBA4444 256 131072 2 2,2 7,7');
  client.handleData('CURRENT', new ArrayBuffer(131072));
  assert.ok(client.tileCache.has('TEST:1:2:2'));
  client.handleData('CURRENT', new ArrayBuffer(131072));
  assert.equal(client.tileCache.has('TEST:1:7:7'), false);
  assert.deepEqual(sent.slice(-2), ['TILE_ACK TEST 1 7 7', 'TILE_EVICT TEST 1 7 7']);
  client.handleData('CURRENT', 'TILE_STREAM_END 7 2');
  assert.equal(client.channels.get('CURRENT').stream, null);
});

test('cambiar de nivel conserva los tiles anteriores sin acumular generaciones', () => {
  const { client } = fixture();
  for (let round = 0; round < 20; round++) {
    if (client.view.zoom === 4) client.zoom(-1); else client.zoom(1);
    for (const key of client.desiredTileKeys) {
      const [imageId, z, x, y] = key.split(':');
      client.tileCache.set(key, { imageId, zoom: +z, tileX: +x, tileY: +y, buffer: new Uint8Array(2), receivedAt: performance.now() });
    }
    client.finishTransition();
    assert.ok(client.pinnedTileKeys.size <= 32);
    assert.ok(client.tileCache.size <= 96);
  }
});

test('ERROR antes de ROOT_START libera la solicitud y permite reintentar', () => {
  const { client } = fixture();
  client.requestRoot(client.selectedImage);
  assert.ok(client.rootRequest);
  const requestId = client.rootRequest.requestId;
  client.handleControl(`ERROR ${requestId} ROOT_READ_ERROR`);
  assert.equal(client.rootRequest, null);
  assert.equal(client.rootReception, null);
  assert.equal(client.getSnapshot().error, true);
});

test('no se envía navegación si falta uno de los cuatro canales', () => {
  const { client, sent } = fixture();
  client.channels.get('NEXT').joined = false;
  assert.equal(client.zoom(1), false);
  client.pan(1, 0);
  assert.equal(sent.length, 0);
});
