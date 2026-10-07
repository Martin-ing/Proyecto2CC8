import java.io.IOException;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Estado compartido por las cuatro conexiones WebSocket de un navegador:
 * CONTROL + CURRENT + PREVIOUS + NEXT.
 *
 * Cada canal de datos tiene un worker independiente y transmite su stream
 * secuencialmente, mientras los tres canales pueden trabajar en paralelo.
 * Al liberar reservas se revisa la vista vigente para no perder tiles cuando
 * cambian de canal durante un zoom. No añade un algoritmo de control de flujo.
 */
public class ClientSession implements AutoCloseable {
    private final String sessionId;
    private final WebSocketConnection control;
    private final ImageCatalog imageCatalog;
    private final GlobalImageCache imageCache;
    private final TilePlanner planner = new TilePlanner();

    private final Object stateLock = new Object();
    private final Set<TileId> clientHas = new HashSet<>();
    // Cada reserva pertenece a un stream: su limpieza no puede borrar la de otro.
    private final Map<TileId, String> inFlight = new HashMap<>();
    private final EnumMap<DataChannel, StreamPlan> activePlans = new EnumMap<>(DataChannel.class);
    private final EnumMap<DataChannel, DataWorker> workers = new EnumMap<>(DataChannel.class);
    private final AtomicLong nextStreamId = new AtomicLong(1);

    private volatile boolean running = true;
    private String selectedImageId;
    private ImageMeta selectedImage;
    private String currentViewId;
    private boolean viewCompleteLogged;

    public ClientSession(
            String sessionId,
            WebSocketConnection control,
            ImageCatalog imageCatalog,
            GlobalImageCache imageCache
    ) {
        this.sessionId = sessionId;
        this.control = control;
        this.imageCatalog = imageCatalog;
        this.imageCache = imageCache;

        for (DataChannel channel : DataChannel.values()) {
            workers.put(channel, new DataWorker(channel));
        }
    }

    public String sessionId() {
        return sessionId;
    }

    public void start() {
        for (DataWorker worker : workers.values()) {
            worker.start();
        }
    }

    public void attachChannel(DataChannel channel, WebSocketConnection connection) throws IOException {
        DataWorker worker = workers.get(channel);
        worker.attach(connection);
        connection.sendText("SESSION_JOINED " + sessionId + " " + channel.name());
        System.out.println("[SESSION " + sessionId + "] Canal " + channel + " conectado");
    }

    public void detachChannel(DataChannel channel, WebSocketConnection connection) {
        DataWorker worker = workers.get(channel);
        worker.detach(connection);
        System.out.println("[SESSION " + sessionId + "] Canal " + channel + " desconectado");
    }

    public void selectImage(String imageId) {
        synchronized (stateLock) {
            selectedImageId = imageId;
            selectedImage = null;
            currentViewId = null;
            activePlans.clear();
            viewCompleteLogged = false;
            clientHas.clear();
            inFlight.clear();
        }
        for (DataWorker worker : workers.values()) {
            worker.replacePlan(null);
        }
    }

