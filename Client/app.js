const loadFilesButton = document.getElementById("loadFilesButton");
const statusElement = document.getElementById("status");
const channelStatusElement = document.getElementById("channelStatus");
const imageList = document.getElementById("imageList");
const viewerSection = document.getElementById("viewerSection");
const viewerTitle = document.getElementById("viewerTitle");
const rootProgress = document.getElementById("rootProgress");
const rootCanvas = document.getElementById("rootCanvas");
const rootFormatSelect = document.getElementById("rootFormat");
const rootContext = rootCanvas.getContext("2d");

const navigationControls = document.getElementById("navigationControls");
const zoomOutButton = document.getElementById("zoomOutButton");
const zoomInButton = document.getElementById("zoomInButton");
const zoomInfo = document.getElementById("zoomInfo");
const tileProgress = document.getElementById("tileProgress");
const panUpButton = document.getElementById("panUpButton");
const panDownButton = document.getElementById("panDownButton");
const panLeftButton = document.getElementById("panLeftButton");
const panRightButton = document.getElementById("panRightButton");

const TILE_SIZE = 256;
const VIEWPORT_TILES = 4;
const VIEWPORT_PIXELS = TILE_SIZE * VIEWPORT_TILES;
const SERVER_WEBSOCKET_URL = "ws://localhost:8080/ws";
const DATA_CHANNELS = ["CURRENT", "PREVIOUS", "NEXT"];

let nextRequestId = 1;
let nextViewId = 1;
let sessionId = null;
let rootReception = null;
let currentRootButton = null;

let selectedImage = null;
let rootSnapshot = null;
let currentView = {
    zoom: 0,
    currentX: 0,
    currentY: 0,
    viewId: null
};

// La cache conserva RGBA4444, 128 KiB por tile 256x256.
const tileCache = new Map();
let desiredTileKeys = new Set();

const dataConnections = new Map();
for (const channel of DATA_CHANNELS) {
    dataConnections.set(channel, {
        channel,
        socket: null,
        joined: false,
        stream: null
    });
}

// -----------------------------------------------------------------------------
// CUATRO CONEXIONES: CONTROL + CURRENT + PREVIOUS + NEXT
// -----------------------------------------------------------------------------

const controlSocket = new WebSocket(SERVER_WEBSOCKET_URL);
controlSocket.binaryType = "arraybuffer";

controlSocket.addEventListener("open", () => {
    statusElement.textContent = "Conexión CONTROL abierta. Creando sesión...";
    controlSocket.send("SESSION_OPEN");
});

controlSocket.addEventListener("close", () => {
    statusElement.textContent = "La conexión CONTROL con el servidor se cerró.";
    loadFilesButton.disabled = true;
    setRootButtonsDisabled(true);
    disableNavigation();
    closeDataSockets();
    updateChannelStatus();
});

controlSocket.addEventListener("error", () => {
    statusElement.textContent =
        "No se pudo conectar al servidor Java. Verifica el puerto 8080.";
});

controlSocket.addEventListener("message", (event) => {
    if (typeof event.data === "string") {
        handleControlMessage(event.data);
        return;
    }

    if (event.data instanceof ArrayBuffer) {
        handleControlBinary(event.data);
        return;
    }

    console.warn("Tipo de mensaje CONTROL no reconocido:", event.data);
});

function handleControlMessage(message) {
    const lines = message.replace(/\r/g, "").split("\n");
    const header = lines[0].trim().split(/\s+/);
    const command = header[0];

    if (command === "SESSION_OK") {
        if (header.length !== 2) {
            statusElement.textContent = "SESSION_OK inválido.";
            return;
        }
        sessionId = header[1];
        statusElement.textContent = `Sesión ${sessionId} creada. Abriendo 3 canales de datos...`;
        openDataSockets();
        updateChannelStatus();
        return;
    }

    if (command === "ARCHIVOS_OK") {
        handleArchivosOk(header, lines);
        return;
    }
    if (command === "ROOT_START") {
        handleRootStart(header);
        return;
    }
    if (command === "ROOT_DATA") {
        handleRootDataHeader(header);
        return;
    }
    if (command === "ROOT_END") {
        handleRootEnd(header);
        return;
    }
    if (command === "ERROR") {
        handleError(message, header);
        return;
    }

    console.warn("Mensaje CONTROL no reconocido:", message);
}

