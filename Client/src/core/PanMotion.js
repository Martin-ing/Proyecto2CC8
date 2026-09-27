import { clamp, clampCamera, interpolateCamera } from './geometry.js';

// Píxeles del nivel actual por segundo: 512 = dos tiles por segundo.
// El límite es vectorial, por lo que una diagonal no avanza más rápido.
export const PAN_SPEED_PX_PER_SECOND = 512;
export const PAN_FOLLOW_MS = 100;
export const PAN_RELEASE_DISTANCE_PX = 64;
export const PAN_SETTLE_EPSILON_PX = 0.25;
export const PAN_MAX_FRAME_MS = 50;

export class PanMotion {
  constructor() { this.stop(); }

  stop() {
    this.kind = null;
    this.dragging = false;
    this.target = null;
    this.from = null;
    this.lastTime = null;
    this.elapsed = 0;
    this.duration = 0;
    this.scale = 1;
  }

  startDrag(camera, zoom, now) {
    this.stop();
    this.kind = 'drag';
    this.dragging = true;
    this.target = { ...camera };
    this.scale = 2 ** zoom;
    this.lastTime = now;
  }

  dragBy(dx, dy, image, zoom) {
    if (!this.dragging) return;
    // Limitar el objetivo evita acumular desplazamiento fuera de los bordes.
    this.target = clampCamera(image, zoom, { ...this.target, x: this.target.x + dx, y: this.target.y + dy });
  }

  endDrag(camera, cancelled = false) {
    if (this.kind !== 'drag') return;
    if (cancelled) { this.stop(); return; }
    this.dragging = false;
    // Al soltar no perseguimos un gesto rápido durante varios segundos:
    // queda como máximo un cuarto de tile de frenado, sin ajuste a la matriz.
    const dx = this.target.x - camera.x, dy = this.target.y - camera.y;
    const distance = Math.hypot(dx, dy);
    const limit = PAN_RELEASE_DISTANCE_PX / this.scale;
    if (distance > limit) this.target = { ...camera, x: camera.x + dx * limit / distance, y: camera.y + dy * limit / distance };
  }

  startStep(camera, destination, zoom, now) {
    this.stop();
    this.kind = 'step';
    this.from = { ...camera };
    this.target = { ...destination };
    this.scale = 2 ** zoom;
    this.lastTime = now;
    const distance = Math.hypot(destination.x - camera.x, destination.y - camera.y) * this.scale;
    // Smoothstep tiene una velocidad máxima de 1.5 * distancia / duración.
    this.duration = Math.max(220, 1500 * distance / PAN_SPEED_PX_PER_SECOND);
  }

  advance(camera, now) {
    if (!this.kind) return { camera, moving: false, finished: false };
    const kind = this.kind;
    const dt = clamp(now - this.lastTime, 0, PAN_MAX_FRAME_MS);
    this.lastTime = now;
    if (kind === 'step') {
      this.elapsed += dt;
      const progress = clamp(this.elapsed / this.duration, 0, 1);
      const next = progress === 1 ? { ...this.target } : interpolateCamera(this.from, this.target, progress);
      if (progress === 1) this.stop();
      return { camera: next, moving: progress < 1, finished: progress === 1, kind };
    }
    const dx = this.target.x - camera.x, dy = this.target.y - camera.y;
    const distance = Math.hypot(dx, dy);
    const limit = PAN_SPEED_PX_PER_SECOND * dt / (1000 * this.scale);
    const step = Math.min(distance * (1 - Math.exp(-dt / PAN_FOLLOW_MS)), limit);
    const settled = distance <= PAN_SETTLE_EPSILON_PX / this.scale && distance <= limit;
    const next = settled ? { ...this.target } : distance > 0
      ? { ...camera, x: camera.x + dx * step / distance, y: camera.y + dy * step / distance }
      : camera;
    const finished = settled && !this.dragging;
    if (finished) this.stop();
    return { camera: next, moving: !settled && distance > 0, finished, kind };
  }
}
