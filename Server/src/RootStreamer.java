import java.io.EOFException;
import java.io.IOException;
import java.io.RandomAccessFile;

public class RootStreamer {
    private static final int BYTES_PER_RGBA8888_PIXEL = 4;
    private static final int CHUNK_SIZE = 64 * 1024;
    private final GlobalImageCache cache;

    public RootStreamer(GlobalImageCache cache) { this.cache = cache; }

    public void stream(
            String requestId,
            ImageMeta image,
            PixelFormat format,
            WebSocketConnection connection
    ) throws IOException {
        ImageLevel level = image.rootLevel();
        if (level == null) {
            throw new IOException("La imagen no tiene level 0");
        }

        int rootSize = level.virtualSize();

        if (rootSize != image.level0Size()) {
            throw new IOException("level.0.virtualSize (" + rootSize
                    + ") no coincide con level0Size (" + image.level0Size() + ")");
        }

        long expectedRawBytes = (long) level.width()
                * level.height()
                * BYTES_PER_RGBA8888_PIXEL;

        ImageCacheKey.SourceVersion source = ImageCacheKey.SourceVersion.capture(level.rawPath());
        long actualRawBytes = source.size();
        if (actualRawBytes < expectedRawBytes) {
            throw new IOException("RAW incompleto: se esperaban al menos " + expectedRawBytes
                    + " bytes y hay " + actualRawBytes);
        }

        int bytesPerPixel = format.bytesPerPixel();
        int bytesPerVirtualRow = rootSize * bytesPerPixel;

        if (bytesPerVirtualRow > CHUNK_SIZE) {
            throw new IOException("ROOT demasiado ancho para el esquema actual de chunks de 64 KiB: "
                    + rootSize + " píxeles en " + format.protocolName());
        }

        // level0Size es potencia de dos y los dos formatos usan 2 o 4 bytes/píxel,
        // por lo que para los tamaños previstos cada chunk contiene filas completas.
        int rowsPerChunk = CHUNK_SIZE / bytesPerVirtualRow;
        if (rowsPerChunk <= 0 || CHUNK_SIZE % bytesPerVirtualRow != 0) {
            throw new IOException("El ancho de ROOT no permite dividir la transmisión en chunks "
                    + "de 64 KiB con filas completas para " + format.protocolName());
        }

        long rootBytesLong = (long) rootSize * rootSize * bytesPerPixel;
        if (rootBytesLong > Integer.MAX_VALUE) {
            throw new IOException("ROOT demasiado grande para esta implementación");
        }

        int rootBytes = (int) rootBytesLong;
        int chunkCount = (rootBytes + CHUNK_SIZE - 1) / CHUNK_SIZE;

        // Evita que una ROOT se intercale con una secuencia TILE_* si el usuario
        // cambia de imagen mientras todavía hay tiles pendientes.
        synchronized (connection) {
            connection.sendText(
                    "ROOT_START " + requestId + " " + image.id()
                            + " " + rootSize + " " + rootSize
                            + " " + format.protocolName()
                            + " " + CHUNK_SIZE + " " + chunkCount
            );

            for (int chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
                int index = chunkIndex;
                int dataLength = Math.min(CHUNK_SIZE, rootBytes - index * CHUNK_SIZE);
                ImageCacheKey key = ImageCacheKey.of(image, level, source, format,
                        "ROOT_CHUNK", index, 0, dataLength);
                GlobalImageCache.Payload payload = cache.getOrLoad(key, () ->
                        buildChunk(level, source, format, rootSize, rowsPerChunk,
                                bytesPerVirtualRow, index, dataLength));
                connection.sendText(
                        "ROOT_DATA " + requestId + " " + index + " " + dataLength
                );
                payload.sendTo(connection);
            }

            connection.sendText("ROOT_END " + requestId);
        }
    }

    private static byte[] buildChunk(
            ImageLevel level, ImageCacheKey.SourceVersion source, PixelFormat format,
            int rootSize, int rowsPerChunk, int bytesPerVirtualRow, int index, int length
    ) throws IOException {
        source.verifyUnchanged();
        byte[] chunk = new byte[length];
        byte[] rawRow = new byte[level.width() * BYTES_PER_RGBA8888_PIXEL];
        int startVirtualY = index * rowsPerChunk;
        int rows = Math.min(rowsPerChunk, rootSize - startVirtualY);
        try (RandomAccessFile raw = new RandomAccessFile(source.path().toFile(), "r")) {
            for (int localRow = 0; localRow < rows; localRow++) {
                int realY = startVirtualY + localRow - level.offsetY();
                if (realY < 0 || realY >= level.height()) continue;
                raw.seek((long) realY * level.width() * BYTES_PER_RGBA8888_PIXEL);
                readFully(raw, rawRow);
                int destinationOffset = localRow * bytesPerVirtualRow;
                if (format == PixelFormat.RGBA8888) {
                    copyRgba8888Row(rawRow, chunk, destinationOffset, level, rootSize);
                } else {
                    convertRowToRgba4444(rawRow, chunk, destinationOffset, level, rootSize);
                }
            }
        }
        source.verifyUnchanged();
        return chunk;
    }

    private static void copyRgba8888Row(
            byte[] rawRow,
            byte[] chunk,
            int destinationRowOffset,
            ImageLevel level,
            int rootSize
    ) {
        int sourceStartX = Math.max(0, -level.offsetX());
        int destinationStartX = Math.max(0, level.offsetX());
        int pixelsToCopy = Math.min(
                level.width() - sourceStartX,
                rootSize - destinationStartX
        );

        if (pixelsToCopy <= 0) {
            return;
        }

        System.arraycopy(
                rawRow,
                sourceStartX * BYTES_PER_RGBA8888_PIXEL,
                chunk,
                destinationRowOffset + destinationStartX * BYTES_PER_RGBA8888_PIXEL,
                pixelsToCopy * BYTES_PER_RGBA8888_PIXEL
        );
    }

    private static void convertRowToRgba4444(
            byte[] rawRow,
            byte[] chunk,
            int destinationRowOffset,
            ImageLevel level,
            int rootSize
    ) {
        for (int realX = 0; realX < level.width(); realX++) {
            int virtualX = level.offsetX() + realX;
            if (virtualX < 0 || virtualX >= rootSize) {
                continue;
            }

            int src = realX * BYTES_PER_RGBA8888_PIXEL;
            int r = rawRow[src] & 0xFF;
            int g = rawRow[src + 1] & 0xFF;
            int b = rawRow[src + 2] & 0xFF;
            int a = rawRow[src + 3] & 0xFF;

            int packed = ((r >>> 4) << 12)
                    | ((g >>> 4) << 8)
                    | ((b >>> 4) << 4)
                    | (a >>> 4);

            int dst = destinationRowOffset + virtualX * PixelFormat.RGBA4444.bytesPerPixel();
            chunk[dst] = (byte) ((packed >>> 8) & 0xFF);
            chunk[dst + 1] = (byte) (packed & 0xFF);
        }
    }

    private static void readFully(RandomAccessFile file, byte[] buffer) throws IOException {
        int offset = 0;
        while (offset < buffer.length) {
            int read = file.read(buffer, offset, buffer.length - offset);
            if (read < 0) {
                throw new EOFException("Fin inesperado del RAW");
            }
            offset += read;
        }
    }
}
