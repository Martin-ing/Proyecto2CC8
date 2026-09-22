import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

public class ImageServer {
    private static final String WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    private static final int MAX_HTTP_HEADER_SIZE = 64 * 1024;

    private final int port;
    private final ImageCatalog imageCatalog;
    private final RootStreamer rootStreamer;
    private final Map<String, ClientSession> sessions = new ConcurrentHashMap<>();

    public ImageServer(int port, Path imagesDirectory) {
        this.port = port;
        this.imageCatalog = new ImageCatalog(imagesDirectory);
        this.rootStreamer = new RootStreamer();
    }

    public void start() throws IOException {
        try (ServerSocket serverSocket = new ServerSocket(port)) {
            System.out.println("Servidor de protocolo iniciado en puerto " + port);
            System.out.println("WebSocket disponible en ws://localhost:" + port + "/ws");
            System.out.println("Esquema: 1 CONTROL + 3 canales de datos (CURRENT/PREVIOUS/NEXT)");
            System.out.println("Esperando clientes...");

            while (true) {
                Socket socket = serverSocket.accept();
                Thread.startVirtualThread(() -> handleClient(socket));
            }
        }
    }

    private void handleClient(Socket socket) {
        String remote = String.valueOf(socket.getRemoteSocketAddress());

        try (socket;
             InputStream input = new BufferedInputStream(socket.getInputStream());
             OutputStream output = new BufferedOutputStream(socket.getOutputStream())) {

            HttpRequest request = readHttpRequest(input);
            if (request == null) {
                return;
            }

            if (isWebSocketUpgrade(request) && "/ws".equals(request.path())) {
                performWebSocketHandshake(request, output);
                WebSocketConnection connection = new WebSocketConnection(input, output);
                System.out.println("[WS] Conexión abierta: " + remote);
                routeWebSocket(connection, remote);
                System.out.println("[WS] Conexión cerrada: " + remote);
                return;
            }

            sendPlainResponse(
                    output,
                    426,
                    "Upgrade Required",
                    "Este proceso solo atiende el protocolo WebSocket en /ws."
            );
        } catch (Exception e) {
            System.err.println("[ERROR] Cliente " + remote + ": " + e.getMessage());
        }
    }

    /**
     * El primer mensaje de cada WebSocket define su papel:
     *   SESSION_OPEN
     *   SESSION_JOIN <sessionId> <CURRENT|PREVIOUS|NEXT>
     */
    private void routeWebSocket(WebSocketConnection connection, String remote) throws IOException {
        String firstMessage = connection.readTextMessage();
        if (firstMessage == null) {
            return;
        }

        firstMessage = firstMessage.trim();
        System.out.println("[PROTOCOLO] Primer mensaje " + remote + ": " + firstMessage);
        String[] parts = firstMessage.split("\\s+");

        if (parts.length == 1 && "SESSION_OPEN".equals(parts[0])) {
            handleControlConnection(connection);
            return;
        }

        if (parts.length == 3 && "SESSION_JOIN".equals(parts[0])) {
            handleDataConnection(connection, parts[1], parts[2]);
            return;
        }

        connection.sendText(
                "ERROR 0 SESSION_REQUIRED Primer mensaje esperado: SESSION_OPEN o "
                        + "SESSION_JOIN <sessionId> <CURRENT|PREVIOUS|NEXT>"
        );
    }

    private void handleControlConnection(WebSocketConnection connection) throws IOException {
        String sessionId = UUID.randomUUID().toString();
        ClientSession session = new ClientSession(sessionId, connection, imageCatalog);
        sessions.put(sessionId, session);
        session.start();

        connection.sendText("SESSION_OK " + sessionId);
        System.out.println("[SESSION] Creada " + sessionId);

        try {
            String message;
            while ((message = connection.readTextMessage()) != null) {
                message = message.trim();
                if (message.isEmpty()) {
                    continue;
                }

                System.out.println("[CONTROL " + sessionId + "] " + message);
                String[] parts = message.split("\\s+");
                String command = parts[0];

                if ("ARCHIVOS".equals(command)) {
                    handleArchivos(parts, connection);
                } else if ("ROOT".equals(command)) {
                    handleRoot(parts, connection, session);
                } else if ("VIEWPORT".equals(command)) {
                    session.handleViewport(parts);
                } else if ("TILE_ACK".equals(command)) {
                    session.handleTileAck(parts);
                } else if ("TILE_EVICT".equals(command)) {
                    session.handleTileEvict(parts);
                } else if ("CANCEL".equals(command)) {
                    session.handleCancel(parts);
                } else {
                    String requestId = parts.length > 1 ? parts[1] : "0";
                    connection.sendText(
                            "ERROR " + requestId + " UNKNOWN_COMMAND Comando no soportado en CONTROL"
                    );
                }
            }
        } finally {
            sessions.remove(sessionId, session);
            session.close();
            System.out.println("[SESSION] Cerrada " + sessionId);
        }
    }