function openDataSockets() {
    for (const channel of DATA_CHANNELS) {
        const state = dataConnections.get(channel);
        if (state.socket && state.socket.readyState <= WebSocket.OPEN) {
            continue;
        }

        const socket = new WebSocket(SERVER_WEBSOCKET_URL);
        socket.binaryType = "arraybuffer";
        state.socket = socket;
        state.joined = false;
        state.stream = null;

        socket.addEventListener("open", () => {
            socket.send(`SESSION_JOIN ${sessionId} ${channel}`);
            updateChannelStatus();
        });

        socket.addEventListener("message", (event) => {
            handleDataMessage(channel, event.data);
        });

        socket.addEventListener("close", () => {
            if (state.socket === socket) {
                state.joined = false;
                state.stream = null;
            }
            loadFilesButton.disabled = !allConnectionsReady();
            updateChannelStatus();
        });

        socket.addEventListener("error", () => {
            state.joined = false;
            loadFilesButton.disabled = true;
            updateChannelStatus();
        });
    }
}

function closeDataSockets() {
    for (const state of dataConnections.values()) {
        if (state.socket) {
            try {
                state.socket.close();
            } catch (_) {
            }
        }
        state.socket = null;
        state.joined = false;
        state.stream = null;
    }
}

function handleDataMessage(channel, data) {
    const state = dataConnections.get(channel);

    if (typeof data === "string") {
        const header = data.trim().split(/\s+/);
        const command = header[0];

        if (command === "SESSION_JOINED") {
            if (header[1] !== sessionId || header[2] !== channel) {
                console.error(`SESSION_JOINED inválido para ${channel}:`, data);
                return;
            }
            state.joined = true;
            loadFilesButton.disabled = !allConnectionsReady();
            updateChannelStatus();
            if (allConnectionsReady()) {
                statusElement.textContent =
                    "Sesión lista: CONTROL + CURRENT + PREVIOUS + NEXT conectados.";
            }
            return;
        }

        if (command === "TILE_STREAM_START") {
            handleTileStreamStart(channel, header);
            return;
        }

        if (command === "TILE_STREAM_END") {
            handleTileStreamEnd(channel, header);
            return;
        }

        if (command === "ERROR") {
            console.error(`[${channel}] ${data}`);
            statusElement.textContent = data;
            return;
        }

        console.warn(`[${channel}] Mensaje no reconocido:`, data);
        return;
    }

    if (data instanceof ArrayBuffer) {
        handleTileStreamBinary(channel, data);
        return;
    }

    console.warn(`[${channel}] Tipo de mensaje desconocido`, data);
}

function allConnectionsReady() {
    if (!sessionId || controlSocket.readyState !== WebSocket.OPEN) {
        return false;
    }
    return DATA_CHANNELS.every(channel => {
        const state = dataConnections.get(channel);
        return state.joined && state.socket?.readyState === WebSocket.OPEN;
    });
}

function updateChannelStatus() {
    if (!channelStatusElement) {
        return;
    }

    const control = sessionId && controlSocket.readyState === WebSocket.OPEN ? "OK" : "...";
    const pieces = [`CONTROL: ${control}`];
    for (const channel of DATA_CHANNELS) {
        const state = dataConnections.get(channel);
        pieces.push(`${channel}: ${state.joined ? "OK" : "..."}`);
    }
    channelStatusElement.textContent = pieces.join(" | ");
}

// -----------------------------------------------------------------------------
// ARCHIVOS
// -----------------------------------------------------------------------------

loadFilesButton.addEventListener("click", () => {
    if (!ensureControlOpen()) {
        return;
    }

    const requestId = nextRequestId++;
    const message = `ARCHIVOS ${requestId}`;
    controlSocket.send(message);
    statusElement.textContent = `Enviado: ${message}`;
});

function handleArchivosOk(header, lines) {
    const requestId = header[1];
    const expectedCount = Number(header[2]);
    const images = lines
        .slice(1)
        .filter(line => line.trim() !== "")
        .map(parseImageLine);

    statusElement.textContent =
        `Respuesta ${requestId}: ${images.length} imagen(es) disponible(s).`;

    if (images.length !== expectedCount) {
        console.warn(
            `El servidor indicó ${expectedCount} imágenes, pero se recibieron ${images.length}.`
        );
    }

    renderImages(images);
}

// -----------------------------------------------------------------------------
// ROOT: sigue viajando por CONTROL
// -----------------------------------------------------------------------------

function handleRootStart(header) {
    if (header.length !== 8) {
        failRoot("ROOT_START inválido");
        return;
    }

    const [, requestId, imageId, widthText, heightText, format, chunkSizeText, chunkCountText] = header;
    const width = Number(widthText);
    const height = Number(heightText);
    const chunkSize = Number(chunkSizeText);
    const chunkCount = Number(chunkCountText);
    const bytesPerPixel = bytesPerPixelForFormat(format);

    if (bytesPerPixel === null
        || !Number.isInteger(width) || !Number.isInteger(height)
        || !Number.isInteger(chunkSize) || !Number.isInteger(chunkCount)
        || width <= 0 || height <= 0 || chunkSize <= 0 || chunkCount <= 0) {
        failRoot("Metadata inválida en ROOT_START");
        return;
    }

    rootReception = {
        requestId,
        imageId,
        width,
        height,
        format,
        chunkSize,
        chunkCount,
        buffer: new Uint8Array(width * height * bytesPerPixel),
        receivedChunks: new Set(),
        awaitingChunk: null
    };

    rootCanvas.width = width;
    rootCanvas.height = height;
    viewerSection.hidden = false;
    viewerTitle.textContent = `ROOT - ${imageId}`;
    rootProgress.textContent = `Recibiendo ROOT: 0/${chunkCount} chunks`;
}

