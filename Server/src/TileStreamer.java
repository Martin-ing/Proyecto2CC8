import java.io.EOFException;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.util.Arrays;
import java.util.List;
import java.util.function.BooleanSupplier;

/**
 * Transmite un conjunto de tiles de un mismo nivel como un único stream lógico.
 *
 * Framing:
 *   TILE_STREAM_START ... <count> <x1,y1> <x2,y2> ...
 *   <frame binario de 128 KiB: tile 1 completo>
 *   <frame binario de 128 KiB: tile 2 completo>
 *   ...
 *   TILE_STREAM_END <streamId> <sentCount>
 *
 * Los tiles preparados se reutilizan mediante la caché global. Nunca se
 * acumula un stream completo por usuario en RAM.
 */
public class TileStreamer {
    private static final int RAW_BYTES_PER_PIXEL = 4;
    private static final PixelFormat TILE_FORMAT = PixelFormat.RGBA4444;
    private final GlobalImageCache cache;

    public TileStreamer(GlobalImageCache cache) { this.cache = cache; }

    public int stream(
            String streamId,
            String viewId,
            ImageMeta image,
            DataChannel channel,
            List<TileId> tiles,
            WebSocketConnection connection,
            BooleanSupplier shouldContinue
    ) throws IOException {
        if (tiles.isEmpty()) {
            return 0;
        }

        int zoom = tiles.getFirst().zoom();
        for (TileId tile : tiles) {
            if (tile.zoom() != zoom || !tile.imageId().equals(image.id())) {
                throw new IOException("Todos los tiles de un stream deben pertenecer a la misma imagen y nivel");
            }
        }

        ImageLevel level = image.level(zoom);
        if (level == null) {
            throw new IOException("No existe level." + zoom);
        }

        int tileSize = image.tileSize();
        if (tileSize != 256) {
            throw new IOException("Esta fase requiere tileSize=256");
        }

        int tilesPerAxis = level.virtualSize() / tileSize;
        for (TileId tile : tiles) {
            if (tile.tileX() < 0 || tile.tileY() < 0
                    || tile.tileX() >= tilesPerAxis || tile.tileY() >= tilesPerAxis) {
                throw new IOException("Tile fuera de rango: " + tile);
            }
        }

        long expectedRawBytes = (long) level.width() * level.height() * RAW_BYTES_PER_PIXEL;
        ImageCacheKey.SourceVersion source = ImageCacheKey.SourceVersion.capture(level.rawPath());
        long actualRawBytes = source.size();
        if (actualRawBytes < expectedRawBytes) {
            throw new IOException("RAW incompleto para level." + zoom + ": se esperaban al menos "
                    + expectedRawBytes + " bytes y hay " + actualRawBytes);
        }

        int tileBytes = tileSize * tileSize * TILE_FORMAT.bytesPerPixel();

        StringBuilder start = new StringBuilder();
        start.append("TILE_STREAM_START ")
                .append(streamId).append(' ')
                .append(viewId).append(' ')
                .append(image.id()).append(' ')
                .append(channel.name()).append(' ')
                .append(zoom).append(' ')
                .append(TILE_FORMAT.protocolName()).append(' ')
                .append(tileSize).append(' ')
                .append(tileBytes).append(' ')
                .append(tiles.size());

        for (TileId tile : tiles) {
            start.append(' ')
                    .append(tile.tileX())
                    .append(',')
                    .append(tile.tileY());
        }

        connection.sendText(start.toString());

        int sentCount = 0;
        for (TileId tile : tiles) {
            if (!shouldContinue.getAsBoolean()) {
                break;
            }

            ImageCacheKey key = ImageCacheKey.of(image, level, source, TILE_FORMAT,
                    "TILE", tile.tileX(), tile.tileY(), tileBytes);
            GlobalImageCache.Payload payload = cache.getOrLoad(key, () -> {
                source.verifyUnchanged();
                byte[] tileBuffer = new byte[tileBytes];
                byte[] rawSpan = new byte[tileSize * RAW_BYTES_PER_PIXEL];
                try (RandomAccessFile raw = new RandomAccessFile(source.path().toFile(), "r")) {
                    fillTile(raw, image, level, tile, tileBuffer, rawSpan);
                }
                source.verifyUnchanged();
                return tileBuffer;
            });
            payload.sendTo(connection);
            sentCount++;
        }

        connection.sendText("TILE_STREAM_END " + streamId + " " + sentCount);
        return sentCount;
    }

    private static void fillTile(
            RandomAccessFile raw,
            ImageMeta image,
            ImageLevel level,
            TileId tile,
            byte[] destination,
            byte[] rawSpan
    ) throws IOException {
        Arrays.fill(destination, (byte) 0);

        int tileSize = image.tileSize();
        int outputBytesPerPixel = TILE_FORMAT.bytesPerPixel();
        int bytesPerTileRow = tileSize * outputBytesPerPixel;
        int virtualStartX = tile.tileX() * tileSize;

        for (int tileRow = 0; tileRow < tileSize; tileRow++) {
            int virtualY = tile.tileY() * tileSize + tileRow;
            int realY = virtualY - level.offsetY();

            if (realY < 0 || realY >= level.height()) {
                continue;
            }

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
            int destinationRowOffset = tileRow * bytesPerTileRow;

            convertSpanToRgba4444(
                    rawSpan,
                    pixelsToRead,
                    destination,
                    destinationRowOffset + destinationStartX * outputBytesPerPixel
            );
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