    private void handleDataConnection(
            WebSocketConnection connection,
            String sessionId,
            String channelText
    ) throws IOException {
        ClientSession session = sessions.get(sessionId);
        if (session == null) {
            connection.sendText("ERROR 0 SESSION_NOT_FOUND Sesión inexistente o cerrada");
            return;
        }

        DataChannel channel = DataChannel.fromProtocol(channelText);
        if (channel == null) {
            connection.sendText(
                    "ERROR 0 BAD_CHANNEL Canales soportados: CURRENT, PREVIOUS, NEXT"
            );
            return;
        }

        session.attachChannel(channel, connection);

        try {
            // Los canales de datos son server -> client. Este loop únicamente
            // mantiene viva la conexión y procesa close/ping de WebSocket.
            String unexpected;
            while ((unexpected = connection.readTextMessage()) != null) {
                unexpected = unexpected.trim();
                if (!unexpected.isEmpty()) {
                    connection.sendText(
                            "ERROR 0 DATA_CHANNEL_READ_ONLY Usa la conexión CONTROL para comandos"
                    );
                }
            }
        } finally {
            session.detachChannel(channel, connection);
        }
    }

    private void handleArchivos(String[] parts, WebSocketConnection connection) throws IOException {
        if (parts.length != 2) {
            connection.sendText("ERROR 0 BAD_REQUEST Formato esperado: ARCHIVOS <requestId>");
            return;
        }

        String requestId = parts[1];
        if (!requestId.matches("[A-Za-z0-9_-]+")) {
            connection.sendText("ERROR 0 BAD_REQUEST requestId inválido");
            return;
        }

        try {
            List<ImageMeta> images = imageCatalog.listAvailableImages();

            StringBuilder response = new StringBuilder();
            response.append("ARCHIVOS_OK ")
                    .append(requestId)
                    .append(' ')
                    .append(images.size());

            for (ImageMeta image : images) {
                response.append('\n').append(image.toProtocolLine());
            }

            connection.sendText(response.toString());
            System.out.println("[PROTOCOLO] Enviadas " + images.size()
                    + " imágenes para requestId=" + requestId);
        } catch (IOException e) {
            connection.sendText(
                    "ERROR " + requestId
                            + " FILE_LIST_ERROR No se pudo leer el catálogo de imágenes"
            );
            throw e;
        }
    }

    private void handleRoot(
            String[] parts,
            WebSocketConnection connection,
            ClientSession session
    ) throws IOException {
        if (parts.length != 4) {
            connection.sendText(
                    "ERROR 0 BAD_REQUEST Formato esperado: "
                            + "ROOT <requestId> <imageId> <RGBA4444|RGBA8888>"
            );
            return;
        }

        String requestId = parts[1];
        String imageId = parts[2];
        PixelFormat format = PixelFormat.fromProtocol(parts[3]);

        if (!requestId.matches("[A-Za-z0-9_-]+")) {
            connection.sendText("ERROR 0 BAD_REQUEST requestId inválido");
            return;
        }

        if (!imageId.matches("[A-Za-z0-9_.-]+")) {
            connection.sendText("ERROR " + requestId + " BAD_REQUEST imageId inválido");
            return;
        }

        if (format == null) {
            connection.sendText(
                    "ERROR " + requestId
                            + " UNSUPPORTED_FORMAT Formatos soportados: RGBA4444, RGBA8888"
            );
            return;
        }

        try {
            var image = imageCatalog.findById(imageId);
            if (image.isEmpty()) {
                connection.sendText(
                        "ERROR " + requestId + " IMAGE_NOT_FOUND Imagen no encontrada"
                );
                return;
            }

            session.selectImage(imageId);

            System.out.println("[ROOT] Iniciando ROOT de " + imageId
                    + " en " + format.protocolName()
                    + " para requestId=" + requestId);
            rootStreamer.stream(requestId, image.get(), format, connection);
            System.out.println("[ROOT] Finalizado ROOT de " + imageId
                    + " en " + format.protocolName()
                    + " para requestId=" + requestId);
        } catch (IOException e) {
            connection.sendText(
                    "ERROR " + requestId + " ROOT_READ_ERROR No se pudo transmitir ROOT"
            );
            throw e;
        }
    }

