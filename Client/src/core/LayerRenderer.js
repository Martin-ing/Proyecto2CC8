import {
  VIEWPORT_PIXELS, ZOOM_DURATION_MS, TILE_FADE_MS, cameraForView,
  tileWorldRect, projectRect, interpolateCamera, clamp, levelVirtualSize, MAX_CACHED_TILES, cameraTileKeys,
} from './geometry.js';
import { pixelSurface, releaseSurface } from './pixels.js';
import { PanMotion } from './PanMotion.js';

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
    this.drawnTiles = new Map();
    this.panMotion = new PanMotion();
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

  moveTo(view, animate, destination = cameraForView(this.client.selectedImage, view)) {
    this.panMotion.stop();
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

  startPan(view, destination = cameraForView(this.client.selectedImage, view)) {
    this.panMotion.startStep(this.camera, destination, view.zoom, performance.now());
    this.requestDraw();
  }

  advancePan(now) {
    if (this.animation || !this.camera || !this.panMotion.kind) return false;
    const result = this.panMotion.advance(this.camera, now);
    if (result.camera.x !== this.camera.x || result.camera.y !== this.camera.y) {
      this.client.commitPanCamera(result.camera);
    }
    if (result.finished && result.kind === 'step') this.client.finishPan();
    return result.moving;
  }

  requestDraw() {
    if (this.frame !== null || !this.context) return;
    this.frame = requestAnimationFrame(now => {
      this.frame = null;
      const panning = this.advancePan(now);
      const needsFrame = this.draw(now);
      this.client.releaseCoveredFallback();
      if (panning || needsFrame) this.requestDraw();
    });
  }

  forget(key) {
    releaseSurface(this.decoded.get(key)?.surface);
    this.decoded.delete(key);
    if (this.drawnTiles.delete(key)) this.client.schedulePublish();
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

  // Fundido sobre el fondo mientras llega el detalle. Al terminar, limpiar
  // sólo el rectángulo y dibujar con source-over también reemplaza el alfa,
  // sin la composición copy + clip por tile (costosa en Canvas 2D).
  paint(surface, worldRect, opacity = 1) {
    if (opacity <= 0) return;
    // Recortar antes de escalar: en z=8 la ROOT completa se proyectaría a
    // 262144×262144 aunque el canvas sólo muestre 1024×1024 píxeles.
    const c = this.camera;
    const x = Math.max(worldRect.x, c.x), y = Math.max(worldRect.y, c.y);
    const right = Math.min(worldRect.x + worldRect.width, c.x + c.size);
    const bottom = Math.min(worldRect.y + worldRect.height, c.y + c.size);
    if (right <= x || bottom <= y) return;
    const r = projectRect({ x, y, width: right - x, height: bottom - y }, c);
    const sx = (x - worldRect.x) * surface.width / worldRect.width;
    const sy = (y - worldRect.y) * surface.height / worldRect.height;
    const sw = (right - x) * surface.width / worldRect.width;
    const sh = (bottom - y) * surface.height / worldRect.height;
    const ctx = this.context;
    ctx.save();
    if (opacity >= 1) {
      ctx.clearRect(r.x, r.y, r.width, r.height);
    }
    ctx.globalAlpha = opacity;
    ctx.drawImage(surface, sx, sy, sw, sh, r.x, r.y, r.width, r.height);
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
    ctx.imageSmoothingEnabled = (view.visualZoom || 1) === 1;
    ctx.imageSmoothingQuality = 'high';
    const rootSize = levelVirtualSize(image, 0);
    const rootRect = { x: 0, y: 0, width: rootSize, height: rootSize };

    const entries = [...tileCache.entries()].filter(([, tile]) => tile.imageId === image.id);
    const drawnTiles = new Map();
    // Los tiles precargados se muestran de inmediato. Sólo se funden los que
    // acaban de llegar; un cambio de cámara no reinicia su fundido.
    const tileAlpha = tile => clamp((now - tile.receivedAt) / TILE_FADE_MS, 0, 1);
    const visible = cameraTileKeys(image, view.zoom, this.camera);
    const detailCoversView = visible.length > 0 && visible.every(key => {
      const tile = tileCache.get(key);
      return tile && tileAlpha(tile) >= 1;
    });
    const drawTile = (key, tile, alpha = 1) => {
      const rect = tileWorldRect(tile);
      if (!this.isVisible(rect) || alpha <= 0) return;
      this.client.tileCache.touch(key);
      this.paint(this.texture(key, tile), rect, alpha);
      if (tile.zoom === view.zoom) drawnTiles.set(key, tile);
    };
    // ROOT permanece en memoria. Dibujar las capas inferiores sólo ayuda
    // cuando falta detalle o continúa su fundido; si ya está completo, esas
    // capas se borrarían inmediatamente, incluso en el padding transparente.
    if (!detailCoversView) {
      this.paint(this.root, rootRect);
      entries.filter(([key, tile]) => tile.zoom < view.zoom && !pinnedTileKeys.has(key))
        .sort((a, b) => a[1].zoom - b[1].zoom)
        .forEach(([key, tile]) => drawTile(key, tile));
      if (this.fallback) {
        const { surface, camera } = this.fallback;
        this.paint(surface, { x: camera.x, y: camera.y, width: camera.size, height: camera.size });
      }
      entries.filter(([key, tile]) => pinnedTileKeys.has(key) && tile.zoom !== view.zoom)
        .forEach(([key, tile]) => drawTile(key, tile));
    }
    // 5. El nivel solicitado siempre termina encima, incluso al hacer zoom out.
    let fading = false;
    if (view.zoom === 0) {
      const alpha = this.animation ? clamp((animationProgress - 0.65) / 0.35, 0, 1) : 1;
      this.paint(this.root, rootRect, alpha);
    } else {
      for (const [key, tile] of entries) {
        if (tile.zoom !== view.zoom || !this.isVisible(tileWorldRect(tile))) continue;
        const alpha = tileAlpha(tile);
        if (alpha < 1) fading = true;
        drawTile(key, tile, alpha);
      }
    }
    while (this.decoded.size > MAX_CACHED_TILES) this.forget(this.decoded.keys().next().value);
    const changed = drawnTiles.size !== this.drawnTiles.size
      || [...drawnTiles].some(([key, tile]) => this.drawnTiles.get(key) !== tile);
    this.drawnTiles = drawnTiles;
    if (changed) this.client.schedulePublish();
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
    this.panMotion.stop();
    this.camera = null;
    this.targetSince = 0;
    releaseSurface(this.root);
    this.root = null;
    this.clearFallback();
    for (const key of this.decoded.keys()) this.forget(key);
    this.drawnTiles.clear();
    this.context?.clearRect(0, 0, VIEWPORT_PIXELS, VIEWPORT_PIXELS);
  }
}
