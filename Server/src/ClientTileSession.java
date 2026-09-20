import java.io.IOException;
import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;


public class ClientTileSession implements AutoCloseable {
    private final WebSocketConnection connection;
    private final ImageCatalog imageCatalog;
    private final TilePlanner planner = new TilePlanner();
    private final TileStreamer streamer = new TileStreamer();

    private final Object lock = new Object();
    private final ArrayDeque<QueuedTile> pending = new ArrayDeque<>();
    private final Set<TileId> desired = new HashSet<>();
    private final Set<TileId> clientHas = new HashSet<>();
    private final Set<TileId> sentAwaitingAck = new HashSet<>();
    private final Map<String, TileId> requestToTile = new HashMap<>();

    private volatile boolean running = true;
    private Thread senderThread;

    private String selectedImageId;
    private ImageMeta selectedImage;
    private String currentViewId;
    private long nextTileRequestId = 1;

    public ClientTileSession(WebSocketConnection connection, ImageCatalog imageCatalog) {
        this.connection = connection;
        this.imageCatalog = imageCatalog;
    }

    public void start() {
        senderThread = Thread.startVirtualThread(this::sendLoop);
    }

    public void selectImage(String imageId) {
        synchronized (lock) {
            selectedImageId = imageId;
            selectedImage = null;
            currentViewId = null;
            pending.clear();
            desired.clear();
            clientHas.clear();
            sentAwaitingAck.clear();
            requestToTile.clear();
            lock.notifyAll();
        }
    }

    public void handleViewport(String[] parts) throws IOException {
        if (parts.length != 6) {
            connection.sendText(
                    "ERROR 0 BAD_REQUEST Formato esperado: "
                            + "VIEWPORT <viewId> <imageId> <zoom> <currentX> <currentY>"
            );
            return;
        }

        String viewId = parts[1];
        String imageId = parts[2];
        if (!viewId.matches("[A-Za-z0-9_-]+")) {
            connection.sendText("ERROR 0 BAD_REQUEST viewId inválido");
            return;
        }
        if (!imageId.matches("[A-Za-z0-9_.-]+")) {
            connection.sendText("ERROR " + viewId + " BAD_REQUEST imageId inválido");
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
            connection.sendText("ERROR " + viewId + " BAD_REQUEST VIEWPORT contiene enteros inválidos");
            return;
        }

        ImageMeta image;
        synchronized (lock) {
            image = imageId.equals(selectedImageId) ? selectedImage : null;
        }

        if (image == null) {
            var found = imageCatalog.findById(imageId);
            if (found.isEmpty()) {
                connection.sendText("ERROR " + viewId + " IMAGE_NOT_FOUND Imagen no encontrada");
                return;
            }
            image = found.get();
        }

        List<TilePlanEntry> plan;
        try {
            plan = planner.plan(image, zoom, currentX, currentY);
        } catch (IOException e) {
            connection.sendText("ERROR " + viewId + " INVALID_VIEWPORT "
                    + sanitize(e.getMessage()));
            return;
        }

        synchronized (lock) {
            if (!imageId.equals(selectedImageId)) {
                selectedImageId = imageId;
                clientHas.clear();
                sentAwaitingAck.clear();
                requestToTile.clear();
            }
            selectedImage = image;
            currentViewId = viewId;

            desired.clear();
            for (TilePlanEntry entry : plan) {
                desired.add(entry.tile());
            }

            // Un VIEWPORT nuevo reemplaza el trabajo que aún no comenzó.
            pending.clear();
            for (TilePlanEntry entry : plan) {
                TileId tile = entry.tile();
                if (clientHas.contains(tile) || sentAwaitingAck.contains(tile)) {
                    continue;
                }
                pending.addLast(new QueuedTile(viewId, image, entry));
            }

            lock.notifyAll();
        }

        long actual = plan.stream().filter(p -> p.priority() == 1).count();
        long neighbors = plan.stream().filter(p -> p.priority() == 2).count();
        long next = plan.stream().filter(p -> p.priority() == 3).count();
        long previous = plan.stream().filter(p -> p.priority() == 4).count();
        System.out.println("[VIEWPORT] " + viewId + " " + imageId
                + " z=" + zoom + " start=(" + currentX + "," + currentY + ")"
                + " -> A=" + actual + " B=" + neighbors
                + " D=" + next + " C=" + previous);
    }