function handleRootDataHeader(header) {
    if (!rootReception) {
        console.warn("Llegó ROOT_DATA sin ROOT_START previo.");
        return;
    }

    const [, requestId, chunkIndexText, dataLengthText] = header;
    const chunkIndex = Number(chunkIndexText);
    const dataLength = Number(dataLengthText);

    if (requestId !== rootReception.requestId) {
        failRoot(`ROOT_DATA pertenece a otra solicitud: ${requestId}`);
        return;
    }

    if (!Number.isInteger(chunkIndex) || chunkIndex < 0
        || chunkIndex >= rootReception.chunkCount
        || !Number.isInteger(dataLength) || dataLength <= 0
        || dataLength > rootReception.chunkSize) {
        failRoot("Cabecera ROOT_DATA inválida");
        return;
    }

    if (rootReception.awaitingChunk !== null) {
        failRoot("Llegó otro ROOT_DATA antes de recibir el binario anterior");
        return;
    }

    rootReception.awaitingChunk = { chunkIndex, dataLength };
}

function handleControlBinary(arrayBuffer) {
    if (!rootReception || !rootReception.awaitingChunk) {
        console.warn("Llegó binario por CONTROL sin ROOT_DATA pendiente.");
        return;
    }

    const { chunkIndex, dataLength } = rootReception.awaitingChunk;
    const chunk = new Uint8Array(arrayBuffer);

    if (chunk.byteLength !== dataLength) {
        failRoot(
            `Chunk ROOT ${chunkIndex}: se esperaban ${dataLength} bytes y llegaron ${chunk.byteLength}`
        );
        return;
    }

    const destinationOffset = chunkIndex * rootReception.chunkSize;
    if (destinationOffset + dataLength > rootReception.buffer.length) {
        failRoot(`Chunk ROOT ${chunkIndex} excede el tamaño esperado`);
        return;
    }

    rootReception.buffer.set(chunk, destinationOffset);
    rootReception.receivedChunks.add(chunkIndex);
    rootReception.awaitingChunk = null;

    rootProgress.textContent =
        `Recibiendo ROOT: ${rootReception.receivedChunks.size}/${rootReception.chunkCount} chunks`;
}

function handleRootEnd(header) {
    const requestId = header[1];

    if (!rootReception || requestId !== rootReception.requestId) {
        console.warn("ROOT_END no corresponde a la recepción actual.");
        return;
    }

    if (rootReception.awaitingChunk !== null
        || rootReception.receivedChunks.size !== rootReception.chunkCount) {
        failRoot(
            `ROOT incompleto: ${rootReception.receivedChunks.size}/${rootReception.chunkCount} chunks`
        );
        return;
    }

    rootSnapshot = {
        imageId: rootReception.imageId,
        width: rootReception.width,
        height: rootReception.height,
        format: rootReception.format,
        buffer: rootReception.buffer
    };

    showRootSnapshot();

    rootProgress.textContent =
        `ROOT completa: ${rootReception.width}×${rootReception.height}, ${rootReception.format}`;
    statusElement.textContent =
        `ROOT ${rootReception.imageId} reconstruida. Ya puedes comenzar a hacer zoom.`;

    rootReception = null;
    setRootButtonsDisabled(false);
    currentRootButton = null;
    navigationControls.hidden = false;
    updateNavigationControls();
}

function requestRoot(image, button) {
    if (!ensureControlOpen()) {
        return;
    }
    if (rootReception !== null) {
        statusElement.textContent = "Ya hay una ROOT en proceso de recepción.";
        return;
    }

    clearTileCache(false);
    desiredTileKeys = new Set();
    clearDataStreamStates();
    rootSnapshot = null;
    selectedImage = image;
    currentView = { zoom: 0, currentX: 0, currentY: 0, viewId: null };

    const requestId = String(nextRequestId++);
    const format = rootFormatSelect.value;
    const message = `ROOT ${requestId} ${image.id} ${format}`;

    currentRootButton = button;
    setRootButtonsDisabled(true);
    viewerSection.hidden = false;
    navigationControls.hidden = true;
    viewerTitle.textContent = `ROOT - ${image.name}`;
    rootProgress.textContent = "Esperando ROOT_START...";
    clearCanvas();

    controlSocket.send(message);
    statusElement.textContent = `Enviado: ${message}`;
}

