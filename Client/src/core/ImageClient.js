import {
  DATA_CHANNELS, TILE_SIZE, VIEWPORT_TILES, TILE_FADE_MS, clamp, levelVirtualSize,
  tilesPerAxis, tileKey, zoomTarget, planDesiredTileKeys, visibleTileKeys,
} from './geometry.js';
import { bytesPerPixel } from './pixels.js';
import { LayerRenderer } from './LayerRenderer.js';

const initialView = () => ({ zoom: 0, currentX: 0, currentY: 0, viewId: null });
const DEFAULT_URL = 'ws://localhost:8080/ws';

export class ImageClient {
  constructor() {
    this.listeners = new Set();
    this.control = null;
    this.generation = 0;
    this.channels = new Map(DATA_CHANNELS.map(channel => [channel, { socket: null, joined: false, stream: null }]));
    this.sessionId = null;
    this.images = [];
    this.catalogLoaded = false;
    this.catalogRequest = null;
    this.selectedImage = null;
    this.rootReception = null;
    this.rootRequest = null;
    this.rootInfo = null;
    this.rootProgress = { received: 0, total: 0 };
    this.format = 'RGBA8888';
    this.url = DEFAULT_URL;
    this.connection = 'disconnected';
    this.status = 'Conecta con tu servidor para comenzar.';
    this.error = false;
    this.view = initialView();
    this.nextRequestId = 1;
    this.nextViewId = 1;
    this.tileCache = new Map();
    this.desiredTileKeys = new Set();
    this.pinnedTileKeys = new Set();
    this.transitioning = false;
    this.transitionFrom = 0;
    this.renderer = new LayerRenderer(this);
    this.publishFrame = null;
    this.publish();
  }

  subscribe = listener => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getSnapshot = () => this.snapshot;

  publish() {
    const ready = this.allReady();
    const visible = visibleTileKeys(this.selectedImage, this.view);
    const visibleReady = visible.filter(key => this.tileCache.has(key)).length;
    let desiredReady = 0, cacheBytes = 0;
    for (const key of this.desiredTileKeys) if (this.tileCache.has(key)) desiredReady++;
    for (const tile of this.tileCache.values()) cacheBytes += tile.buffer.byteLength;
    const canNavigate = ready && !!this.rootInfo && !this.rootRequest && !this.transitioning;
    const maxStart = this.selectedImage && this.view.zoom > 0
      ? tilesPerAxis(this.selectedImage, this.view.zoom) - VIEWPORT_TILES : 0;
    this.snapshot = {
      url: this.url, connection: this.connection, status: this.status, error: this.error,
      ready, sessionId: this.sessionId, images: this.images, catalogLoaded: this.catalogLoaded,
      catalogLoading: this.catalogRequest !== null,
      selectedImage: this.selectedImage, rootInfo: this.rootInfo, format: this.format,
      rootLoading: this.rootRequest !== null, rootProgress: { ...this.rootProgress },
      view: { ...this.view }, transitioning: this.transitioning, transitionFrom: this.transitionFrom,
      cacheSize: this.tileCache.size, cacheBytes, desiredReady, desiredCount: this.desiredTileKeys.size,
      visibleReady, visibleTotal: visible.length, retainedCount: this.pinnedTileKeys.size,
      fallbackActive: !!this.renderer.fallback,
      axisTiles: this.selectedImage && this.view.zoom > 0 ? tilesPerAxis(this.selectedImage, this.view.zoom) : 0,
      canZoomIn: canNavigate && !!zoomTarget(this.selectedImage, this.view, 1),
      canZoomOut: canNavigate && this.view.zoom > 0,
      pan: {
        up: canNavigate && this.view.zoom > 0 && this.view.currentY > 0,
        down: canNavigate && this.view.zoom > 0 && this.view.currentY < maxStart,
        left: canNavigate && this.view.zoom > 0 && this.view.currentX > 0,
        right: canNavigate && this.view.zoom > 0 && this.view.currentX < maxStart,
      },
      channels: [
        { name: 'CONTROL', joined: this.control?.readyState === 1 && !!this.sessionId, progress: null },
        ...DATA_CHANNELS.map(name => {
          const channel = this.channels.get(name);
          return { name, joined: channel.joined, progress: channel.stream
            ? `${channel.stream.receivedCount}/${channel.stream.tiles.length}` : null };
        }),
      ],
    };
    this.listeners.forEach(listener => listener());
  }

  schedulePublish() {
    if (this.publishFrame !== null) return;
    this.publishFrame = requestAnimationFrame(() => { this.publishFrame = null; this.publish(); });
  }

