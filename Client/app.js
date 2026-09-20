const loadFilesButton = document.getElementById("loadFilesButton");
const statusElement = document.getElementById("status");
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

let nextRequestId = 1;
let nextViewId = 1;
let rootReception = null;
let tileReception = null;
let currentRootButton = null;

let selectedImage = null;
let rootSnapshot = null;
let currentView = {
    zoom: 0,
    currentX: 0,
    currentY: 0,
    viewId: null
};

// La cache guarda los bytes del protocolo (RGBA4444), no ImageData expandido.
// Así 64 tiles ocupan ~8 MiB en lugar de ~16 MiB.
const tileCache = new Map();
let desiredTileKeys = new Set();

const SERVER_WEBSOCKET_URL = "ws://localhost:8080/ws";
const socket = new WebSocket(SERVER_WEBSOCKET_URL);
socket.binaryType = "arraybuffer";

socket.addEventListener("open", () => {
    statusElement.textContent = `Conectado a ${SERVER_WEBSOCKET_URL}`;
    loadFilesButton.disabled = false;
});

socket.addEventListener("close", () => {
    statusElement.textContent = "La conexión con el servidor Java se cerró.";
    loadFilesButton.disabled = true;
    setRootButtonsDisabled(true);
    disableNavigation();
});

socket.addEventListener("error", () => {
    statusElement.textContent =
        "No se pudo conectar al servidor Java. Verifica que esté ejecutándose en el puerto 8080.";
});

socket.addEventListener("message", (event) => {
    if (typeof event.data === "string") {
        handleProtocolMessage(event.data);
        return;
    }

    if (event.data instanceof ArrayBuffer) {
        handleBinaryMessage(event.data);
        return;
    }

    console.warn("Tipo de mensaje WebSocket no reconocido:", event.data);
});

loadFilesButton.addEventListener("click", () => {
    if (!ensureSocketOpen()) {
        return;
    }

    const requestId = nextRequestId++;
    const message = `ARCHIVOS ${requestId}`;
    socket.send(message);
    statusElement.textContent = `Enviado: ${message}`;
});

zoomInButton.addEventListener("click", zoomIn);
zoomOutButton.addEventListener("click", zoomOut);
panUpButton.addEventListener("click", () => panBy(0, -1));
panDownButton.addEventListener("click", () => panBy(0, 1));
panLeftButton.addEventListener("click", () => panBy(-1, 0));
panRightButton.addEventListener("click", () => panBy(1, 0));