function showRootSnapshot() {
    if (!rootSnapshot || !selectedImage) {
        return;
    }

    rootCanvas.width = rootSnapshot.width;
    rootCanvas.height = rootSnapshot.height;
    clearCanvas();

    const imageData = decodePixelBuffer(
        rootSnapshot.buffer,
        rootSnapshot.width,
        rootSnapshot.height,
        rootSnapshot.format
    );
    rootContext.putImageData(imageData, 0, 0);

    currentView = { zoom: 0, currentX: 0, currentY: 0, viewId: null };
    viewerTitle.textContent = `ROOT - ${selectedImage.name}`;
    updateNavigationControls();
}

// -----------------------------------------------------------------------------
// STREAMS DE TILES: 3 conexiones paralelas
// -----------------------------------------------------------------------------

function handleTileStreamStart(channel, header) {
    const state = dataConnections.get(channel);

    if (header.length < 10) {
        failDataStream(channel, "TILE_STREAM_START inválido");
        return;
    }

    const [, streamId, viewId, imageId, channelInMessage,
        zoomText, format, tileSizeText, tileBytesText, countText, ...coords] = header;

    const zoom = Number(zoomText);
    const tileSize = Number(tileSizeText);
    const tileBytes = Number(tileBytesText);
    const count = Number(countText);
    const bytesPerPixel = bytesPerPixelForFormat(format);

    if (channelInMessage !== channel
        || bytesPerPixel === null
        || !Number.isInteger(zoom) || zoom < 1
        || !Number.isInteger(tileSize) || tileSize <= 0
        || !Number.isInteger(tileBytes) || tileBytes <= 0
        || !Number.isInteger(count) || count < 0
        || coords.length !== count
        || tileBytes !== tileSize * tileSize * bytesPerPixel) {
        failDataStream(channel, "Metadata inválida en TILE_STREAM_START");
        return;
    }

    const tiles = [];
    for (const coordinate of coords) {
        const [xText, yText] = coordinate.split(",");
        const tileX = Number(xText);
        const tileY = Number(yText);
        if (!Number.isInteger(tileX) || !Number.isInteger(tileY)
            || tileX < 0 || tileY < 0) {
            failDataStream(channel, `Coordenada inválida: ${coordinate}`);
            return;
        }
        tiles.push({ tileX, tileY });
    }

    state.stream = {
        streamId,
        viewId,
        imageId,
        channel,
        zoom,
        format,
        tileSize,
        tileBytes,
        plannedCount: count,
        tiles,
        receivedCount: 0
    };

    updateTileProgress();
}

function handleTileStreamBinary(channel, arrayBuffer) {
    const state = dataConnections.get(channel);
    const stream = state.stream;

    if (!stream) {
        console.warn(`[${channel}] Binario recibido sin TILE_STREAM_START.`);
        return;
    }

    const index = stream.receivedCount;
    if (index >= stream.tiles.length) {
        failDataStream(channel, "Llegaron más tiles binarios que los anunciados");
        return;
    }

    if (arrayBuffer.byteLength !== stream.tileBytes) {
        failDataStream(
            channel,
            `Tile ${index}: se esperaban ${stream.tileBytes} bytes y llegaron ${arrayBuffer.byteLength}`
        );
        return;
    }

    const descriptor = stream.tiles[index];
    const tile = {
        imageId: stream.imageId,
        zoom: stream.zoom,
        tileX: descriptor.tileX,
        tileY: descriptor.tileY,
        width: stream.tileSize,
        height: stream.tileSize,
        format: stream.format,
        buffer: new Uint8Array(arrayBuffer)
    };

    stream.receivedCount++;

    // ACK individual, pero por la conexión CONTROL.
    if (ensureControlOpen(false)) {
        controlSocket.send(
            `TILE_ACK ${tile.imageId} ${tile.zoom} ${tile.tileX} ${tile.tileY}`
        );
    }

    const key = tileKey(tile.imageId, tile.zoom, tile.tileX, tile.tileY);
    const stillUseful = selectedImage
        && tile.imageId === selectedImage.id
        && desiredTileKeys.has(key);

    if (stillUseful) {
        tileCache.set(key, tile);
        drawTileIfVisible(tile);
    } else if (ensureControlOpen(false)) {
        // Se confirmó que llegó, pero la vista ya cambió y no se conservará.
        controlSocket.send(
            `TILE_EVICT ${tile.imageId} ${tile.zoom} ${tile.tileX} ${tile.tileY}`
        );
    }

    updateTileProgress();
}

