// Pointer capture permite seguir arrastrando aunque el mouse salga del canvas.
export function bindPointerNavigation(canvas, client, ownerWindow = window, ownerDocument = document) {
  let pointer = null;
  const finish = (cancelled = false) => {
    if (!pointer) return;
    const id = pointer.id;
    pointer = null; // lostpointercapture no debe finalizar dos veces el gesto.
    client.endDrag(cancelled);
    if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
  };
  const down = event => {
    if (pointer || event.button !== 0 || event.isPrimary === false || !client.beginDrag()) return;
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
    try { canvas.setPointerCapture(event.pointerId); }
    catch { finish(true); return; }
    canvas.focus({ preventScroll: true });
    event.preventDefault();
  };
  const move = event => {
    if (!pointer || pointer.id !== event.pointerId) return;
    if (event.pointerType === 'mouse' && event.buttons === 0) { finish(); return; }
    const rect = canvas.getBoundingClientRect();
    client.dragBy(event.clientX - pointer.x, event.clientY - pointer.y, rect.width, rect.height);
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    event.preventDefault();
  };
  const up = event => { if (pointer?.id === event.pointerId) finish(); };
  const cancel = event => { if (pointer?.id === event.pointerId) finish(true); };
  const blur = () => { finish(true); client.stopFreePan(); };
  const visibility = () => { if (ownerDocument.hidden) blur(); };
  const keydown = event => { if (event.key === 'Escape') blur(); };
  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', cancel);
  canvas.addEventListener('lostpointercapture', cancel);
  canvas.addEventListener('keydown', keydown);
  ownerWindow.addEventListener('blur', blur);
  ownerDocument.addEventListener('visibilitychange', visibility);
  return () => {
    finish(true);
    canvas.removeEventListener('pointerdown', down);
    canvas.removeEventListener('pointermove', move);
    canvas.removeEventListener('pointerup', up);
    canvas.removeEventListener('pointercancel', cancel);
    canvas.removeEventListener('lostpointercapture', cancel);
    canvas.removeEventListener('keydown', keydown);
    ownerWindow.removeEventListener('blur', blur);
    ownerDocument.removeEventListener('visibilitychange', visibility);
  };
}