  setStatus(message, error = false) { this.status = message; this.error = error; this.publish(); }
  allReady() {
    return !!this.sessionId && this.control?.readyState === 1
      && DATA_CHANNELS.every(name => this.channels.get(name).joined && this.channels.get(name).socket?.readyState === 1);
  }
  send(message) {
    if (this.control?.readyState !== 1 || !this.sessionId) return false;
    this.control.send(message);
    return true;
  }

  connect(url = this.url) {
    let parsed;
    try { parsed = new URL(url); } catch { this.setStatus('La dirección WebSocket no es válida.', true); return; }
    if (!['ws:', 'wss:'].includes(parsed.protocol)) {
      this.setStatus('Usa una dirección ws:// o wss://.', true); return;
    }
    this.disconnect();
    this.renderer.reset();
    this.tileCache.clear();
    this.desiredTileKeys.clear();
    this.pinnedTileKeys.clear();
    this.selectedImage = null;
    this.rootInfo = null;
    this.rootProgress = { received: 0, total: 0 };
    this.view = initialView();
    this.images = [];
    this.catalogLoaded = false;
    this.url = url;
    this.connection = 'connecting';
    this.setStatus('Conectando con el servidor Java…');
    const generation = this.generation;
    let socket;
    try { socket = new WebSocket(url); } catch (error) {
      this.connection = 'disconnected'; this.setStatus(error.message, true); return;
    }
    this.control = socket;
    socket.binaryType = 'arraybuffer';
    const active = () => generation === this.generation && this.control === socket;
    socket.addEventListener('open', () => {
      if (!active()) return;
      socket.send('SESSION_OPEN');
      this.setStatus('CONTROL conectado. Creando sesión…');
    });
    socket.addEventListener('message', event => {
      if (!active()) return;
      try {
        if (typeof event.data === 'string') this.handleControl(event.data);
        else if (event.data instanceof ArrayBuffer) this.handleRootBinary(event.data);
      } catch (error) { this.setStatus(`Error de protocolo: ${error.message}`, true); }
    });
    socket.addEventListener('close', () => {
      if (!active()) return;
      this.connection = 'disconnected';
      this.rootReception = null;
      this.rootRequest = null;
      this.catalogRequest = null;
      this.closeDataSockets();
      this.setStatus('Se cerró la conexión con el servidor. Puedes reconectar abajo.', true);
    });
    socket.addEventListener('error', () => {
      if (active()) this.setStatus(`No se pudo conectar con ${this.url}. Comprueba que el servidor esté activo.`, true);
    });
    this.publish();
  }

  closeDataSockets() {
    for (const channel of this.channels.values()) {
      const socket = channel.socket;
      channel.socket = null;
      channel.joined = false;
      channel.stream = null;
      socket?.close();
    }
  }

  disconnect() {
    this.generation++;
    this.control?.close();
    this.control = null;
    this.closeDataSockets();
    this.sessionId = null;
    this.rootReception = null;
    this.rootRequest = null;
    this.catalogRequest = null;
    this.transitioning = false;
    this.connection = 'disconnected';
  }

  dispose() {
    this.disconnect();
    this.renderer.reset();
    this.tileCache.clear();
    if (this.publishFrame !== null) cancelAnimationFrame(this.publishFrame);
    this.publishFrame = null;
  }

  openDataSockets() {
    const generation = this.generation;
    for (const name of DATA_CHANNELS) {
      const channel = this.channels.get(name);
      const socket = new WebSocket(this.url);
      channel.socket = socket;
      socket.binaryType = 'arraybuffer';
      const active = () => generation === this.generation && channel.socket === socket;
      socket.addEventListener('open', () => {
        if (active()) socket.send(`SESSION_JOIN ${this.sessionId} ${name}`);
      });
      socket.addEventListener('message', event => {
        if (!active()) return;
        try { this.handleData(name, event.data); }
        catch (error) { this.failStream(name, error.message); }
      });
      socket.addEventListener('close', () => {
        if (!active()) return;
        channel.joined = false;
        channel.stream = null;
        this.connection = 'partial';
        this.setStatus(`Se cerró el canal ${name}. Reconecta para continuar.`, true);
      });
      socket.addEventListener('error', () => {
        if (active()) { channel.joined = false; this.setStatus(`Error en el canal ${name}.`, true); }
      });
    }
  }