    public void handleViewport(String[] parts) throws IOException {
        if (parts.length != 6) {
            control.sendText(
                    "ERROR 0 BAD_REQUEST Formato esperado: "
                            + "VIEWPORT <viewId> <imageId> <zoom> <currentX> <currentY>"
            );
            return;
        }

        String viewId = parts[1];
        String imageId = parts[2];
        if (!viewId.matches("[A-Za-z0-9_-]+")) {
            control.sendText("ERROR 0 BAD_REQUEST viewId inválido");
            return;
        }
        if (!imageId.matches("[A-Za-z0-9_.-]+")) {
            control.sendText("ERROR " + viewId + " BAD_REQUEST imageId inválido");
            return;
        }

        int zoom;
        int currentX;
        int currentY;
        try {
            zoom = Integer.parseInt(parts[3]);
            currentX = Integer.parseInt(parts[4]);
            currentY = Integer.parseInt(parts[5]);
        } catch (NumberFormatException e) {
            control.sendText("ERROR " + viewId + " BAD_REQUEST VIEWPORT contiene enteros inválidos");
            return;
        }

        ImageMeta image;
        synchronized (stateLock) {
            image = imageId.equals(selectedImageId) ? selectedImage : null;
        }

        if (image == null) {
            var found = imageCatalog.findById(imageId);
            if (found.isEmpty()) {
                control.sendText("ERROR " + viewId + " IMAGE_NOT_FOUND Imagen no encontrada");
                return;
            }
            image = found.get();
        }

        List<TilePlanEntry> plan;
        try {
            plan = planner.plan(image, zoom, currentX, currentY);
        } catch (IOException e) {
            control.sendText("ERROR " + viewId + " INVALID_VIEWPORT " + sanitize(e.getMessage()));
            return;
        }

        List<TileId> current = new ArrayList<>();
        List<TileId> previous = new ArrayList<>();
        List<TileId> next = new ArrayList<>();

        for (TilePlanEntry entry : plan) {
            switch (entry.group()) {
                case "A_CURRENT", "B_NEIGHBOR" -> current.add(entry.tile());
                case "C_PREVIOUS" -> previous.add(entry.tile());
                case "D_NEXT" -> next.add(entry.tile());
                default -> throw new IOException("Grupo de tile desconocido: " + entry.group());
            }
        }

        var newPlans = new EnumMap<DataChannel, StreamPlan>(DataChannel.class);
        if (!current.isEmpty()) newPlans.put(DataChannel.CURRENT, new StreamPlan(viewId, image, current));
        if (!previous.isEmpty()) newPlans.put(DataChannel.PREVIOUS, new StreamPlan(viewId, image, previous));
        if (!next.isEmpty()) newPlans.put(DataChannel.NEXT, new StreamPlan(viewId, image, next));

        // Publicar los tres planes juntos antes de despertar workers. Una
        // liberación de NEXT ya debe consultar el nuevo CURRENT (y viceversa).
        synchronized (stateLock) {
            if (!imageId.equals(selectedImageId)) {
                selectedImageId = imageId;
                clientHas.clear();
                inFlight.clear();
            }
            selectedImage = image;
            currentViewId = viewId;
            activePlans.clear();
            activePlans.putAll(newPlans);
            viewCompleteLogged = false;
            logViewCompleteIfReady();
        }
        for (DataChannel channel : DataChannel.values()) {
            workers.get(channel).replacePlan(newPlans.get(channel));
        }

        long actual = plan.stream().filter(p -> p.priority() == 1).count();
        long neighbors = plan.stream().filter(p -> p.priority() == 2).count();
        long nextCount = plan.stream().filter(p -> p.priority() == 3).count();
        long previousCount = plan.stream().filter(p -> p.priority() == 4).count();

        System.out.println("[VIEWPORT] session=" + sessionId + " view=" + viewId
                + " " + imageId + " z=" + zoom
                + " start=(" + currentX + "," + currentY + ")"
                + " -> CURRENT=" + (actual + neighbors)
                + " (A=" + actual + ", B=" + neighbors + ")"
                + " NEXT=" + nextCount
                + " PREVIOUS=" + previousCount);
    }

    public void handleTileAck(String[] parts) throws IOException {
        if (parts.length != 5) {
            control.sendText(
                    "ERROR 0 BAD_REQUEST Formato esperado: "
                            + "TILE_ACK <imageId> <zoom> <tileX> <tileY>"
            );
            return;
        }

        TileId tile = parseTile(parts, "TILE_ACK");
        if (tile == null) {
            return;
        }

        synchronized (stateLock) {
            if (!tile.imageId().equals(selectedImageId)) {
                return;
            }
            inFlight.remove(tile);
            clientHas.add(tile);
            logViewCompleteIfReady();
        }
        System.out.println("[TILE_ACK] session=" + sessionId + " " + tile);
    }

    public void handleTileEvict(String[] parts) throws IOException {
        if (parts.length != 5) {
            control.sendText(
                    "ERROR 0 BAD_REQUEST Formato esperado: "
                            + "TILE_EVICT <imageId> <zoom> <tileX> <tileY>"
            );
            return;
        }

        TileId tile = parseTile(parts, "TILE_EVICT");
        if (tile == null) {
            return;
        }

        synchronized (stateLock) {
            clientHas.remove(tile);
            // EVICT describe la caché del navegador; no cancela un envío nuevo
            // que ya tenga reservado este mismo tile en otro stream.
            if (activePlans.values().stream().anyMatch(plan -> plan.tiles().contains(tile))) {
                viewCompleteLogged = false;
            }
        }
        System.out.println("[TILE_EVICT] session=" + sessionId + " " + tile);
        rescheduleMissingTiles();
    }