    public void handleTileAck(String[] parts) throws IOException {
        if (parts.length != 2) {
            connection.sendText("ERROR 0 BAD_REQUEST Formato esperado: TILE_ACK <tileRequestId>");
            return;
        }

        String requestId = parts[1];
        synchronized (lock) {
            TileId tile = requestToTile.remove(requestId);
            if (tile == null) {
                System.out.println("[TILE_ACK] ACK desconocido: " + requestId);
                return;
            }

            sentAwaitingAck.remove(tile);
            clientHas.add(tile);
            System.out.println("[TILE_ACK] " + requestId + " -> " + tile);
        }
    }

    public void handleTileEvict(String[] parts) throws IOException {
        if (parts.length != 5) {
            connection.sendText(
                    "ERROR 0 BAD_REQUEST Formato esperado: "
                            + "TILE_EVICT <imageId> <zoom> <tileX> <tileY>"
            );
            return;
        }

        int zoom;
        int tileX;
        int tileY;
        try {
            zoom = Integer.parseInt(parts[2]);
            tileX = Integer.parseInt(parts[3]);
            tileY = Integer.parseInt(parts[4]);
        } catch (NumberFormatException e) {
            connection.sendText("ERROR 0 BAD_REQUEST TILE_EVICT contiene enteros inválidos");
            return;
        }

        TileId tile = new TileId(parts[1], zoom, tileX, tileY);
        synchronized (lock) {
            clientHas.remove(tile);
            sentAwaitingAck.remove(tile);
            requestToTile.entrySet().removeIf(entry -> entry.getValue().equals(tile));
        }
        System.out.println("[TILE_EVICT] " + tile);
    }


    public void handleCancel(String[] parts) throws IOException {
        if (parts.length != 2) {
            connection.sendText("ERROR 0 BAD_REQUEST Formato esperado: CANCEL <requestId>");
            return;
        }

        String requestId = parts[1];
        synchronized (lock) {
            if (requestId.equals(currentViewId)) {
                pending.clear();
                desired.clear();
                currentViewId = null;
                lock.notifyAll();
                System.out.println("[CANCEL] Vista cancelada: " + requestId);
            }
        }
    }

    private void sendLoop() {
        while (running) {
            QueuedTile queued;
            String tileRequestId;

            synchronized (lock) {
                while (running && pending.isEmpty()) {
                    try {
                        lock.wait();
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        return;
                    }
                }

                if (!running) {
                    return;
                }

                queued = pending.pollFirst();
                TileId tile = queued.entry().tile();

                if (!desired.contains(tile)
                        || clientHas.contains(tile)
                        || sentAwaitingAck.contains(tile)
                        || !queued.image().id().equals(selectedImageId)) {
                    continue;
                }

                tileRequestId = Long.toString(nextTileRequestId++);
                sentAwaitingAck.add(tile);
                requestToTile.put(tileRequestId, tile);
            }

            try {
                TileId tile = queued.entry().tile();
                System.out.println("[TILE] Enviando " + tileRequestId
                        + " " + tile + " grupo=" + queued.entry().group());
                streamer.stream(
                        tileRequestId,
                        queued.viewId(),
                        queued.image(),
                        tile,
                        connection
                );
            } catch (IOException e) {
                synchronized (lock) {
                    TileId tile = requestToTile.remove(tileRequestId);
                    if (tile != null) {
                        sentAwaitingAck.remove(tile);
                    }
                }

                try {
                    connection.sendText("ERROR " + queued.viewId()
                            + " TILE_READ_ERROR " + sanitize(e.getMessage()));
                } catch (IOException ignored) {
                    // La conexión probablemente ya se cerró.
                }

                System.err.println("[TILE] Error: " + e.getMessage());
            }
        }
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
        synchronized (lock) {
            pending.clear();
            lock.notifyAll();
        }
        if (senderThread != null) {
            senderThread.interrupt();
        }
    }

    private record QueuedTile(
            String viewId,
            ImageMeta image,
            TilePlanEntry entry
    ) {
    }
}