  handleControl(message) {
    const lines = message.replace(/\r/g, '').split('\n');
    const header = lines[0].trim().split(/\s+/);
    switch (header[0]) {
      case 'SESSION_OK':
        if (header.length !== 2) throw new Error('SESSION_OK inválido.');
        this.sessionId = header[1];
        this.openDataSockets();
        this.setStatus('Sesión creada. Abriendo CURRENT, PREVIOUS y NEXT…');
        break;
      case 'ARCHIVOS_OK': this.handleCatalog(header, lines); break;
      case 'ROOT_START': this.handleRootStart(header); break;
      case 'ROOT_DATA': this.handleRootHeader(header); break;
      case 'ROOT_END': this.handleRootEnd(header); break;
      case 'ERROR':
        if (this.rootRequest?.requestId === header[1]) this.failRoot(message);
        else {
          if (this.catalogRequest === header[1]) this.catalogRequest = null;
          this.setStatus(message, true);
        }
        break;
      default: console.warn('Mensaje CONTROL desconocido:', message);
    }
  }

  loadCatalog() {
    if (!this.allReady() || this.catalogRequest) return;
    this.catalogRequest = String(this.nextRequestId++);
    this.send(`ARCHIVOS ${this.catalogRequest}`);
    this.setStatus('Solicitando el catálogo de imágenes…');
  }

  handleCatalog(header, lines) {
    if (header[1] !== this.catalogRequest) return;
    this.catalogRequest = null;
    const images = lines.slice(1).filter(line => line.trim()).map(line => {
      const [id, name, width, height, virtualSize, maxZoom] = line.split('|');
      const image = { id, name, width: Number(width), height: Number(height), virtualSize: Number(virtualSize), maxZoom: Number(maxZoom) };
      if (!id || !name || ![image.width, image.height, image.virtualSize].every(n => Number.isSafeInteger(n) && n > 0)
        || !Number.isInteger(image.maxZoom) || image.maxZoom < 0 || image.maxZoom > 30
        || !Number.isInteger(levelVirtualSize(image, 0))) throw new Error('Imagen inválida en ARCHIVOS_OK.');
      return image;
    });
    if (images.length !== Number(header[2])) throw new Error('El catálogo no coincide con la cantidad anunciada.');
    this.images = images;
    this.catalogLoaded = true;
    this.setStatus(`${images.length} ${images.length === 1 ? 'imagen disponible' : 'imágenes disponibles'}.`);
  }

  setFormat(format) { if (!this.rootRequest && bytesPerPixel(format)) { this.format = format; this.publish(); } }

  requestRoot(image) {
    if (!this.allReady() || this.rootRequest || this.transitioning) return;
    if (this.view.viewId) this.send(`CANCEL ${this.view.viewId}`);
    this.clearCache(true);
    this.desiredTileKeys.clear();
    this.pinnedTileKeys.clear();
    this.renderer.reset();
    this.selectedImage = image;
    this.rootInfo = null;
    this.rootReception = null;
    this.rootProgress = { received: 0, total: 0 };
    this.view = initialView();
    this.rootRequest = { requestId: String(this.nextRequestId++), imageId: image.id, format: this.format };
    this.send(`ROOT ${this.rootRequest.requestId} ${image.id} ${this.format}`);
    this.setStatus(`Cargando la vista general de ${image.name}…`);
  }

  handleRootStart(header) {
    if (!this.rootRequest || header[1] !== this.rootRequest.requestId || header[2] !== this.rootRequest.imageId) return;
    const [, requestId, imageId, w, h, format, size, count] = header;
    const width = Number(w), height = Number(h), chunkSize = Number(size), chunkCount = Number(count);
    const length = width * height * bytesPerPixel(format);
    const expectedSize = levelVirtualSize(this.selectedImage, 0);
    if (header.length !== 8 || format !== this.rootRequest.format || !bytesPerPixel(format)
      || width !== expectedSize || height !== expectedSize
      || !Number.isSafeInteger(length) || length <= 0
      || !Number.isInteger(chunkSize) || chunkSize <= 0
      || chunkCount !== Math.ceil(length / chunkSize)) {
      this.failRoot('Metadata inválida en ROOT_START.'); return;
    }
    this.rootReception = {
      requestId, imageId, width, height, format, chunkSize, chunkCount,
      buffer: new Uint8Array(length), received: new Set(), awaiting: null,
    };
    this.rootProgress = { received: 0, total: chunkCount };
    this.publish();
  }