function handleTileStreamEnd(channel, header) {
    const state = dataConnections.get(channel);
    const stream = state.stream;

    if (!stream) {
        console.warn(`[${channel}] TILE_STREAM_END sin stream activo.`);
        return;
    }

    const [, streamId, sentCountText] = header;
    const sentCount = Number(sentCountText);

    if (streamId !== stream.streamId
        || !Number.isInteger(sentCount)
        || sentCount < 0
        || sentCount > stream.plannedCount) {
        failDataStream(channel, "TILE_STREAM_END inválido");
        return;
    }

    if (stream.receivedCount !== sentCount) {
        console.warn(
            `[${channel}] Stream ${streamId}: END dice ${sentCount}, ` +
            `pero el navegador recibió ${stream.receivedCount}.`
        );
    }

    console.log(
        `[${channel}] stream ${streamId} finalizado: ` +
        `${stream.receivedCount}/${stream.plannedCount} tiles recibidos.`
    );

    state.stream = null;
    updateTileProgress();
}

function failDataStream(channel, message) {
    console.error(`[${channel}] ${message}`);
    const state = dataConnections.get(channel);
    state.stream = null;
    statusElement.textContent = `[${channel}] ${message}`;
    updateTileProgress();
}

function clearDataStreamStates() {
    for (const state of dataConnections.values()) {
        state.stream = null;
    }
}

// -----------------------------------------------------------------------------
// VIEWPORT / ZOOM / CACHE
// -----------------------------------------------------------------------------

zoomInButton.addEventListener("click", zoomIn);
zoomOutButton.addEventListener("click", zoomOut);
panUpButton.addEventListener("click", () => panBy(0, -1));
panDownButton.addEventListener("click", () => panBy(0, 1));
panLeftButton.addEventListener("click", () => panBy(-1, 0));
panRightButton.addEventListener("click", () => panBy(1, 0));

function requestViewport(zoom, currentX, currentY) {
    if (!selectedImage || !rootSnapshot || !ensureControlOpen()) {
        return;
    }

    const tiles = tilesPerAxis(selectedImage, zoom);
    const maxStart = tiles - VIEWPORT_TILES;
    if (zoom < 1 || zoom > selectedImage.maxZoom || maxStart < 0) {
        statusElement.textContent = `No se puede abrir el nivel ${zoom}.`;
        return;
    }

    currentX = clamp(currentX, 0, maxStart);
    currentY = clamp(currentY, 0, maxStart);

    const viewId = String(nextViewId++);
    currentView = { zoom, currentX, currentY, viewId };

    desiredTileKeys = planDesiredTileKeys(selectedImage, zoom, currentX, currentY);
    evictTilesOutsideDesiredSet();

    rootCanvas.width = VIEWPORT_PIXELS;
    rootCanvas.height = VIEWPORT_PIXELS;
    clearCanvas();
    drawCurrentViewportFromCache();

    const message = `VIEWPORT ${viewId} ${selectedImage.id} ${zoom} ${currentX} ${currentY}`;
    controlSocket.send(message);

    viewerTitle.textContent = `${selectedImage.name} - nivel ${zoom}`;
    statusElement.textContent = `Enviado: ${message}`;
    rootProgress.textContent =
        `Vista ${viewId}: nivel ${zoom}, ventana 4×4 desde tile (${currentX}, ${currentY}).`;

    updateNavigationControls();
    updateTileProgress();
}

function zoomIn() {
    if (!selectedImage || !rootSnapshot || currentView.zoom >= selectedImage.maxZoom) {
        return;
    }

    if (currentView.zoom === 0) {
        const targetZoom = 1;
        const tiles = tilesPerAxis(selectedImage, targetZoom);
        const start = Math.max(0, Math.floor((tiles - VIEWPORT_TILES) / 2));
        requestViewport(targetZoom, start, start);
        return;
    }

    const targetZoom = currentView.zoom + 1;
    const targetTiles = tilesPerAxis(selectedImage, targetZoom);
    const maxStart = targetTiles - VIEWPORT_TILES;

    const nextX = clamp(2 * (currentView.currentX + 1), 0, maxStart);
    const nextY = clamp(2 * (currentView.currentY + 1), 0, maxStart);
    requestViewport(targetZoom, nextX, nextY);
}

