import {
  DATA_CHANNELS, TILE_SIZE, TILE_FADE_MS, levelVirtualSize,
  tilesPerAxis, tileKey, zoomTarget, planDesiredTileKeys,
  cameraForView, cameraTileKeys, viewForCamera, clampCamera, MAX_VISUAL_ZOOM, VIEWPORT_PIXELS,
} from './geometry.js';
import { bytesPerPixel } from './pixels.js';
import { LayerRenderer } from './LayerRenderer.js';
import { TileClockCache } from './TileClockCache.js';

const initialView = () => ({ zoom: 0, currentX: 0, currentY: 0, visualZoom: 1, viewId: null });
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
    this.format = 'RGBA4444';
    this.url = DEFAULT_URL;
    this.connection = 'disconnected';
    this.status = 'Conecta con tu servidor para comenzar.';
    this.error = false;
    this.view = initialView();
    this.nextRequestId = 1;
    this.nextViewId = 1;
    this.suppressCacheNotifications = false;
    this.tileCache = new TileClockCache((key, tile) => this.onCacheEviction(key, tile));
    this.desiredTileKeys = new Set();
    this.pinnedTileKeys = new Set();
    this.transitioning = false;
    this.transitionFrom = 0;
    this.dragging = false;
    this.panning = false;
    this.visualSignature = '';
    this.renderer = new LayerRenderer(this);
    this.publishFrame = null;
    this.publish();
  }

  subscribe = listener => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getSnapshot = () => this.snapshot;

  publish() {
    const ready = this.allReady();
    const visible = this.transitioning && this.selectedImage
      ? this.actualVisibleKeys(this.renderer.animation?.to || cameraForView(this.selectedImage, this.view))
      : this.actualVisibleKeys();
    const visibleReady = visible.filter(key => this.tileCache.has(key)).length;
    const renderedReady = visible.filter(key => this.tileCache.has(key)
      && this.renderer.drawnTiles?.get(key) === this.tileCache.get(key)).length;
    let desiredReady = 0, cacheBytes = 0;
    for (const key of this.desiredTileKeys) if (this.tileCache.has(key)) desiredReady++;
    for (const tile of this.tileCache.values()) cacheBytes += tile.buffer.byteLength;
    const canNavigate = ready && !!this.rootInfo && !this.rootRequest && !this.transitioning && !this.dragging && !this.panning;
    const camera = this.renderer.camera;
    const cameraLimit = this.selectedImage && camera ? levelVirtualSize(this.selectedImage, 0) - camera.size : 0;
    const visualZoom = this.view.visualZoom || 1;
    this.snapshot = {
      url: this.url, connection: this.connection, status: this.status, error: this.error,
      ready, sessionId: this.sessionId, images: this.images, catalogLoaded: this.catalogLoaded,
      catalogLoading: this.catalogRequest !== null,
      selectedImage: this.selectedImage, rootInfo: this.rootInfo, format: this.format,
      rootLoading: this.rootRequest !== null, rootProgress: { ...this.rootProgress },
      view: { ...this.view }, transitioning: this.transitioning, transitionFrom: this.transitionFrom,
      dragging: this.dragging, panning: this.panning,
      canDrag: canNavigate && cameraLimit > 1e-8,
      cacheSize: this.tileCache.size, cacheBytes, desiredReady, desiredCount: this.desiredTileKeys.size,
      clockCache: this.tileCache.inspect(),
      visibleReady, renderedReady, visibleTotal: visible.length,
      retainedCount: [...this.pinnedTileKeys].filter(key => this.tileCache.has(key)).length,
      fallbackActive: !!this.renderer.fallback,
      axisTiles: this.selectedImage && this.view.zoom > 0 ? tilesPerAxis(this.selectedImage, this.view.zoom) : 0,
      canZoomIn: canNavigate && (!!zoomTarget(this.selectedImage, this.view, 1)
        || (this.view.zoom === this.selectedImage.maxZoom && visualZoom < MAX_VISUAL_ZOOM)),
      canZoomOut: canNavigate && (this.view.zoom > 0 || visualZoom > 1),
      pan: {
        up: canNavigate && camera?.y > 1e-8,
        down: canNavigate && camera?.y < cameraLimit - 1e-8,
        left: canNavigate && camera?.x > 1e-8,
        right: canNavigate && camera?.x < cameraLimit - 1e-8,
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

  actualVisibleKeys(camera = this.renderer.camera) {
    if (!this.selectedImage) return [];
    return cameraTileKeys(this.selectedImage, this.view.zoom, camera || cameraForView(this.selectedImage, this.view));
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
    this.stopFreePan();
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
    this.visualSignature = '';
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
        this.stopFreePan();
        this.setStatus(`Se cerró el canal ${name}. Reconecta para continuar.`, true);
      });
      socket.addEventListener('error', () => {
        if (active()) { channel.joined = false; this.stopFreePan(); this.setStatus(`Error en el canal ${name}.`, true); }
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
    if (!this.allReady() || this.rootRequest || this.transitioning || this.dragging || this.panning) return;
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
    this.visualSignature = '';
    this.rootRequest = { requestId: String(this.nextRequestId++), imageId: image.id, format: this.format };
    this.send(`ROOT ${this.rootRequest.requestId} ${image.id} ${this.format}`);
    // El mismo CONTROL procesa ROOT y después prepara NEXT. La caché queda
    // configurada antes de que puedan llegar tiles desde el otro socket.
    this.changeView(this.view, false, { keepCamera: true });
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
    // La identidad de contenido manda, no viewId: un stream antiguo puede
    // entregar un tile que sigue siendo útil, incluso desde otro canal.
    const accepted = this.tileCache.set(key, {
      imageId: stream.imageId, zoom: stream.zoom, tileX, tileY,
      width: stream.tileSize, height: stream.tileSize, format: stream.format,
      buffer: new Uint8Array(buffer), receivedAt: performance.now(),
    }, { allowExtra: this.pinnedTileKeys.has(key) });
    // El ACK confirma la recepción. Si no se admite, ACK + EVICT mantiene
    // clientHas fiel a la caché. Duplicados conservados NO envían EVICT.
    this.send(`TILE_ACK ${stream.imageId} ${stream.zoom} ${tileX} ${tileY}`);
    if (accepted) this.renderer.requestDraw();
    else this.send(`TILE_EVICT ${stream.imageId} ${stream.zoom} ${tileX} ${tileY}`);
    this.schedulePublish();
  }

  failStream(name, message) {
    this.channels.get(name).stream = null;
    this.setStatus(`[${name}] ${message}`, true);
  }

  zoom(direction) {
    if (!this.allReady() || !this.rootInfo || this.rootRequest || this.transitioning || this.dragging || this.panning) return false;
    if (direction !== 1 && direction !== -1) return false;
    const factor = this.view.visualZoom || 1;
    if ((direction > 0 && this.view.zoom === this.selectedImage.maxZoom) || (direction < 0 && factor > 1)) {
      return this.zoomPixels(factor * (direction > 0 ? 2 : 0.5));
    }
    const target = zoomTarget(this.selectedImage, this.view, direction);
    if (!target) return false;
    // Se usa la celda del centro ya renderizado, nunca el objetivo pendiente
    // del mouse. El zoom parte de la cámara fraccional y termina en la matriz.
    this.renderer.panMotion.stop();
    // La copia se toma antes de cambiar la cámara o purgar la caché.
    this.renderer.captureFallback();
    this.pinnedTileKeys = new Set([...this.tileCache]
      .filter(([key, tile]) => tile.zoom === this.view.zoom && this.desiredTileKeys.has(key))
      .map(([key]) => key));
    this.transitionFrom = this.view.zoom;
    this.transitioning = true;
    this.changeView({ ...target, visualZoom: 1 }, true);
    return true;
  }

  zoomPixels(visualZoom) {
    if (visualZoom < 1 || visualZoom > MAX_VISUAL_ZOOM) return false;
    const camera = this.renderer.camera;
    if (!camera) return false;
    const base = this.view.zoom === 0 ? levelVirtualSize(this.selectedImage, 0) : VIEWPORT_PIXELS / 2 ** this.view.zoom;
    const size = base / visualZoom;
    const destination = clampCamera(this.selectedImage, this.view.zoom, {
      x: camera.x + (camera.size - size) / 2,
      y: camera.y + (camera.size - size) / 2, size,
    });
    const target = { ...viewForCamera(this.selectedImage, this.view.zoom, destination), visualZoom };
    this.renderer.panMotion.stop();
    this.renderer.captureFallback();
    this.transitionFrom = this.view.zoom;
    this.transitioning = true;
    // El aumento por sí solo no crea un VIEWPORT. Al reducir cerca del borde,
    // el límite de la imagen puede desplazar el centro a otra celda.
    if (target.currentX !== this.view.currentX || target.currentY !== this.view.currentY) {
      this.changeView(target, false, { keepCamera: true });
    } else this.view = { ...this.view, visualZoom };
    this.renderer.moveTo(this.view, true, destination);
    this.setStatus(`Ampliación visual ${visualZoom}× del nivel ${this.view.zoom}.`);
    return true;
  }

  changeView(target, animate = false, { keepCamera = false } = {}) {
    const previousId = this.view.viewId;
    this.desiredTileKeys = planDesiredTileKeys(this.selectedImage, target.zoom, target.currentX, target.currentY);
    const viewId = this.desiredTileKeys.size ? String(this.nextViewId++) : null;
    this.view = { visualZoom: 1, ...target, viewId };
    // Los desalojos por rotación de niveles se notifican ANTES de VIEWPORT.
    // Salir de la región deseada ya no elimina de inmediato un tile.
    this.tileCache.configure(this.selectedImage, this.view, this.desiredTileKeys);
    if (!keepCamera) this.renderer.moveTo(this.view, animate);
    if (!viewId) {
      if (previousId) this.send(`CANCEL ${previousId}`);
      this.setStatus('Volviendo a la ROOT local…');
    } else {
      this.send(`VIEWPORT ${viewId} ${this.selectedImage.id} ${target.zoom} ${target.currentX} ${target.currentY}`);
      this.setStatus(target.zoom === 0 ? 'ROOT local y precarga del primer nivel…'
        : `Vista ${viewId}: nivel ${target.zoom}, ventana 4 × 4 desde (${target.currentX}, ${target.currentY}).`);
    }
  }

  finishTransition() {
    this.transitioning = false;
    if (!this.error) this.status = (this.view.visualZoom || 1) > 1
      ? `Nivel ${this.view.zoom} · ampliación visual ${this.view.visualZoom}×.`
      : this.view.zoom === 0 ? 'ROOT restaurada desde la copia local.'
        : `Nivel ${this.view.zoom} activo. Los tiles se completan conforme llegan.`;
    this.publish();
  }

  releaseCoveredFallback() {
    if (this.transitioning || (!this.renderer.fallback && this.pinnedTileKeys.size === 0)) return;
    const now = performance.now();
    const visible = this.actualVisibleKeys();
    const covered = this.view.zoom === 0 || visible
      .every(key => this.tileCache.has(key) && now - this.tileCache.get(key).receivedAt >= TILE_FADE_MS);
    if (!covered) return;
    const extras = new Set(visible.filter(key => !this.desiredTileKeys.has(key)));
    if (!this.renderer.fallback && extras.size === this.pinnedTileKeys.size
      && [...extras].every(key => this.pinnedTileKeys.has(key))) return;
    this.renderer.clearFallback();
    // Sólo se retienen extras útiles de una transición, sin ampliar el cupo.
    this.pinnedTileKeys = extras;
    this.publish();
  }

  pan(dx, dy) {
    if (!this.allReady() || !this.rootInfo || this.rootRequest || this.transitioning || this.panning || this.dragging) return false;
    const camera = this.renderer.camera;
    if (!camera) return false;
    const step = TILE_SIZE / 2 ** this.view.zoom;
    const base = this.view.zoom === 0 ? levelVirtualSize(this.selectedImage, 0) : VIEWPORT_PIXELS / 2 ** this.view.zoom;
    const inset = (base - camera.size) / 2;
    const destination = clampCamera(this.selectedImage, this.view.zoom, {
      x: (Math.round((camera.x - inset) / step) + dx) * step + inset,
      y: (Math.round((camera.y - inset) / step) + dy) * step + inset, size: camera.size,
    });
    const target = { ...viewForCamera(this.selectedImage, this.view.zoom, destination), visualZoom: this.view.visualZoom || 1 };
    if (!camera || (Math.abs(destination.x - camera.x) < 1e-8 && Math.abs(destination.y - camera.y) < 1e-8)) return false;
    this.preparePan();
    this.panning = true;
    this.renderer.startPan(target, destination);
    this.publish();
    return true;
  }

  preparePan() {
    this.renderer.panMotion.stop();
    this.renderer.captureFallback();
    // La captura conserva lo visto, sin acumular tiles de todas las vistas.
    this.pinnedTileKeys = new Set(this.actualVisibleKeys().filter(key => !this.desiredTileKeys.has(key)));
  }

  beginDrag() {
    if (!this.allReady() || !this.rootInfo || this.rootRequest || this.transitioning || this.panning || this.dragging
      || !this.renderer.camera || this.renderer.camera.size >= levelVirtualSize(this.selectedImage, 0)) return false;
    this.preparePan();
    this.dragging = true;
    this.renderer.panMotion.startDrag(this.renderer.camera, this.view.zoom, performance.now());
    this.publish();
    return true;
  }

  dragBy(dx, dy, cssWidth, cssHeight = cssWidth) {
    if (!this.dragging || !this.allReady() || ![dx, dy, cssWidth, cssHeight].every(Number.isFinite) || cssWidth <= 0 || cssHeight <= 0) return;
    const camera = this.renderer.camera;
    // Agarrar la imagen: mover el mouse a la derecha mueve la cámara a la
    // izquierda. Se convierten píxeles CSS, no píxeles físicos de pantalla.
    this.renderer.panMotion.dragBy(-dx * camera.size / cssWidth, -dy * camera.size / cssHeight, this.selectedImage, this.view.zoom);
    this.renderer.requestDraw();
  }

  endDrag(cancelled = false) {
    if (!this.dragging) return;
    this.dragging = false;
    this.renderer.panMotion.endDrag(this.renderer.camera, cancelled);
    this.renderer.requestDraw();
    this.publish();
  }

  stopFreePan() {
    this.renderer.panMotion.stop();
    if (this.dragging || this.panning) {
      this.dragging = false;
      this.panning = false;
      this.publish();
    }
  }

  commitPanCamera(nextCamera) {
    if (!this.allReady()) { this.stopFreePan(); return; }
    const camera = clampCamera(this.selectedImage, this.view.zoom, nextCamera);
    const target = { ...viewForCamera(this.selectedImage, this.view.zoom, camera), visualZoom: this.view.visualZoom || 1 };
    const changed = target.currentX !== this.view.currentX || target.currentY !== this.view.currentY;
    // La captura conserva sus coordenadas originales durante todo el gesto.
    // Los tiles todavía visibles se retienen abajo; no se vuelve a muestrear
    // la misma captura en cada cruce, evitando degradación acumulativa.
    this.renderer.camera = camera;
    const desired = changed
      ? planDesiredTileKeys(this.selectedImage, target.zoom, target.currentX, target.currentY)
      : this.desiredTileKeys;
    const visible = cameraTileKeys(this.selectedImage, target.zoom, camera);
    this.pinnedTileKeys = new Set(visible.filter(key => !desired.has(key)));
    if (changed) this.changeView(target, false, { keepCamera: true });
    const signature = visible.join('|');
    if (signature !== this.visualSignature) {
      this.visualSignature = signature;
      this.schedulePublish();
    }
  }

  finishPan() {
    this.panning = false;
    if (!this.error) this.status = `Posición (${this.view.currentX}, ${this.view.currentY}) centrada en la matriz.`;
    this.publish();
  }

  onCacheEviction(key, tile) {
    this.renderer.forget(key);
    if (!this.suppressCacheNotifications) this.send(`TILE_EVICT ${tile.imageId} ${tile.zoom} ${tile.tileX} ${tile.tileY}`);
  }
  clearCache(notify = true) {
    this.suppressCacheNotifications = !notify;
    try { this.tileCache.clear(); }
    finally { this.suppressCacheNotifications = false; }
  }
}