  handleRootHeader(header) {
    const root = this.rootReception;
    if (!root || root.requestId !== header[1]) return;
    const index = Number(header[2]), length = Number(header[3]);
    const expectedLength = Math.min(root.chunkSize, root.buffer.length - index * root.chunkSize);
    if (header.length !== 4 || root.awaiting || !Number.isInteger(index) || index < 0
      || index >= root.chunkCount || length !== expectedLength || root.received.has(index)) {
      this.failRoot('Cabecera ROOT_DATA inválida.'); return;
    }
    root.awaiting = { index, length };
  }

  handleRootBinary(buffer) {
    const root = this.rootReception;
    if (!root?.awaiting) return;
    const { index, length } = root.awaiting;
    if (buffer.byteLength !== length) { this.failRoot('El tamaño de un chunk ROOT no coincide.'); return; }
    root.buffer.set(new Uint8Array(buffer), index * root.chunkSize);
    root.received.add(index);
    root.awaiting = null;
    this.rootProgress = { received: root.received.size, total: root.chunkCount };
    this.schedulePublish();
  }

  handleRootEnd(header) {
    const root = this.rootReception;
    if (!root || root.requestId !== header[1]) return;
    if (root.awaiting || root.received.size !== root.chunkCount) { this.failRoot('ROOT incompleta. Vuelve a abrir la imagen.'); return; }
    this.renderer.setRoot(root);
    this.rootInfo = { width: root.width, height: root.height, format: root.format, bytes: root.buffer.byteLength };
    // El canvas de ROOT es la copia permanente; se libera el buffer de recepción.
    this.rootReception = null;
    this.rootRequest = null;
    this.setStatus('Vista general lista. Puedes explorar los niveles de detalle.');
  }

  failRoot(message) {
    this.rootReception = null;
    this.rootRequest = null;
    this.setStatus(message, true);
  }

  handleData(name, data) {
    const channel = this.channels.get(name);
    if (typeof data !== 'string') {
      if (data instanceof ArrayBuffer) this.handleTile(name, data);
      return;
    }
    const h = data.trim().split(/\s+/);
    if (h[0] === 'SESSION_JOINED') {
      if (h[1] !== this.sessionId || h[2] !== name) throw new Error('SESSION_JOINED inválido.');
      channel.joined = true;
      if (this.allReady()) { this.connection = 'connected'; this.setStatus('Los cuatro canales están listos. Carga el catálogo para comenzar.'); }
      else this.publish();
    } else if (h[0] === 'TILE_STREAM_START') this.handleStreamStart(name, h);
    else if (h[0] === 'TILE_STREAM_END') {
      const stream = channel.stream;
      if (!stream) return;
      const sent = Number(h[2]);
      if (h[1] !== stream.streamId || !Number.isInteger(sent) || sent < 0
        || sent > stream.tiles.length || sent !== stream.receivedCount) throw new Error('TILE_STREAM_END inválido.');
      // END parcial es válido cuando el servidor cancela una vista antigua.
      channel.stream = null;
      this.schedulePublish();
    } else if (h[0] === 'ERROR') this.failStream(name, data);
    else console.warn(`Mensaje ${name} desconocido:`, data);
  }

  handleStreamStart(name, h) {
    const [, streamId, viewId, imageId, channelName, z, format, size, bytes, count, ...coords] = h;
    const zoom = Number(z), tileSize = Number(size), tileBytes = Number(bytes), tileCount = Number(count);
    if (h.length < 10 || channelName !== name || !Number.isInteger(zoom) || zoom < 1
      || tileSize !== TILE_SIZE || !bytesPerPixel(format) || tileBytes !== tileSize * tileSize * bytesPerPixel(format)
      || !Number.isInteger(tileCount) || tileCount < 0 || coords.length !== tileCount) throw new Error('Metadata inválida en TILE_STREAM_START.');
    const tiles = coords.map(pair => {
      const parts = pair.split(',');
      const [tileX, tileY] = parts.map(Number);
      if (parts.length !== 2 || ![tileX, tileY].every(n => Number.isInteger(n) && n >= 0)) throw new Error('Coordenadas inválidas.');
      return { tileX, tileY };
    });
    this.channels.get(name).stream = { streamId, viewId, imageId, zoom, format, tileSize, tileBytes, tiles, receivedCount: 0 };
    this.schedulePublish();
  }

