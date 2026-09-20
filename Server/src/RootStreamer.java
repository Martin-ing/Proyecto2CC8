import java.io.EOFException;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.file.Files;
import java.util.Arrays;

public class RootStreamer {
    private static final int BYTES_PER_RGBA8888_PIXEL = 4;
    private static final int CHUNK_SIZE = 64 * 1024;

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

        long actualRawBytes = Files.size(level.rawPath());
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

        connection.sendText(
                "ROOT_START " + requestId + " " + image.id()
                        + " " + rootSize + " " + rootSize
                        + " " + format.protocolName()
                        + " " + CHUNK_SIZE + " " + chunkCount
        );

        byte[] chunk = new byte[CHUNK_SIZE];
        byte[] rawRow = new byte[level.width() * BYTES_PER_RGBA8888_PIXEL];

        try (RandomAccessFile raw = new RandomAccessFile(level.rawPath().toFile(), "r")) {
            for (int chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
                Arrays.fill(chunk, (byte) 0);

                int startVirtualY = chunkIndex * rowsPerChunk;
                int rowsInThisChunk = Math.min(rowsPerChunk, rootSize - startVirtualY);

                for (int localRow = 0; localRow < rowsInThisChunk; localRow++) {
                    int virtualY = startVirtualY + localRow;
                    int realY = virtualY - level.offsetY();

                    if (realY < 0 || realY >= level.height()) {
                        continue;
                    }

                    long rowOffset = (long) realY
                            * level.width()
                            * BYTES_PER_RGBA8888_PIXEL;
                    raw.seek(rowOffset);
                    readFully(raw, rawRow);

                    int destinationRowOffset = localRow * bytesPerVirtualRow;

                    if (format == PixelFormat.RGBA8888) {
                        copyRgba8888Row(
                                rawRow,
                                chunk,
                                destinationRowOffset,
                                level,
                                rootSize
                        );
                    } else {
                        convertRowToRgba4444(
                                rawRow,
                                chunk,
                                destinationRowOffset,
                                level,
                                rootSize
                        );
                    }
                }

                int dataLength = Math.min(CHUNK_SIZE, rootBytes - chunkIndex * CHUNK_SIZE);
                connection.sendText(
                        "ROOT_DATA " + requestId + " " + chunkIndex + " " + dataLength
                );
                connection.sendBinary(chunk, 0, dataLength);
            }
        }

        connection.sendText("ROOT_END " + requestId);
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