function zoomOut() {
    if (!selectedImage || currentView.zoom <= 0) {
        return;
    }

    if (currentView.zoom === 1) {
        const oldViewId = currentView.viewId;
        if (oldViewId && ensureControlOpen(false)) {
            controlSocket.send(`CANCEL ${oldViewId}`);
        }

        desiredTileKeys = new Set();
        clearTileCache(true);
        showRootSnapshot();
        rootProgress.textContent = "Vista ROOT restaurada desde la copia local.";
        statusElement.textContent = "Regresaste a ROOT; no fue necesario retransmitirla.";
        return;
    }

    const targetZoom = currentView.zoom - 1;
    const previousTiles = tilesPerAxis(selectedImage, targetZoom);
    const maxStart = previousTiles - VIEWPORT_TILES;

    const centerX = currentView.currentX * TILE_SIZE + VIEWPORT_PIXELS / 2;
    const centerY = currentView.currentY * TILE_SIZE + VIEWPORT_PIXELS / 2;
    const previousCenterX = centerX / 2;
    const previousCenterY = centerY / 2;

    const previousX = clamp(
        Math.floor(previousCenterX / TILE_SIZE) - 2,
        0,
        maxStart
    );
    const previousY = clamp(
        Math.floor(previousCenterY / TILE_SIZE) - 2,
        0,
        maxStart
    );

    requestViewport(targetZoom, previousX, previousY);
}

function panBy(deltaX, deltaY) {
    if (!selectedImage || currentView.zoom < 1) {
        return;
    }

    const tiles = tilesPerAxis(selectedImage, currentView.zoom);
    const maxStart = tiles - VIEWPORT_TILES;
    const nextX = clamp(currentView.currentX + deltaX, 0, maxStart);
    const nextY = clamp(currentView.currentY + deltaY, 0, maxStart);

    if (nextX === currentView.currentX && nextY === currentView.currentY) {
        return;
    }

    requestViewport(currentView.zoom, nextX, nextY);
}

function planDesiredTileKeys(image, zoom, currentX, currentY) {
    const desired = new Set();
    const currentTiles = tilesPerAxis(image, zoom);

    const add = (z, x, y, tilesAtLevel) => {
        if (x < 0 || y < 0 || x >= tilesAtLevel || y >= tilesAtLevel) {
            return;
        }
        desired.add(tileKey(image.id, z, x, y));
    };

    // A: 16 actuales.
    for (let y = currentY; y < currentY + VIEWPORT_TILES; y++) {
        for (let x = currentX; x < currentX + VIEWPORT_TILES; x++) {
            add(zoom, x, y, currentTiles);
        }
    }

    // B: hasta 16 vecinos del mismo nivel.
    for (let x = currentX; x < currentX + VIEWPORT_TILES; x++) {
        add(zoom, x, currentY - 1, currentTiles);
        add(zoom, x, currentY + VIEWPORT_TILES, currentTiles);
    }
    for (let y = currentY; y < currentY + VIEWPORT_TILES; y++) {
        add(zoom, currentX - 1, y, currentTiles);
        add(zoom, currentX + VIEWPORT_TILES, y, currentTiles);
    }

    // D: 16 del nivel siguiente.
    if (zoom < image.maxZoom) {
        const nextTiles = tilesPerAxis(image, zoom + 1);
        const nextX = 2 * (currentX + 1);
        const nextY = 2 * (currentY + 1);

        for (let y = nextY; y < nextY + VIEWPORT_TILES; y++) {
            for (let x = nextX; x < nextX + VIEWPORT_TILES; x++) {
                add(zoom + 1, x, y, nextTiles);
            }
        }
    }

    // C: 16 co-centrados del nivel anterior. z=1 usa ROOT.
    if (zoom > 1) {
        const previousTiles = tilesPerAxis(image, zoom - 1);
        const centerX = currentX * TILE_SIZE + VIEWPORT_PIXELS / 2;
        const centerY = currentY * TILE_SIZE + VIEWPORT_PIXELS / 2;
        const previousX = clamp(
            Math.floor((centerX / 2) / TILE_SIZE) - 2,
            0,
            Math.max(0, previousTiles - VIEWPORT_TILES)
        );
        const previousY = clamp(
            Math.floor((centerY / 2) / TILE_SIZE) - 2,
            0,
            Math.max(0, previousTiles - VIEWPORT_TILES)
        );

        for (let y = previousY; y < previousY + VIEWPORT_TILES; y++) {
            for (let x = previousX; x < previousX + VIEWPORT_TILES; x++) {
                add(zoom - 1, x, y, previousTiles);
            }
        }
    }

    return desired;
}

function evictTilesOutsideDesiredSet() {
    for (const [key, tile] of tileCache.entries()) {
        if (desiredTileKeys.has(key)) {
            continue;
        }

        tileCache.delete(key);
        if (ensureControlOpen(false)) {
            controlSocket.send(
                `TILE_EVICT ${tile.imageId} ${tile.zoom} ${tile.tileX} ${tile.tileY}`
            );
        }
    }
}

