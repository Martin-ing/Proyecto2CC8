import { NthChanceClock } from './NthChanceClock.js';
import { MAX_CACHED_TILES, tileKey, visibleTileKeys } from './geometry.js';

export class TileClockCache {
  constructor(onEvict = () => {}) {
    this.onEvict = onEvict;
    this.levels = new Map();
    this.owners = new Map();
    this.desired = new Set();
    this.central = new Set();
    this.imageId = null;
    this.zoom = 0;
    this.evictions = 0;
  }

  get size() { return this.owners.size; }
  has(key) { return this.owners.has(key); }
  get(key) { return this.owners.get(key)?.get(key); }
  *entries() { for (const { clock } of this.levels.values()) yield* clock.entries(); }
  *values() { for (const [, tile] of this.entries()) yield tile; }
  [Symbol.iterator]() { return this.entries(); }

  configure(image, view, desiredKeys) {
    if (this.imageId !== image.id) this.clear();
    this.imageId = image.id;
    this.zoom = view.zoom;
    this.desired = new Set(desiredKeys);
    this.central = new Set(visibleTileKeys(image, view));
    const roles = new Map();
    if (view.zoom > 0) roles.set(view.zoom, { role: 'CURRENT', capacity: 36 });
    if (view.zoom > 1) roles.set(view.zoom - 1, { role: 'PREVIOUS', capacity: 16 });
    if (view.zoom < image.maxZoom) roles.set(view.zoom + 1, { role: 'NEXT', capacity: 16 });
    for (const [zoom, level] of this.levels) {
      if (!roles.has(zoom)) { level.clock.clear(); this.levels.delete(zoom); }
    }
    // Reducir antes de ampliar mantiene el límite incluso al rotar niveles.
    const sorted = [...roles].sort((a, b) => a[1].capacity - b[1].capacity);
    for (const [zoom, { role, capacity }] of sorted) {
      let level = this.levels.get(zoom);
      if (!level) {
        const clock = new NthChanceClock(capacity, (key, tile, reason) => {
          this.owners.delete(key);
          this.evictions++;
          this.onEvict(key, tile, reason);
        });
        level = { zoom, role, clock };
        this.levels.set(zoom, level);
      }
      level.role = role;
      for (const key of this.desired) if (level.clock.has(key)) level.clock.touch(key, this.chances(key));
      level.clock.resize(capacity, this.desired);
    }
  }

  chances(key) { return this.central.has(key) ? 2 : 1; }
  touch(key) { return this.owners.get(key)?.touch(key, this.chances(key)) || false; }

  set(key, tile, { allowExtra = false } = {}) {
    const level = this.levels.get(tile.zoom);
    if (tile.imageId !== this.imageId || !level
      || key !== tileKey(tile.imageId, tile.zoom, tile.tileX, tile.tileY)) return false;
    if (this.has(key)) { if (this.desired.has(key)) this.touch(key); return true; }
    if (!this.desired.has(key) && (!allowExtra || level.clock.size >= level.clock.capacity)) return false;
    const accepted = level.clock.put(key, tile, this.chances(key), this.desired);
    if (accepted) this.owners.set(key, level.clock);
    return accepted;
  }

  delete(key) { return this.owners.get(key)?.delete(key) || false; }
  clear() {
    for (const { clock } of this.levels.values()) clock.clear();
    this.levels.clear();
    this.owners.clear();
    this.desired.clear();
    this.central.clear();
    this.imageId = null;
    this.zoom = 0;
  }

  inspect() {
    return {
      algorithm: 'Nth-chance Clock', size: this.size, limit: MAX_CACHED_TILES, evictions: this.evictions,
      levels: [...this.levels.values()].sort((a, b) => a.zoom - b.zoom).map(({ zoom, role, clock }) => ({
        zoom, role, ...clock.inspect(this.desired),
      })),
    };
  }
}
