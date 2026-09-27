import test from 'node:test';
import assert from 'node:assert/strict';
import { bindPointerNavigation } from '../src/core/pointerNavigation.js';

function fixture() {
  const canvas = new EventTarget(), win = new EventTarget(), doc = new EventTarget();
  const calls = [], captured = new Set();
  canvas.setPointerCapture = id => captured.add(id);
  canvas.hasPointerCapture = id => captured.has(id);
  canvas.releasePointerCapture = id => captured.delete(id);
  canvas.focus = () => {};
  canvas.getBoundingClientRect = () => ({ width: 600, height: 600 });
  const client = {
    beginDrag() { calls.push(['begin']); return true; },
    dragBy(...args) { calls.push(['move', ...args]); },
    endDrag(cancelled) { calls.push(['end', cancelled]); },
    stopFreePan() { calls.push(['stop']); },
  };
  const cleanup = bindPointerNavigation(canvas, client, win, doc);
  const dispatch = (type, args = {}, target = canvas) => {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { button: 0, buttons: 1, pointerId: 1, isPrimary: true, pointerType: 'mouse', clientX: 10, clientY: 20 }, args);
    target.dispatchEvent(event);
  };
  return { canvas, win, doc, calls, captured, dispatch, cleanup };
}

test('pointer capture, movimiento diagonal y liberación fuera del área', () => {
  const f = fixture();
  f.dispatch('pointerdown');
  assert.ok(f.captured.has(1));
  f.dispatch('pointermove', { clientX: 900, clientY: -50 });
  assert.deepEqual(f.calls.at(-1), ['move', 890, -70, 600, 600]);
  f.dispatch('pointerup', { clientX: 900, clientY: -50 });
  f.dispatch('lostpointercapture');
  assert.deepEqual(f.calls.filter(call => call[0] === 'end'), [['end', false]]);
  assert.equal(f.captured.size, 0);
  f.cleanup();
});

test('botón derecho y un segundo puntero no alteran el gesto activo', () => {
  const f = fixture();
  f.dispatch('pointerdown', { button: 2 });
  assert.equal(f.calls.length, 0);
  f.dispatch('pointerdown');
  f.dispatch('pointerdown', { pointerId: 2 });
  f.dispatch('pointermove', { pointerId: 2, clientX: 500 });
  f.dispatch('pointerup', { pointerId: 2 });
  assert.deepEqual(f.calls, [['begin']]);
  f.cleanup();
});

test('cancelación, blur y desmontaje liberan la captura y los listeners', () => {
  const f = fixture();
  f.dispatch('pointerdown');
  f.dispatch('pointercancel');
  assert.deepEqual(f.calls.at(-1), ['end', true]);
  f.dispatch('pointerdown');
  f.dispatch('blur', {}, f.win);
  assert.deepEqual(f.calls.at(-2), ['end', true]);
  assert.equal(f.captured.size, 0);
  f.dispatch('pointerdown');
  f.cleanup();
  const count = f.calls.length;
  f.dispatch('pointerdown');
  f.dispatch('pointermove');
  assert.equal(f.calls.length, count);
});