function handleProtocolMessage(message) {
    const lines = message.replace(/\r/g, "").split("\n");
    const header = lines[0].trim().split(/\s+/);
    const command = header[0];

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
    if (command === "TILE_START") {
        handleTileStart(header);
        return;
    }
    if (command === "TILE_DATA") {
        handleTileDataHeader(header);
        return;
    }
    if (command === "TILE_END") {
        handleTileEnd(header);
        return;
    }
    if (command === "ERROR") {
        handleError(message, header);
        return;
    }

    console.warn("Mensaje del protocolo no reconocido:", message);
}

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
// ROOT
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
    if (bytesPerPixel === null) {
        failRoot(`Formato ROOT no soportado: ${format}`);
        return;
    }

    if (!Number.isInteger(width) || !Number.isInteger(height)
        || !Number.isInteger(chunkSize) || !Number.isInteger(chunkCount)
        || width <= 0 || height <= 0 || chunkSize <= 0 || chunkCount <= 0) {
        failRoot("Metadata inválida en ROOT_START");
        return;
    }

    const totalBytes = width * height * bytesPerPixel;
    rootReception = {
        requestId,
        imageId,
        width,
        height,
        format,
        chunkSize,
        chunkCount,
        buffer: new Uint8Array(totalBytes),
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

function handleRootBinary(arrayBuffer) {
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

    if (rootReception.awaitingChunk !== null) {
        failRoot("ROOT_END llegó antes del binario del último chunk");
        return;
    }

    if (rootReception.receivedChunks.size !== rootReception.chunkCount) {
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
    if (!ensureSocketOpen()) {
        return;
    }
    if (rootReception !== null) {
        statusElement.textContent = "Ya hay una ROOT en proceso de recepción.";
        return;
    }

    // ROOT abre/reinicia una imagen. El servidor también cancela su estado de tiles.
    clearTileCache(false);
    desiredTileKeys = new Set();
    tileReception = null;
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

    socket.send(message);
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
// TILES / VIEWPORT
// -----------------------------------------------------------------------------

function handleTileStart(header) {
    if (header.length !== 12) {
        failTile("TILE_START inválido");
        return;
    }

    if (tileReception !== null) {
        failTile("Llegó TILE_START mientras otro tile seguía en recepción");
        return;
    }

    const [,
        tileRequestId,
        viewId,
        imageId,
        zoomText,
        tileXText,
        tileYText,
        widthText,
        heightText,
        format,
        chunkSizeText,
        chunkCountText
    ] = header;

    const zoom = Number(zoomText);
    const tileX = Number(tileXText);
    const tileY = Number(tileYText);
    const width = Number(widthText);
    const height = Number(heightText);
    const chunkSize = Number(chunkSizeText);
    const chunkCount = Number(chunkCountText);
    const bytesPerPixel = bytesPerPixelForFormat(format);

    if (bytesPerPixel === null
        || !Number.isInteger(zoom) || !Number.isInteger(tileX) || !Number.isInteger(tileY)
        || !Number.isInteger(width) || !Number.isInteger(height)
        || !Number.isInteger(chunkSize) || !Number.isInteger(chunkCount)
        || zoom < 1 || tileX < 0 || tileY < 0
        || width <= 0 || height <= 0 || chunkSize <= 0 || chunkCount <= 0) {
        failTile("Metadata inválida en TILE_START");
        return;
    }

    tileReception = {
        tileRequestId,
        viewId,
        imageId,
        zoom,
        tileX,
        tileY,
        width,
        height,
        format,
        chunkSize,
        chunkCount,
        buffer: new Uint8Array(width * height * bytesPerPixel),
        receivedChunks: new Set(),
        awaitingChunk: null
    };
}

function handleTileDataHeader(header) {
    if (!tileReception) {
        console.warn("Llegó TILE_DATA sin TILE_START previo.");
        return;
    }

    const [, tileRequestId, chunkIndexText, dataLengthText] = header;
    const chunkIndex = Number(chunkIndexText);
    const dataLength = Number(dataLengthText);

    if (tileRequestId !== tileReception.tileRequestId) {
        failTile(`TILE_DATA pertenece a otra solicitud: ${tileRequestId}`);
        return;
    }

    if (!Number.isInteger(chunkIndex) || chunkIndex < 0
        || chunkIndex >= tileReception.chunkCount
        || !Number.isInteger(dataLength) || dataLength <= 0
        || dataLength > tileReception.chunkSize) {
        failTile("Cabecera TILE_DATA inválida");
        return;
    }

    if (tileReception.awaitingChunk !== null) {
        failTile("Llegó otro TILE_DATA antes del binario anterior");
        return;
    }

    tileReception.awaitingChunk = { chunkIndex, dataLength };
}

function handleTileBinary(arrayBuffer) {
    const { chunkIndex, dataLength } = tileReception.awaitingChunk;
    const chunk = new Uint8Array(arrayBuffer);

    if (chunk.byteLength !== dataLength) {
        failTile(
            `Tile ${tileReception.tileRequestId}, chunk ${chunkIndex}: ` +
            `se esperaban ${dataLength} bytes y llegaron ${chunk.byteLength}`
        );
        return;
    }

    const destinationOffset = chunkIndex * tileReception.chunkSize;
    if (destinationOffset + dataLength > tileReception.buffer.length) {
        failTile(`Chunk ${chunkIndex} excede el tamaño del tile`);
        return;
    }

    tileReception.buffer.set(chunk, destinationOffset);
    tileReception.receivedChunks.add(chunkIndex);
    tileReception.awaitingChunk = null;
}

function handleTileEnd(header) {
    const tileRequestId = header[1];

    if (!tileReception || tileRequestId !== tileReception.tileRequestId) {
        console.warn("TILE_END no corresponde al tile actual.");
        return;
    }

    if (tileReception.awaitingChunk !== null
        || tileReception.receivedChunks.size !== tileReception.chunkCount) {
        failTile(
            `Tile ${tileRequestId} incompleto: ` +
            `${tileReception.receivedChunks.size}/${tileReception.chunkCount} chunks`
        );
        return;
    }

    const completed = tileReception;
    tileReception = null;

    // ACK de aplicación: el tile llegó completo al navegador.
    if (ensureSocketOpen(false)) {
        socket.send(`TILE_ACK ${tileRequestId}`);
    }

    const key = tileKey(
        completed.imageId,
        completed.zoom,
        completed.tileX,
        completed.tileY
    );

    const stillUseful = selectedImage
        && completed.imageId === selectedImage.id
        && desiredTileKeys.has(key);

    if (stillUseful) {
        tileCache.set(key, {
            imageId: completed.imageId,
            zoom: completed.zoom,
            tileX: completed.tileX,
            tileY: completed.tileY,
            width: completed.width,
            height: completed.height,
            format: completed.format,
            buffer: completed.buffer
        });

        drawTileIfVisible(tileCache.get(key));
    } else if (ensureSocketOpen(false)) {
        // Llegó un tile de una vista anterior después de que el usuario se movió.
        socket.send(
            `TILE_EVICT ${completed.imageId} ${completed.zoom} ${completed.tileX} ${completed.tileY}`
        );
    }

    updateTileProgress();
}

function handleBinaryMessage(arrayBuffer) {
    if (rootReception && rootReception.awaitingChunk) {
        handleRootBinary(arrayBuffer);
        return;
    }

    if (tileReception && tileReception.awaitingChunk) {
        handleTileBinary(arrayBuffer);
        return;
    }

    console.warn("Llegó un frame binario sin ROOT_DATA/TILE_DATA pendiente.");
}

function requestViewport(zoom, currentX, currentY) {
    if (!selectedImage || !rootSnapshot || !ensureSocketOpen()) {
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

    const previousViewId = currentView.viewId;
    const viewId = String(nextViewId++);
    currentView = { zoom, currentX, currentY, viewId };

    desiredTileKeys = planDesiredTileKeys(selectedImage, zoom, currentX, currentY);
    evictTilesOutsideDesiredSet();

    rootCanvas.width = VIEWPORT_PIXELS;
    rootCanvas.height = VIEWPORT_PIXELS;
    clearCanvas();
    drawCurrentViewportFromCache();

    const message = `VIEWPORT ${viewId} ${selectedImage.id} ${zoom} ${currentX} ${currentY}`;
    socket.send(message);

    viewerTitle.textContent = `${selectedImage.name} - nivel ${zoom}`;
    statusElement.textContent = `Enviado: ${message}`;
    rootProgress.textContent =
        `Vista ${viewId}: nivel ${zoom}, ventana 4×4 desde tile (${currentX}, ${currentY}).`;

    // No hace falta CANCEL entre vistas: el servidor reemplaza automáticamente
    // la cola pendiente al recibir el VIEWPORT nuevo.
    void previousViewId;

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

    // Coincide con el grupo D prefetched por el servidor: los cuatro tiles
    // centrales de la vista actual producen un 4x4 del siguiente nivel.
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
        if (oldViewId && ensureSocketOpen(false)) {
            socket.send(`CANCEL ${oldViewId}`);
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

    // Misma fórmula co-centrada usada por el grupo C del servidor.
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

    // B: 16 vecinos (hasta 4 por lado, sin esquinas).
    for (let x = currentX; x < currentX + VIEWPORT_TILES; x++) {
        add(zoom, x, currentY - 1, currentTiles);
        add(zoom, x, currentY + VIEWPORT_TILES, currentTiles);
    }
    for (let y = currentY; y < currentY + VIEWPORT_TILES; y++) {
        add(zoom, currentX - 1, y, currentTiles);
        add(zoom, currentX + VIEWPORT_TILES, y, currentTiles);
    }

    // D: 16 centrales del nivel siguiente.
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

    // C: 16 co-centrados del nivel anterior; z=1 usa ROOT.
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
        if (ensureSocketOpen(false)) {
            socket.send(`TILE_EVICT ${tile.imageId} ${tile.zoom} ${tile.tileX} ${tile.tileY}`);
        }
    }
}

function clearTileCache(notifyServer) {
    if (notifyServer && ensureSocketOpen(false)) {
        for (const tile of tileCache.values()) {
            socket.send(`TILE_EVICT ${tile.imageId} ${tile.zoom} ${tile.tileX} ${tile.tileY}`);
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
// Formatos de píxel
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
// UI / utilidades
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
        tileProgress.textContent =
            `ROOT local. Cache de tiles: ${tileCache.size}.`;
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

    tileProgress.textContent =
        `Visibles: ${visibleReady}/16 | ` +
        `cache deseada: ${desiredReady}/${desiredTileKeys.size} | ` +
        `tiles almacenados: ${tileCache.size}`;
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

function ensureSocketOpen(showMessage = true) {
    if (socket.readyState !== WebSocket.OPEN) {
        if (showMessage) {
            statusElement.textContent = "El WebSocket todavía no está listo.";
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

function failTile(message) {
    console.error(message);
    statusElement.textContent = message;
    tileReception = null;
    updateTileProgress();
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