  handleTile(name, buffer) {
    const stream = this.channels.get(name).stream;
    if (!stream) return;
    if (buffer.byteLength !== stream.tileBytes || stream.receivedCount >= stream.tiles.length) throw new Error('Frame de tile inválido.');
    const { tileX, tileY } = stream.tiles[stream.receivedCount++];
    const key = tileKey(stream.imageId, stream.zoom, tileX, tileY);
    this.send(`TILE_ACK ${stream.imageId} ${stream.zoom} ${tileX} ${tileY}`);
    // La identidad de contenido manda, no viewId: un stream antiguo puede
    // entregar un tile que sigue siendo útil en la vista nueva.
    if (stream.imageId === this.selectedImage?.id && (this.desiredTileKeys.has(key) || this.pinnedTileKeys.has(key))) {
      if (!this.tileCache.has(key)) {
        this.tileCache.set(key, {
          imageId: stream.imageId, zoom: stream.zoom, tileX, tileY,
          width: stream.tileSize, height: stream.tileSize, format: stream.format,
          buffer: new Uint8Array(buffer), receivedAt: performance.now(),
        });
        this.renderer.requestDraw();
      }
    } else this.send(`TILE_EVICT ${stream.imageId} ${stream.zoom} ${tileX} ${tileY}`);
    this.schedulePublish();
  }

  failStream(name, message) {
    this.channels.get(name).stream = null;
    this.setStatus(`[${name}] ${message}`, true);
  }

  zoom(direction) {
    if (!this.allReady() || !this.rootInfo || this.rootRequest || this.transitioning) return false;
    const target = zoomTarget(this.selectedImage, this.view, direction);
    if (!target) return false;
    // La copia se toma antes de cambiar la cámara o purgar la caché.
    this.renderer.captureFallback();
    this.pinnedTileKeys = new Set([...this.tileCache]
      .filter(([key, tile]) => tile.zoom === this.view.zoom && this.desiredTileKeys.has(key))
      .map(([key]) => key));
    this.transitionFrom = this.view.zoom;
    this.transitioning = true;
    this.changeView(target, true);
    return true;
  }

  changeView(target, animate = false) {
    const previousId = this.view.viewId;
    const viewId = target.zoom === 0 ? null : String(this.nextViewId++);
    this.view = { ...target, viewId };
    this.desiredTileKeys = planDesiredTileKeys(this.selectedImage, target.zoom, target.currentX, target.currentY);
    this.pruneCache();
    this.renderer.moveTo(this.view, animate);
    if (target.zoom === 0) {
      if (previousId) this.send(`CANCEL ${previousId}`);
      this.setStatus('Volviendo a la ROOT local…');
    } else {
      this.send(`VIEWPORT ${viewId} ${this.selectedImage.id} ${target.zoom} ${target.currentX} ${target.currentY}`);
      this.setStatus(`Vista ${viewId}: nivel ${target.zoom}, ventana 4 × 4 desde (${target.currentX}, ${target.currentY}).`);
    }
  }

  finishTransition() {
    this.transitioning = false;
    if (!this.error) this.status = this.view.zoom === 0
      ? 'ROOT restaurada desde la copia local.' : `Nivel ${this.view.zoom} activo. Los tiles se completan conforme llegan.`;
    this.publish();
  }

  releaseCoveredFallback() {
    if (this.transitioning || (!this.renderer.fallback && this.pinnedTileKeys.size === 0)) return;
    const now = performance.now();
    const covered = this.view.zoom === 0 || visibleTileKeys(this.selectedImage, this.view)
      .every(key => this.tileCache.has(key) && now - this.tileCache.get(key).receivedAt >= TILE_FADE_MS);
    if (!covered) return;
    this.renderer.clearFallback();
    this.pinnedTileKeys.clear();
    this.pruneCache();
    this.publish();
  }

  pan(dx, dy) {
    if (!this.allReady() || !this.rootInfo || this.transitioning || this.view.zoom < 1) return;
    const max = tilesPerAxis(this.selectedImage, this.view.zoom) - VIEWPORT_TILES;
    const currentX = clamp(this.view.currentX + dx, 0, max), currentY = clamp(this.view.currentY + dy, 0, max);
    if (currentX === this.view.currentX && currentY === this.view.currentY) return;
    // Se mantiene el desplazamiento original de un tile, sin otra animación.
    this.changeView({ zoom: this.view.zoom, currentX, currentY });
  }

  evict(key, tile, notify = true) {
    this.tileCache.delete(key);
    this.renderer.forget(key);
    if (notify) this.send(`TILE_EVICT ${tile.imageId} ${tile.zoom} ${tile.tileX} ${tile.tileY}`);
  }
  pruneCache() {
    for (const [key, tile] of this.tileCache) {
      if (!this.desiredTileKeys.has(key) && !this.pinnedTileKeys.has(key)) this.evict(key, tile);
    }
  }
  clearCache(notify) { for (const [key, tile] of this.tileCache) this.evict(key, tile, notify); }
}