function clearTileCache(notifyServer) {
    if (notifyServer && ensureControlOpen(false)) {
        for (const tile of tileCache.values()) {
            controlSocket.send(
                `TILE_EVICT ${tile.imageId} ${tile.zoom} ${tile.tileX} ${tile.tileY}`
            );
        }
    }
    tileCache.clear();
}

function drawCurrentViewportFromCache() {
    if (currentView.zoom < 1 || !selectedImage) {
        return;
    }

    for (let row = 0; row < VIEWPORT_TILES; row++) {
        for (let column = 0; column < VIEWPORT_TILES; column++) {
            const tileX = currentView.currentX + column;
            const tileY = currentView.currentY + row;
            const key = tileKey(selectedImage.id, currentView.zoom, tileX, tileY);
            const tile = tileCache.get(key);
            if (tile) {
                drawTileAt(tile, column * TILE_SIZE, row * TILE_SIZE);
            }
        }
    }
}

function drawTileIfVisible(tile) {
    if (!selectedImage
        || currentView.zoom !== tile.zoom
        || selectedImage.id !== tile.imageId) {
        return;
    }

    const column = tile.tileX - currentView.currentX;
    const row = tile.tileY - currentView.currentY;
    if (column < 0 || column >= VIEWPORT_TILES
        || row < 0 || row >= VIEWPORT_TILES) {
        return;
    }

    drawTileAt(tile, column * TILE_SIZE, row * TILE_SIZE);
}

function drawTileAt(tile, destinationX, destinationY) {
    const imageData = decodePixelBuffer(
        tile.buffer,
        tile.width,
        tile.height,
        tile.format
    );
    rootContext.putImageData(imageData, destinationX, destinationY);
}

// -----------------------------------------------------------------------------
// FORMATOS DE PÍXEL
// -----------------------------------------------------------------------------

function bytesPerPixelForFormat(format) {
    if (format === "RGBA8888") {
        return 4;
    }
    if (format === "RGBA4444") {
        return 2;
    }
    return null;
}

function decodePixelBuffer(buffer, width, height, format) {
    if (format === "RGBA8888") {
        const expectedLength = width * height * 4;
        if (buffer.length !== expectedLength) {
            throw new Error(
                `RGBA8888 inválido: se esperaban ${expectedLength} bytes y hay ${buffer.length}`
            );
        }
        return new ImageData(new Uint8ClampedArray(buffer), width, height);
    }

    if (format === "RGBA4444") {
        const expectedLength = width * height * 2;
        if (buffer.length !== expectedLength) {
            throw new Error(
                `RGBA4444 inválido: se esperaban ${expectedLength} bytes y hay ${buffer.length}`
            );
        }

        const rgba8888 = new Uint8ClampedArray(width * height * 4);
        for (let pixel = 0; pixel < width * height; pixel++) {
            const source = pixel * 2;
            const destination = pixel * 4;
            const high = buffer[source];
            const low = buffer[source + 1];

            const r4 = high >>> 4;
            const g4 = high & 0x0F;
            const b4 = low >>> 4;
            const a4 = low & 0x0F;

            rgba8888[destination] = r4 * 17;
            rgba8888[destination + 1] = g4 * 17;
            rgba8888[destination + 2] = b4 * 17;
            rgba8888[destination + 3] = a4 * 17;
        }
        return new ImageData(rgba8888, width, height);
    }

    throw new Error(`Formato no soportado al dibujar: ${format}`);
}

// -----------------------------------------------------------------------------
// UI / UTILIDADES
// -----------------------------------------------------------------------------

function parseImageLine(line) {
    const [id, name, width, height, virtualSize, maxZoom] = line.split("|");
    return {
        id,
        name,
        width: Number(width),
        height: Number(height),
        virtualSize: Number(virtualSize),
        maxZoom: Number(maxZoom)
    };
}

function renderImages(images) {
    imageList.innerHTML = "";

    if (images.length === 0) {
        imageList.innerHTML = '<p class="empty">No hay imágenes disponibles.</p>';
        return;
    }

    for (const image of images) {
        const card = document.createElement("article");
        card.className = "image-card";

        const title = document.createElement("h3");
        title.textContent = image.name;

        const details = document.createElement("p");
        details.textContent =
            `ID: ${image.id} | ${image.width}×${image.height} | ` +
            `Virtual: ${image.virtualSize}×${image.virtualSize} | ` +
            `Zoom máx.: ${image.maxZoom}`;

        const button = document.createElement("button");
        button.className = "root-button";
        button.textContent = "Cargar ROOT";
        button.addEventListener("click", () => requestRoot(image, button));

        card.append(title, details, button);
        imageList.appendChild(card);
    }
}