    private boolean isWebSocketUpgrade(HttpRequest request) {
        String upgrade = request.headers().getOrDefault("upgrade", "");
        String connection = request.headers().getOrDefault("connection", "");
        return "websocket".equalsIgnoreCase(upgrade)
                && connection.toLowerCase().contains("upgrade");
    }

    private void performWebSocketHandshake(HttpRequest request, OutputStream output)
            throws IOException, NoSuchAlgorithmException {
        String key = request.headers().get("sec-websocket-key");
        if (key == null || key.isBlank()) {
            sendPlainResponse(output, 400, "Bad Request", "Falta Sec-WebSocket-Key");
            throw new IOException("Handshake WebSocket sin Sec-WebSocket-Key");
        }

        MessageDigest sha1 = MessageDigest.getInstance("SHA-1");
        byte[] digest = sha1.digest(
                (key.trim() + WEBSOCKET_GUID).getBytes(StandardCharsets.US_ASCII)
        );
        String accept = Base64.getEncoder().encodeToString(digest);

        String response = "HTTP/1.1 101 Switching Protocols\r\n"
                + "Upgrade: websocket\r\n"
                + "Connection: Upgrade\r\n"
                + "Sec-WebSocket-Accept: " + accept + "\r\n"
                + "\r\n";

        output.write(response.getBytes(StandardCharsets.US_ASCII));
        output.flush();
    }

    private void sendPlainResponse(
            OutputStream output,
            int status,
            String reason,
            String text
    ) throws IOException {
        byte[] body = text.getBytes(StandardCharsets.UTF_8);
        String headers = "HTTP/1.1 " + status + " " + reason + "\r\n"
                + "Content-Type: text/plain; charset=utf-8\r\n"
                + "Content-Length: " + body.length + "\r\n"
                + "Connection: close\r\n"
                + "\r\n";

        output.write(headers.getBytes(StandardCharsets.US_ASCII));
        output.write(body);
        output.flush();
    }

    private HttpRequest readHttpRequest(InputStream input) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        int state = 0;

        while (buffer.size() < MAX_HTTP_HEADER_SIZE) {
            int current = input.read();
            if (current == -1) {
                if (buffer.size() == 0) {
                    return null;
                }
                throw new IOException("Petición HTTP incompleta");
            }

            buffer.write(current);

            if ((state == 0 || state == 2) && current == '\r') {
                state++;
            } else if ((state == 1 || state == 3) && current == '\n') {
                state++;
                if (state == 4) {
                    break;
                }
            } else {
                state = current == '\r' ? 1 : 0;
            }
        }

        if (buffer.size() >= MAX_HTTP_HEADER_SIZE) {
            throw new IOException("Headers HTTP demasiado grandes");
        }

        String headerText = buffer.toString(StandardCharsets.US_ASCII);
        String[] lines = headerText.split("\\r\\n");
        if (lines.length == 0) {
            throw new IOException("Petición HTTP vacía");
        }

        String[] requestLine = lines[0].split("\\s+", 3);
        if (requestLine.length != 3) {
            throw new IOException("Request line inválida: " + lines[0]);
        }

        Map<String, String> headers = new HashMap<>();
        for (int i = 1; i < lines.length; i++) {
            int separator = lines[i].indexOf(':');
            if (separator <= 0) {
                continue;
            }

            String key = lines[i].substring(0, separator).trim().toLowerCase();
            String value = lines[i].substring(separator + 1).trim();
            headers.put(key, value);
        }

        return new HttpRequest(requestLine[0], requestLine[1], headers);
    }

    private record HttpRequest(String method, String path, Map<String, String> headers) {
    }
}
