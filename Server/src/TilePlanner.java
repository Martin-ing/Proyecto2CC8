import java.io.IOException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public class TilePlanner {
    public static final int VIEWPORT_TILES = 4;

    public List<TilePlanEntry> plan(
            ImageMeta image,
            int zoom,
            int currentX,
            int currentY
    ) throws IOException {
        if (image.tileSize() != 256) {
            throw new IOException("Esta fase del cliente espera tileSize=256 y la imagen usa "
                    + image.tileSize());
        }

        if (zoom < 1 || zoom > image.maxZoom()) {
            throw new IOException("Zoom inválido: " + zoom
                    + ". Para tiles se permite 1.." + image.maxZoom());
        }

        ImageLevel current = requireLevel(image, zoom);
        int currentTiles = tilesPerAxis(image, current);
        int maxStart = currentTiles - VIEWPORT_TILES;

        if (maxStart < 0) {
            throw new IOException("El nivel " + zoom
                    + " no alcanza para una ventana 4x4 de tiles");
        }

        if (currentX < 0 || currentY < 0
                || currentX > maxStart || currentY > maxStart) {
            throw new IOException("VIEWPORT fuera de rango para z=" + zoom
                    + ": currentX=" + currentX + ", currentY=" + currentY
                    + ", rango permitido 0.." + maxStart);
        }

        Map<TileId, TilePlanEntry> ordered = new LinkedHashMap<>();

        addGrid(ordered, image.id(), zoom, currentX, currentY,
                VIEWPORT_TILES, VIEWPORT_TILES, currentTiles, 1, "A_CURRENT");

        for (int x = currentX; x < currentX + VIEWPORT_TILES; x++) {
            addIfValid(ordered, image.id(), zoom, x, currentY - 1,
                    currentTiles, 2, "B_NEIGHBOR");
            addIfValid(ordered, image.id(), zoom, x, currentY + VIEWPORT_TILES,
                    currentTiles, 2, "B_NEIGHBOR");
        }
        for (int y = currentY; y < currentY + VIEWPORT_TILES; y++) {
            addIfValid(ordered, image.id(), zoom, currentX - 1, y,
                    currentTiles, 2, "B_NEIGHBOR");
            addIfValid(ordered, image.id(), zoom, currentX + VIEWPORT_TILES, y,
                    currentTiles, 2, "B_NEIGHBOR");
        }

        if (zoom < image.maxZoom()) {
            ImageLevel next = requireLevel(image, zoom + 1);
            validateAdjacentLevels(current, next, zoom, zoom + 1);
            int nextTiles = tilesPerAxis(image, next);

            int nextX = 2 * (currentX + 1);
            int nextY = 2 * (currentY + 1);

            addGrid(ordered, image.id(), zoom + 1, nextX, nextY,
                    VIEWPORT_TILES, VIEWPORT_TILES, nextTiles, 3, "D_NEXT");
        }

        if (zoom > 1) {
            ImageLevel previous = requireLevel(image, zoom - 1);
            validateAdjacentLevels(previous, current, zoom - 1, zoom);
            int previousTiles = tilesPerAxis(image, previous);

            int centerX = currentX * image.tileSize() + 2 * image.tileSize();
            int centerY = currentY * image.tileSize() + 2 * image.tileSize();

            int previousCenterX = centerX / 2;
            int previousCenterY = centerY / 2;

            int previousX = previousCenterX / image.tileSize() - 2;
            int previousY = previousCenterY / image.tileSize() - 2;

            previousX = clamp(previousX, 0, Math.max(0, previousTiles - VIEWPORT_TILES));
            previousY = clamp(previousY, 0, Math.max(0, previousTiles - VIEWPORT_TILES));

            addGrid(ordered, image.id(), zoom - 1, previousX, previousY,
                    VIEWPORT_TILES, VIEWPORT_TILES, previousTiles, 4, "C_PREVIOUS");
        }

        return new ArrayList<>(ordered.values());
    }

    private static ImageLevel requireLevel(ImageMeta image, int zoom) throws IOException {
        ImageLevel level = image.level(zoom);
        if (level == null) {
            throw new IOException("Falta level." + zoom + " en " + image.metaPath());
        }
        return level;
    }

    private static int tilesPerAxis(ImageMeta image, ImageLevel level) throws IOException {
        if (level.virtualSize() % image.tileSize() != 0) {
            throw new IOException("level." + level.zoom() + ".virtualSize="
                    + level.virtualSize() + " no es divisible entre tileSize=" + image.tileSize());
        }
        return level.virtualSize() / image.tileSize();
    }

    private static void validateAdjacentLevels(
            ImageLevel smaller,
            ImageLevel larger,
            int smallerZoom,
            int largerZoom
    ) throws IOException {
        if ((long) smaller.virtualSize() * 2 != larger.virtualSize()) {
            throw new IOException("La jerarquía requiere que level." + largerZoom
                    + " tenga el doble de virtualSize que level." + smallerZoom);
        }
    }

    private static void addGrid(
            Map<TileId, TilePlanEntry> ordered,
            String imageId,
            int zoom,
            int startX,
            int startY,
            int width,
            int height,
            int tilesPerAxis,
            int priority,
            String group
    ) {
        for (int y = startY; y < startY + height; y++) {
            for (int x = startX; x < startX + width; x++) {
                addIfValid(ordered, imageId, zoom, x, y,
                        tilesPerAxis, priority, group);
            }
        }
    }

    private static void addIfValid(
            Map<TileId, TilePlanEntry> ordered,
            String imageId,
            int zoom,
            int x,
            int y,
            int tilesPerAxis,
            int priority,
            String group
    ) {
        if (x < 0 || y < 0 || x >= tilesPerAxis || y >= tilesPerAxis) {
            return;
        }

        TileId id = new TileId(imageId, zoom, x, y);
        ordered.putIfAbsent(id, new TilePlanEntry(id, priority, group));
    }

    private static int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(max, value));
    }
}
