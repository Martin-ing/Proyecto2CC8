import {
  VIEWPORT_PIXELS, ZOOM_DURATION_MS, TILE_FADE_MS, cameraForView,
  tileWorldRect, projectRect, interpolateCamera, clamp, levelVirtualSize,
} from './geometry.js';
import { pixelSurface, releaseSurface } from './pixels.js';

const MAX_DECODED_TILES = 64;

export class LayerRenderer {
  constructor(client) {
    this.client = client;
    this.canvas = null;
    this.context = null;
    this.root = null;
    this.fallback = null;
    this.camera = null;
    this.animation = null;
    this.frame = null;
    this.targetSince = 0;
    this.decoded = new Map();
  }

  attach(canvas) {
    this.canvas = canvas;
    canvas.width = VIEWPORT_PIXELS;
    canvas.height = VIEWPORT_PIXELS;
    this.context = canvas.getContext('2d');
    this.requestDraw();
  }

  setRoot(reception) {
    releaseSurface(this.root);
    this.root = pixelSurface(reception.buffer, reception.width, reception.height, reception.format);
    this.camera = cameraForView(this.client.selectedImage, this.client.view);
    this.requestDraw();
  }

  // Una única copia compuesta cubre incluso varios zooms con descargas lentas.
  // No se crea una cadena ilimitada de canvases ni se copia la imagen completa.
  captureFallback() {
    if (!this.root || !this.camera || !this.canvas) return;
    this.draw(performance.now());
    const surface = document.createElement('canvas');
    surface.width = surface.height = VIEWPORT_PIXELS;
    surface.getContext('2d').drawImage(this.canvas, 0, 0);
    this.clearFallback();
    this.fallback = { surface, camera: { ...this.camera } };
  }

  clearFallback() {
    releaseSurface(this.fallback?.surface);
    this.fallback = null;
  }

  moveTo(view, animate) {
    const destination = cameraForView(this.client.selectedImage, view);
    if (animate && this.camera) {
      this.targetSince = performance.now();
      this.animation = {
        from: { ...this.camera }, to: destination, startedAt: this.targetSince,
      };
    } else {
      this.animation = null;
      this.camera = destination;
    }
    this.requestDraw();
  }

  requestDraw() {
    if (this.frame !== null || !this.context) return;
    this.frame = requestAnimationFrame(now => {
      this.frame = null;
      const needsFrame = this.draw(now);
      if (needsFrame) this.requestDraw();
      else this.client.releaseCoveredFallback();
    });
  }

  forget(key) {
    releaseSurface(this.decoded.get(key)?.surface);
    this.decoded.delete(key);
  }

  texture(key, tile) {
    let entry = this.decoded.get(key);
    if (entry?.tile !== tile) {
      this.forget(key);
      entry = { tile, surface: pixelSurface(tile.buffer, tile.width, tile.height, tile.format) };
    }
    this.decoded.delete(key);
    this.decoded.set(key, entry);
    return entry.surface;
  }

  // Fundido sobre el fondo mientras llega el detalle. Al completar el fade,
  // se reemplaza también el alfa: no quedan imágenes fantasma en el padding.
  paint(surface, worldRect, opacity = 1) {
    if (opacity <= 0) return;
    const r = projectRect(worldRect, this.camera);
    const ctx = this.context;
    ctx.save();
    if (opacity >= 1) ctx.clearRect(r.x, r.y, r.width, r.height);
    ctx.globalAlpha = opacity;
    ctx.drawImage(surface, r.x, r.y, r.width, r.height);
    ctx.restore();
  }

  isVisible(rect) {
    const c = this.camera;
    return rect.x < c.x + c.size && rect.y < c.y + c.size
      && rect.x + rect.width > c.x && rect.y + rect.height > c.y;
  }

  draw(now) {
    const { selectedImage: image, view, tileCache, pinnedTileKeys } = this.client;
    if (!this.context || !this.root || !image || !this.camera) return false;
    let animationProgress = 1;
    if (this.animation) {
      animationProgress = clamp((now - this.animation.startedAt) / ZOOM_DURATION_MS, 0, 1);
      this.camera = interpolateCamera(this.animation.from, this.animation.to, animationProgress);
    }
    const ctx = this.context;
    ctx.clearRect(0, 0, VIEWPORT_PIXELS, VIEWPORT_PIXELS);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const rootSize = levelVirtualSize(image, 0);
    const rootRect = { x: 0, y: 0, width: rootSize, height: rootSize };

    // 1. ROOT siempre está cargada y siempre se dibuja como base.
    this.paint(this.root, rootRect);
    const entries = [...tileCache.entries()].filter(([, tile]) => tile.imageId === image.id);
    const drawTile = (key, tile, alpha = 1) => {
      const rect = tileWorldRect(tile);
      if (!this.isVisible(rect) || alpha <= 0) return;
      this.paint(this.texture(key, tile), rect, alpha);
    };
    // 2. Prefetch del nivel inferior, en su escala real.
    entries.filter(([key, tile]) => tile.zoom < view.zoom && !pinnedTileKeys.has(key))
      .sort((a, b) => a[1].zoom - b[1].zoom)
      .forEach(([key, tile]) => drawTile(key, tile));
    // 3. Composición que el usuario estaba viendo antes del cambio.
    if (this.fallback) {
      const { surface, camera } = this.fallback;
      this.paint(surface, { x: camera.x, y: camera.y, width: camera.size, height: camera.size });
    }
    // 4. Tiles del nivel que acabamos de abandonar, incluidos sus vecinos.
    entries.filter(([key, tile]) => pinnedTileKeys.has(key) && tile.zoom !== view.zoom)
      .forEach(([key, tile]) => drawTile(key, tile));
    // 5. El nivel solicitado siempre termina encima, incluso al hacer zoom out.
    let fading = false;
    if (view.zoom === 0) {
      const alpha = this.animation ? clamp((animationProgress - 0.65) / 0.35, 0, 1) : 1;
      this.paint(this.root, rootRect, alpha);
    } else {
      for (const [key, tile] of entries) {
        if (tile.zoom !== view.zoom || !this.isVisible(tileWorldRect(tile))) continue;
        const alpha = clamp((now - Math.max(tile.receivedAt, this.targetSince)) / TILE_FADE_MS, 0, 1);
        if (alpha < 1) fading = true;
        drawTile(key, tile, alpha);
      }
    }
    while (this.decoded.size > MAX_DECODED_TILES) this.forget(this.decoded.keys().next().value);
    if (this.animation && animationProgress >= 1) {
      this.camera = this.animation.to;
      this.animation = null;
      this.client.finishTransition();
    }
    return !!this.animation || fading;
  }

  reset() {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.animation = null;
    this.camera = null;
    this.targetSince = 0;
    releaseSurface(this.root);
    this.root = null;
    this.clearFallback();
    for (const key of this.decoded.keys()) this.forget(key);
    this.context?.clearRect(0, 0, VIEWPORT_PIXELS, VIEWPORT_PIXELS);
  }
}
