const loadFilesButton = document.getElementById("loadFilesButton");
const statusElement = document.getElementById("status");
const imageList = document.getElementById("imageList");
const viewerSection = document.getElementById("viewerSection");
const viewerTitle = document.getElementById("viewerTitle");
const rootProgress = document.getElementById("rootProgress");
const rootCanvas = document.getElementById("rootCanvas");
const rootFormatSelect = document.getElementById("rootFormat");
const rootContext = rootCanvas.getContext("2d");

let nextRequestId = 1;
let rootReception = null;
let currentRootButton = null;

// El cliente y el servidor se ejecutan de forma independiente.
// Por eso NO usamos window.location.host: el frontend puede estar, por ejemplo,
// en http://localhost:5500 mientras Java escucha en localhost:8080.
const SERVER_WEBSOCKET_URL = "ws://localhost:8080/ws";
const socket = new WebSocket(SERVER_WEBSOCKET_URL);

// Así los frames binarios llegan directamente como ArrayBuffer y no como Blob.
socket.binaryType = "arraybuffer";

socket.addEventListener("open", () => {
    statusElement.textContent = `Conectado a ${SERVER_WEBSOCKET_URL}`;
    loadFilesButton.disabled = false;
});

socket.addEventListener("close", () => {
    statusElement.textContent = "La conexión con el servidor Java se cerró.";
    loadFilesButton.disabled = true;
    setRootButtonsDisabled(true);
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

function handleBinaryMessage(arrayBuffer) {
    if (!rootReception || !rootReception.awaitingChunk) {
        console.warn("Llegó un frame binario sin ROOT_DATA pendiente.");
        return;
    }

    const { chunkIndex, dataLength } = rootReception.awaitingChunk;
    const chunk = new Uint8Array(arrayBuffer);

    if (chunk.byteLength !== dataLength) {
        failRoot(
            `Chunk ${chunkIndex}: se esperaban ${dataLength} bytes y llegaron ${chunk.byteLength}`
        );
        return;
    }

    const destinationOffset = chunkIndex * rootReception.chunkSize;
    if (destinationOffset + dataLength > rootReception.buffer.length) {
        failRoot(`Chunk ${chunkIndex} excede el tamaño de ROOT`);
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

    drawRoot(
        rootReception.buffer,
        rootReception.width,
        rootReception.height,
        rootReception.format
    );

    rootProgress.textContent =
        `ROOT completa: ${rootReception.width}×${rootReception.height}, ${rootReception.format}`;
    statusElement.textContent =
        `ROOT ${rootReception.imageId} reconstruida y mostrada en el canvas.`;

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

function requestRoot(image, button) {
    if (!ensureSocketOpen()) {
        return;
    }

    if (rootReception !== null) {
        statusElement.textContent = "Ya hay una ROOT en proceso de recepción.";
        return;
    }

    const requestId = String(nextRequestId++);
    const format = rootFormatSelect.value;
    const message = `ROOT ${requestId} ${image.id} ${format}`;

    currentRootButton = button;
    setRootButtonsDisabled(true);
    viewerSection.hidden = false;
    viewerTitle.textContent = `ROOT - ${image.name}`;
    rootProgress.textContent = "Esperando ROOT_START...";
    clearCanvas();

    socket.send(message);
    statusElement.textContent = `Enviado: ${message}`;
}

function bytesPerPixelForFormat(format) {
    if (format === "RGBA8888") {
        return 4;
    }
    if (format === "RGBA4444") {
        return 2;
    }
    return null;
}

function drawRoot(buffer, width, height, format) {
    if (format === "RGBA8888") {
        drawRgba8888(buffer, width, height);
        return;
    }

    if (format === "RGBA4444") {
        drawRgba4444(buffer, width, height);
        return;
    }

    throw new Error(`Formato ROOT no soportado al dibujar: ${format}`);
}

function drawRgba8888(rgba8888, width, height) {
    const expectedLength = width * height * 4;
    if (rgba8888.length !== expectedLength) {
        throw new Error(
            `RGBA8888 inválido: se esperaban ${expectedLength} bytes y hay ${rgba8888.length}`
        );
    }

    // Canvas utiliza precisamente RGBA de 8 bits por canal, por lo que no hay
    // conversión de color: solo pasamos los bytes recibidos a ImageData.
    const pixels = new Uint8ClampedArray(rgba8888);
    const imageData = new ImageData(pixels, width, height);
    rootContext.putImageData(imageData, 0, 0);
}

function drawRgba4444(rgba4444, width, height) {
    const expectedLength = width * height * 2;
    if (rgba4444.length !== expectedLength) {
        throw new Error(
            `RGBA4444 inválido: se esperaban ${expectedLength} bytes y hay ${rgba4444.length}`
        );
    }

    const rgba8888 = new Uint8ClampedArray(width * height * 4);

    for (let pixel = 0; pixel < width * height; pixel++) {
        const source = pixel * 2;
        const destination = pixel * 4;

        const high = rgba4444[source];
        const low = rgba4444[source + 1];

        // El servidor envía el uint16 en big endian:
        // [RRRRGGGG] [BBBBAAAA]
        const r4 = high >>> 4;
        const g4 = high & 0x0F;
        const b4 = low >>> 4;
        const a4 = low & 0x0F;

        // Expandir 4 bits a 8 bits: n * 17 equivale a replicar el nibble.
        rgba8888[destination] = r4 * 17;
        rgba8888[destination + 1] = g4 * 17;
        rgba8888[destination + 2] = b4 * 17;
        rgba8888[destination + 3] = a4 * 17;
    }

    const imageData = new ImageData(rgba8888, width, height);
    rootContext.putImageData(imageData, 0, 0);
}

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

function ensureSocketOpen() {
    if (socket.readyState !== WebSocket.OPEN) {
        statusElement.textContent = "El WebSocket todavía no está listo.";
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
