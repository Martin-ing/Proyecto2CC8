export const TILE_SIZE = 256;
export const VIEWPORT_TILES = 4;
export const VIEWPORT_PIXELS = TILE_SIZE * VIEWPORT_TILES;
export const ZOOM_DURATION_MS = 1000;
export const TILE_FADE_MS = 180;
export const DATA_CHANNELS = ['CURRENT', 'PREVIOUS', 'NEXT'];
export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export const tileKey = (id, z, x, y) => `${id}:${z}:${x}:${y}`;

export function levelVirtualSize(image, zoom) {
  return image.virtualSize / 2 ** (image.maxZoom - zoom);
}

export function tilesPerAxis(image, zoom) {
  return levelVirtualSize(image, zoom) / TILE_SIZE;
}

// Un único espacio de coordenadas: píxeles virtuales de nivel 0.
// El padding ya viene en ROOT y en los tiles. No se vuelve a sumar offsetX/Y.
export function cameraForView(image, view) {
  if (view.zoom === 0) return { x: 0, y: 0, size: levelVirtualSize(image, 0) };
  const scale = 2 ** view.zoom;
  return {
    x: view.currentX * TILE_SIZE / scale,
    y: view.currentY * TILE_SIZE / scale,
    size: VIEWPORT_PIXELS / scale,
  };
}

export function tileWorldRect(tile) {
  const scale = 2 ** tile.zoom;
  return {
    x: tile.tileX * TILE_SIZE / scale,
    y: tile.tileY * TILE_SIZE / scale,
    width: tile.width / scale,
    height: tile.height / scale,
  };
}

export function projectRect(rect, camera) {
  const scale = VIEWPORT_PIXELS / camera.size;
  return {
    x: (rect.x - camera.x) * scale,
    y: (rect.y - camera.y) * scale,
    width: rect.width * scale,
    height: rect.height * scale,
  };
}

export function interpolateCamera(from, to, progress) {
  const t = clamp(progress, 0, 1);
  const ease = t * t * (3 - 2 * t);
  const size = Math.exp(Math.log(from.size) * (1 - ease) + Math.log(to.size) * ease);
  const cx = (from.x + from.size / 2) * (1 - ease) + (to.x + to.size / 2) * ease;
  const cy = (from.y + from.size / 2) * (1 - ease) + (to.y + to.size / 2) * ease;
  return { x: cx - size / 2, y: cy - size / 2, size };
}

export function zoomTarget(image, view, direction) {
  const zoom = view.zoom + direction;
  if (zoom < 0 || zoom > image.maxZoom) return null;
  if (zoom === 0) return { zoom: 0, currentX: 0, currentY: 0 };
  const maxStart = tilesPerAxis(image, zoom) - VIEWPORT_TILES;
  if (!Number.isInteger(maxStart) || maxStart < 0) return null;
  if (view.zoom === 0) {
    const start = Math.max(0, Math.floor(maxStart / 2));
    return { zoom, currentX: start, currentY: start };
  }
  const start = value => direction > 0
    ? 2 * (value + 1)
    : Math.floor((value + VIEWPORT_TILES / 2) / 2) - VIEWPORT_TILES / 2;
  return {
    zoom,
    currentX: clamp(start(view.currentX), 0, maxStart),
    currentY: clamp(start(view.currentY), 0, maxStart),
  };
}

// Conserva exactamente el plan A+B+C+D del servidor actual.
export function planDesiredTileKeys(image, zoom, currentX, currentY) {
  const keys = new Set();
  if (zoom === 0) return keys;
  const add = (z, x, y) => {
    const count = tilesPerAxis(image, z);
    if (x >= 0 && y >= 0 && x < count && y < count) keys.add(tileKey(image.id, z, x, y));
  };
  const square = (z, x, y) => {
    for (let row = y; row < y + VIEWPORT_TILES; row++) {
      for (let column = x; column < x + VIEWPORT_TILES; column++) add(z, column, row);
    }
  };
  square(zoom, currentX, currentY);
  for (let i = 0; i < VIEWPORT_TILES; i++) {
    add(zoom, currentX + i, currentY - 1);
    add(zoom, currentX + i, currentY + VIEWPORT_TILES);
    add(zoom, currentX - 1, currentY + i);
    add(zoom, currentX + VIEWPORT_TILES, currentY + i);
  }
  const view = { zoom, currentX, currentY };
  if (zoom < image.maxZoom) {
    const target = zoomTarget(image, view, 1);
    square(target.zoom, target.currentX, target.currentY);
  }
  if (zoom > 1) {
    const target = zoomTarget(image, view, -1);
    square(target.zoom, target.currentX, target.currentY);
  }
  return keys;
}

export function visibleTileKeys(image, view) {
  if (!image || view.zoom === 0) return [];
  const keys = [];
  for (let row = 0; row < VIEWPORT_TILES; row++) {
    for (let column = 0; column < VIEWPORT_TILES; column++) {
      keys.push(tileKey(image.id, view.zoom, view.currentX + column, view.currentY + row));
    }
  }
  return keys;
}
