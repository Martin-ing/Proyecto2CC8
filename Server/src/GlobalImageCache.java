import java.io.IOException;
import java.io.InterruptedIOException;
import java.util.HashMap;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Semaphore;

/** Una instancia por ImageServer; no contiene estado de sesiones ni ACK. */
public final class GlobalImageCache {
    public static final long DEFAULT_BYTES = 64L * 1024 * 1024;
    private static final int CHANCES = 2;
    private final Object lock = new Object();
    private final long maxBytes;
    private final Semaphore loadSlots;
    private final Map<ImageCacheKey, Entry> entries = new HashMap<>();
    private final Map<ImageCacheKey, CompletableFuture<Payload>> loading = new HashMap<>();
    private Entry hand;
    private long bytes, hits, loads, sharedLoads, failures, evictions;

    @FunctionalInterface
    public interface Loader { byte[] load() throws IOException; }

    // Copia defensiva: ningún worker puede sobrescribir los datos compartidos.
    public static final class Payload {
        private final byte[] data;
        private Payload(byte[] source) { data = source.clone(); }
        public int length() { return data.length; }
        public void sendTo(WebSocketConnection connection) throws IOException { connection.sendBinary(data); }
        byte[] copyBytes() { return data.clone(); }
    }

    private static final class Entry {
        final ImageCacheKey key;
        final Payload payload;
        int chances = CHANCES;
        Entry previous, next;
        Entry(ImageCacheKey key, Payload payload) { this.key = key; this.payload = payload; }
    }

    public GlobalImageCache(long maxBytes, int maxConcurrentLoads) {
        if (maxBytes < 0 || maxConcurrentLoads < 1) throw new IllegalArgumentException("Configuración de caché inválida");
        this.maxBytes = maxBytes;
        this.loadSlots = new Semaphore(maxConcurrentLoads, true);
    }

    public static GlobalImageCache configured() {
        long mib = setting("image.cache.mib", 64, 0, 1024);
        int concurrent = (int) setting("image.cache.loads", 4, 1, 32);
        return new GlobalImageCache(mib * 1024 * 1024, concurrent);
    }

    private static long setting(String name, long fallback, long min, long max) {
        String text = System.getProperty(name);
        if (text == null) return fallback;
        try {
            long value = Long.parseLong(text);
            if (value >= min && value <= max) return value;
        } catch (NumberFormatException ignored) { }
        throw new IllegalArgumentException(name + " debe ser un entero entre " + min + " y " + max);
    }

    public Payload getOrLoad(ImageCacheKey key, Loader loader) throws IOException {
        Objects.requireNonNull(key);
        Objects.requireNonNull(loader);
        CompletableFuture<Payload> future;
        synchronized (lock) {
            Entry hit = entries.get(key);
            if (hit != null) { hits++; hit.chances = CHANCES; return hit.payload; }
            future = loading.get(key);
            if (future != null) sharedLoads++;
        }
        if (future != null) return await(future);

        // Nunca esperar un permiso, leer disco o escribir sockets con lock tomado.
        acquireLoadSlot();
        boolean owner = false;
        try {
            synchronized (lock) {
                Entry hit = entries.get(key);
                if (hit != null) { hits++; hit.chances = CHANCES; return hit.payload; }
                future = loading.get(key);
                if (future == null) {
                    future = new CompletableFuture<>();
                    loading.put(key, future);
                    loads++;
                    owner = true;
                } else sharedLoads++;
            }
            if (owner) {
                try {
                    byte[] raw = loader.load();
                    if (raw == null || raw.length != key.bytes()) throw new IOException("Tamaño de carga inválido");
                    Payload payload = new Payload(raw);
                    synchronized (lock) { retain(key, payload); }
                    future.complete(payload);
                    return payload;
                } catch (IOException | RuntimeException | Error error) {
                    synchronized (lock) { failures++; }
                    future.completeExceptionally(error);
                    throw error;
                } finally {
                    synchronized (lock) { loading.remove(key, future); }
                }
            }
        } finally {
            loadSlots.release();
        }
        // Otro worker ganó la reserva mientras se esperaba el permiso.
        return await(future);
    }

    private void acquireLoadSlot() throws InterruptedIOException {
        try { loadSlots.acquire(); }
        catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new InterruptedIOException("Espera de preparación interrumpida");
        }
    }

    private Payload await(CompletableFuture<Payload> future) throws IOException {
        try { return future.get(); }
        catch (InterruptedException error) {
            // Cancelar un consumidor no cancela el trabajo compartido.
            Thread.currentThread().interrupt();
            throw new InterruptedIOException("Espera de caché interrumpida");
        } catch (ExecutionException error) {
            Throwable cause = error.getCause();
            if (cause instanceof IOException io) throw io;
            if (cause instanceof RuntimeException runtime) throw runtime;
            if (cause instanceof Error fatal) throw fatal;
            throw new IOException("Falló la preparación compartida", cause);
        }
    }

    // Se llama sólo bajo lock. El reloj es global; los tiles no se fijan por sesión.
    private void retain(ImageCacheKey key, Payload payload) {
        if (payload.length() > maxBytes) return; // incluye modo desactivado (0 MiB)
        while (bytes + payload.length() > maxBytes) {
            Entry candidate = hand;
            hand = hand.next;
            if (candidate.chances > 0) { candidate.chances--; continue; }
            if (candidate.next == candidate) hand = null;
            else {
                candidate.previous.next = candidate.next;
                candidate.next.previous = candidate.previous;
            }
            entries.remove(candidate.key);
            bytes -= candidate.payload.length();
            evictions++;
        }
        Entry entry = new Entry(key, payload);
        if (hand == null) { entry.previous = entry.next = entry; hand = entry; }
        else {
            entry.previous = hand.previous;
            entry.next = hand;
            hand.previous.next = entry;
            hand.previous = entry;
        }
        entries.put(key, entry);
        bytes += payload.length();
    }

    public record Stats(long maxBytes, long residentBytes, int entries, int loading,
                        long hits, long loads, long sharedLoads, long failures, long evictions) { }
    public Stats stats() {
        synchronized (lock) {
            return new Stats(maxBytes, bytes, entries.size(), loading.size(), hits, loads, sharedLoads, failures, evictions);
        }
    }
}