function levelVirtualSize(image, zoom) {
    if (!Number.isInteger(zoom) || zoom < 0 || zoom > image.maxZoom) {
        throw new Error(`Zoom inválido: ${zoom}`);
    }

    const divisor = 2 ** (image.maxZoom - zoom);
    const value = image.virtualSize / divisor;
    if (!Number.isInteger(value)) {
        throw new Error(
            `No se puede derivar virtualSize del nivel ${zoom} desde ARCHIVOS`
        );
    }
    return value;
}

function tilesPerAxis(image, zoom) {
    const virtualSize = levelVirtualSize(image, zoom);
    if (virtualSize % TILE_SIZE !== 0) {
        throw new Error(
            `virtualSize ${virtualSize} del nivel ${zoom} no es divisible entre ${TILE_SIZE}`
        );
    }
    return virtualSize / TILE_SIZE;
}

function tileKey(imageId, zoom, tileX, tileY) {
    return `${imageId}:${zoom}:${tileX}:${tileY}`;
}

function updateNavigationControls() {
    if (!selectedImage || !rootSnapshot) {
        disableNavigation();
        return;
    }

    navigationControls.hidden = false;
    zoomOutButton.disabled = currentView.zoom === 0;
    zoomInButton.disabled = currentView.zoom >= selectedImage.maxZoom;

    const canPan = currentView.zoom >= 1;
    if (!canPan) {
        panUpButton.disabled = true;
        panDownButton.disabled = true;
        panLeftButton.disabled = true;
        panRightButton.disabled = true;
        zoomInfo.textContent = `ROOT (z=0) | zoom máximo: ${selectedImage.maxZoom}`;
        updateTileProgress();
        return;
    }

    const tiles = tilesPerAxis(selectedImage, currentView.zoom);
    const maxStart = tiles - VIEWPORT_TILES;
    panLeftButton.disabled = currentView.currentX <= 0;
    panRightButton.disabled = currentView.currentX >= maxStart;
    panUpButton.disabled = currentView.currentY <= 0;
    panDownButton.disabled = currentView.currentY >= maxStart;

    zoomInfo.textContent =
        `Nivel ${currentView.zoom}/${selectedImage.maxZoom} | ` +
        `viewport (${currentView.currentX}, ${currentView.currentY}) | ` +
        `${tiles}×${tiles} tiles`;
}

function updateTileProgress() {
    if (!selectedImage || currentView.zoom === 0) {
        tileProgress.textContent = `ROOT local. Cache de tiles: ${tileCache.size}.`;
        return;
    }

    let visibleReady = 0;
    for (let row = 0; row < VIEWPORT_TILES; row++) {
        for (let column = 0; column < VIEWPORT_TILES; column++) {
            const key = tileKey(
                selectedImage.id,
                currentView.zoom,
                currentView.currentX + column,
                currentView.currentY + row
            );
            if (tileCache.has(key)) {
                visibleReady++;
            }
        }
    }

    let desiredReady = 0;
    for (const key of desiredTileKeys) {
        if (tileCache.has(key)) {
            desiredReady++;
        }
    }

    const streams = DATA_CHANNELS.map(channel => {
        const stream = dataConnections.get(channel).stream;
        return stream
            ? `${channel}:${stream.receivedCount}/${stream.plannedCount}`
            : `${channel}:-`;
    }).join(" | ");

    tileProgress.textContent =
        `Visibles: ${visibleReady}/16 | ` +
        `cache deseada: ${desiredReady}/${desiredTileKeys.size} | ` +
        `tiles almacenados: ${tileCache.size} | ${streams}`;
}

function disableNavigation() {
    navigationControls.hidden = true;
    zoomOutButton.disabled = true;
    zoomInButton.disabled = true;
    panUpButton.disabled = true;
    panDownButton.disabled = true;
    panLeftButton.disabled = true;
    panRightButton.disabled = true;
}

function ensureControlOpen(showMessage = true) {
    if (controlSocket.readyState !== WebSocket.OPEN || !sessionId) {
        if (showMessage) {
            statusElement.textContent = "La conexión CONTROL todavía no está lista.";
        }
        return false;
    }
    return true;
}

function setRootButtonsDisabled(disabled) {
    document.querySelectorAll(".root-button").forEach(button => {
        button.disabled = disabled;
    });
}

function clearCanvas() {
    rootContext.clearRect(0, 0, rootCanvas.width, rootCanvas.height);
}

function failRoot(message) {
    console.error(message);
    statusElement.textContent = message;
    rootProgress.textContent = "Error durante la recepción de ROOT.";
    rootReception = null;
    setRootButtonsDisabled(false);
    currentRootButton = null;
}

function handleError(message, header) {
    statusElement.textContent = message;

    if (rootReception && header[1] === rootReception.requestId) {
        rootReception = null;
        setRootButtonsDisabled(false);
        currentRootButton = null;
    }
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

updateChannelStatus();
