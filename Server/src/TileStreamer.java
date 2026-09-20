import java.io.EOFException;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.file.Files;
import java.util.Arrays;

public class TileStreamer {
    private static final int RAW_BYTES_PER_PIXEL = 4;
    private static final int CHUNK_SIZE = 64 * 1024;
    private static final PixelFormat TILE_FORMAT = PixelFormat.RGBA4444;

    public void stream(
            String tileRequestId,
            String viewId,
            ImageMeta image,
            TileId tile,
            WebSocketConnection connection
    ) throws IOException {
        ImageLevel level = image.level(tile.zoom());
        if (level == null) {
            throw new IOException("No existe level." + tile.zoom());
        }

        int tileSize = image.tileSize();
        if (tileSize != 256) {
            throw new IOException("Esta fase requiere tileSize=256");
        }

        int tilesPerAxis = level.virtualSize() / tileSize;
        if (tile.tileX() < 0 || tile.tileY() < 0
                || tile.tileX() >= tilesPerAxis || tile.tileY() >= tilesPerAxis) {
            throw new IOException("Tile fuera de rango: " + tile);
        }

        long expectedRawBytes = (long) level.width() * level.height() * RAW_BYTES_PER_PIXEL;
        long actualRawBytes = Files.size(level.rawPath());
        if (actualRawBytes < expectedRawBytes) {
            throw new IOException("RAW incompleto para " + tile + ": se esperaban al menos "
                    + expectedRawBytes + " bytes y hay " + actualRawBytes);
        }

        int outputBytesPerPixel = TILE_FORMAT.bytesPerPixel();
        int bytesPerTileRow = tileSize * outputBytesPerPixel;
        if (CHUNK_SIZE % bytesPerTileRow != 0) {
            throw new IOException("chunkSize no contiene un número entero de filas del tile");
        }

        int rowsPerChunk = CHUNK_SIZE / bytesPerTileRow;
        int tileBytes = tileSize * tileSize * outputBytesPerPixel;
        int chunkCount = (tileBytes + CHUNK_SIZE - 1) / CHUNK_SIZE;

        byte[] chunk = new byte[CHUNK_SIZE];
        byte[] rawSpan = new byte[tileSize * RAW_BYTES_PER_PIXEL];

        // Bloqueamos la secuencia completa TILE_START/DATA/binario/END para que
        // no se intercale con ROOT u otro envío de la misma conexión.
        synchronized (connection) {
            connection.sendText(
                    "TILE_START " + tileRequestId
                            + " " + viewId
                            + " " + image.id()
                            + " " + tile.zoom()
                            + " " + tile.tileX()
                            + " " + tile.tileY()
                            + " " + tileSize
                            + " " + tileSize
                            + " " + TILE_FORMAT.protocolName()
                            + " " + CHUNK_SIZE
                            + " " + chunkCount
            );

            try (RandomAccessFile raw = new RandomAccessFile(level.rawPath().toFile(), "r")) {
                for (int chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
                    Arrays.fill(chunk, (byte) 0);

                    int startTileRow = chunkIndex * rowsPerChunk;
                    int rowsThisChunk = Math.min(rowsPerChunk, tileSize - startTileRow);

                    for (int localRow = 0; localRow < rowsThisChunk; localRow++) {
                        int tileRow = startTileRow + localRow;
                        int virtualY = tile.tileY() * tileSize + tileRow;
                        int realY = virtualY - level.offsetY();

                        if (realY < 0 || realY >= level.height()) {
                            continue;
                        }

                        int virtualStartX = tile.tileX() * tileSize;
                        int realStartX = Math.max(0, virtualStartX - level.offsetX());
                        int realEndX = Math.min(
                                level.width(),
                                virtualStartX + tileSize - level.offsetX()
                        );

                        int pixelsToRead = realEndX - realStartX;
                        if (pixelsToRead <= 0) {
                            continue;
                        }

                        long byteOffset = ((long) realY * level.width() + realStartX)
                                * RAW_BYTES_PER_PIXEL;
                        raw.seek(byteOffset);

                        int bytesToRead = pixelsToRead * RAW_BYTES_PER_PIXEL;
                        readFully(raw, rawSpan, bytesToRead);

                        int firstVirtualX = level.offsetX() + realStartX;
                        int destinationStartX = firstVirtualX - virtualStartX;
                        int destinationRowOffset = localRow * bytesPerTileRow;

                        convertSpanToRgba4444(
                                rawSpan,
                                pixelsToRead,
                                chunk,
                                destinationRowOffset + destinationStartX * outputBytesPerPixel
                        );
                    }

                    int dataLength = Math.min(CHUNK_SIZE, tileBytes - chunkIndex * CHUNK_SIZE);
                    connection.sendText(
                            "TILE_DATA " + tileRequestId + " " + chunkIndex + " " + dataLength
                    );
                    connection.sendBinary(chunk, 0, dataLength);
                }
            }

            connection.sendText("TILE_END " + tileRequestId);
        }
    }

    private static void convertSpanToRgba4444(
            byte[] raw,
            int pixelCount,
            byte[] destination,
            int destinationOffset
    ) {
        for (int pixel = 0; pixel < pixelCount; pixel++) {
            int src = pixel * RAW_BYTES_PER_PIXEL;
            int r = raw[src] & 0xFF;
            int g = raw[src + 1] & 0xFF;
            int b = raw[src + 2] & 0xFF;
            int a = raw[src + 3] & 0xFF;

            int packed = ((r >>> 4) << 12)
                    | ((g >>> 4) << 8)
                    | ((b >>> 4) << 4)
                    | (a >>> 4);

            int dst = destinationOffset + pixel * 2;
            destination[dst] = (byte) ((packed >>> 8) & 0xFF);
            destination[dst + 1] = (byte) (packed & 0xFF);
        }
    }

    private static void readFully(RandomAccessFile file, byte[] buffer, int length)
            throws IOException {
        int offset = 0;
        while (offset < length) {
            int read = file.read(buffer, offset, length - offset);
            if (read < 0) {
                throw new EOFException("Fin inesperado del RAW");
            }
            offset += read;
        }
    }
}