    public void handleCancel(String[] parts) throws IOException {
        if (parts.length != 2) {
            control.sendText("ERROR 0 BAD_REQUEST Formato esperado: CANCEL <requestId>");
            return;
        }

        String requestId = parts[1];
        boolean cancel;
        synchronized (stateLock) {
            cancel = requestId.equals(currentViewId);
            if (cancel) {
                currentViewId = null;
                activePlans.clear();
                viewCompleteLogged = false;
            }
        }

        if (cancel) {
            for (DataWorker worker : workers.values()) {
                worker.replacePlan(null);
            }
            System.out.println("[CANCEL] session=" + sessionId + " vista=" + requestId);
        }
    }

    private TileId parseTile(String[] parts, String command) throws IOException {
        String imageId = parts[1];
        int zoom;
        int tileX;
        int tileY;
        try {
            zoom = Integer.parseInt(parts[2]);
            tileX = Integer.parseInt(parts[3]);
            tileY = Integer.parseInt(parts[4]);
        } catch (NumberFormatException e) {
            control.sendText("ERROR 0 BAD_REQUEST " + command + " contiene enteros inválidos");
            return null;
        }
        return new TileId(imageId, zoom, tileX, tileY);
    }

    /**
     * Reserva los tiles justo antes de anunciar TILE_STREAM_START. Esto evita
     * que dos canales paralelos anuncien/transmitan el mismo tile.
     */
    private List<TileId> reserveTiles(DataChannel channel, StreamPlan plan, String streamId) {
        List<TileId> reserved = new ArrayList<>();
        synchronized (stateLock) {
            // Un worker pudo tomar su plan justo antes de un VIEWPORT/CANCEL.
            if (!running || activePlans.get(channel) != plan) return reserved;
            for (TileId tile : plan.tiles()) {
                if (clientHas.contains(tile) || inFlight.containsKey(tile)) {
                    continue;
                }
                inFlight.put(tile, streamId);
                reserved.add(tile);
            }
        }
        return reserved;
    }

    private void releaseReservations(String streamId, List<TileId> tiles, int fromIndex) {
        boolean released = false;
        synchronized (stateLock) {
            for (int i = fromIndex; i < tiles.size(); i++) {
                released |= inFlight.remove(tiles.get(i), streamId);
            }
        }
        if (released) rescheduleMissingTiles();
    }

    /** Revisión por eventos, sin temporizador ni espera de ACK para transmitir. */
    private void rescheduleMissingTiles() {
        var pending = new EnumMap<DataChannel, StreamPlan>(DataChannel.class);
        synchronized (stateLock) {
            if (!running) return;
            for (var entry : activePlans.entrySet()) {
                boolean missing = entry.getValue().tiles().stream()
                        .anyMatch(tile -> !clientHas.contains(tile) && !inFlight.containsKey(tile));
                if (missing) pending.put(entry.getKey(), entry.getValue());
            }
        }
        // No anidar stateLock con el lock de un worker.
        pending.forEach((channel, plan) -> workers.get(channel).requestRecheck(plan));
    }

    /** Debe invocarse bajo stateLock. El fin de un stream no implica vista completa. */
    private void logViewCompleteIfReady() {
        if (viewCompleteLogged || currentViewId == null || activePlans.isEmpty()) return;
        int total = 0;
        for (StreamPlan plan : activePlans.values()) {
            for (TileId tile : plan.tiles()) {
                if (!clientHas.contains(tile)) return;
                total++;
            }
        }
        viewCompleteLogged = true;
        System.out.println("[VIEW_COMPLETE] session=" + sessionId + " view=" + currentViewId
                + " confirmed=" + total + "/" + total);
    }

    private static String sanitize(String text) {
        if (text == null || text.isBlank()) {
            return "Error sin detalle";
        }
        return text.replace('\n', ' ').replace('\r', ' ');
    }

    @Override
    public void close() {
        running = false;
        for (DataWorker worker : workers.values()) {
            worker.close();
        }
        synchronized (stateLock) {
            clientHas.clear();
            inFlight.clear();
            activePlans.clear();
            currentViewId = null;
        }
    }

    private record StreamPlan(String viewId, ImageMeta image, List<TileId> tiles) {
        private StreamPlan {
            tiles = List.copyOf(tiles);
        }
    }

    private final class DataWorker implements AutoCloseable {
        private final DataChannel channel;
        private final TileStreamer streamer = new TileStreamer(imageCache);
        private final Object lock = new Object();

        private WebSocketConnection connection;
        private StreamPlan latestPlan;
        private StreamPlan pendingPlan;
        private long generation;
        private volatile boolean workerRunning = true;
        private Thread thread;

        private DataWorker(DataChannel channel) {
            this.channel = channel;
        }

        void start() {
            thread = Thread.startVirtualThread(this::runLoop);
        }

        void attach(WebSocketConnection newConnection) {
            synchronized (lock) {
                WebSocketConnection old = connection;
                connection = newConnection;
                if (old != null && old != newConnection) {
                    try {
                        old.sendClose();
                    } catch (IOException ignored) {
                    }
                }
                lock.notifyAll();
            }
        }

        void detach(WebSocketConnection candidate) {
            synchronized (lock) {
                if (connection == candidate) {
                    connection = null;
                    lock.notifyAll();
                }
            }
        }

        void replacePlan(StreamPlan plan) {
            synchronized (lock) {
                latestPlan = plan;
                pendingPlan = plan;
                generation++;
                lock.notifyAll();
            }
        }

        void requestRecheck(StreamPlan plan) {
            synchronized (lock) {
                if (!workerRunning || latestPlan != plan || pendingPlan != null) return;
                pendingPlan = plan;
                // Revisar faltantes no invalida el stream que sigue enviándose.
                lock.notifyAll();
            }
        }

        private void runLoop() {
            while (running && workerRunning) {
                StreamPlan plan;
                WebSocketConnection target;
                long myGeneration;

                synchronized (lock) {
                    while (running && workerRunning
                            && (connection == null || pendingPlan == null)) {
                        try {
                            lock.wait();
                        } catch (InterruptedException e) {
                            Thread.currentThread().interrupt();
                            return;
                        }
                    }

                    if (!running || !workerRunning) {
                        return;
                    }

                    plan = pendingPlan;
                    pendingPlan = null;
                    target = connection;
                    myGeneration = generation;
                }

                String streamId = Long.toString(nextStreamId.getAndIncrement());
                List<TileId> reserved = reserveTiles(channel, plan, streamId);
                if (reserved.isEmpty()) {
                    continue;
                }

                int sentCount = 0;

                try {
                    System.out.println("[STREAM " + channel + "] session=" + sessionId
                            + " stream=" + streamId + " view=" + plan.viewId()
                            + " z=" + reserved.getFirst().zoom()
                            + " tiles=" + reserved.size());

                    sentCount = streamer.stream(
                            streamId,
                            plan.viewId(),
                            plan.image(),
                            channel,
                            reserved,
                            target,
                            () -> isGenerationCurrent(myGeneration, target)
                    );

                    releaseReservations(streamId, reserved, sentCount);

                    System.out.println("[STREAM " + channel + "] fin stream=" + streamId
                            + " enviados=" + sentCount + "/" + reserved.size());
                } catch (IOException e) {
                    // Ante un fallo no sabemos con certeza qué llegó; los ACK ya
                    // recibidos permanecen en clientHas y el resto queda libre
                    // para una futura retransmisión.
                    releaseReservations(streamId, reserved, 0);
                    synchronized (lock) {
                        if (connection == target) {
                            connection = null;
                        }
                        if (generation == myGeneration && pendingPlan == null) {
                            pendingPlan = plan;
                        }
                        lock.notifyAll();
                    }
                    System.err.println("[STREAM " + channel + "] Error: " + e.getMessage());
                }
            }
        }

        private boolean isGenerationCurrent(long expected, WebSocketConnection target) {
            synchronized (lock) {
                return running && workerRunning
                        && generation == expected
                        && connection == target;
            }
        }

        @Override
        public void close() {
            workerRunning = false;
            synchronized (lock) {
                latestPlan = null;
                pendingPlan = null;
                if (connection != null) {
                    try {
                        connection.sendClose();
                    } catch (IOException ignored) {
                    }
                }
                connection = null;
                lock.notifyAll();
            }
            if (thread != null) {
                thread.interrupt();
            }
        }
    }
}
