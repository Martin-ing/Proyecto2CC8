import java.io.BufferedReader;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;

public record ImageMeta(
        String id,
        String name,
        int originalWidth,
        int originalHeight,
        int virtualSize,
        int tileSize,
        int level0Size,
        int maxZoom,
        Path metaPath,
        Map<Integer, ImageLevel> levels
) {
    public ImageMeta {
        levels = Map.copyOf(levels);
    }

    public static ImageMeta fromFile(Path metaPath) throws IOException {
        Map<String, String> values = readValues(metaPath);

        String fallbackId = metaPath.getParent().getFileName().toString();
        String id = cleanProtocolField(values.getOrDefault("id", fallbackId));
        String name = cleanProtocolField(values.getOrDefault("name", id));

        // El protocolo nuevo usa originalWidth/originalHeight. Se conservan
        // width/height como fallback para no romper metadatos de pruebas viejas.
        int originalWidth = parsePositiveIntWithFallback(values, "originalWidth", "width", metaPath);
        int originalHeight = parsePositiveIntWithFallback(values, "originalHeight", "height", metaPath);

        int virtualSize = values.containsKey("virtualSize")
                ? parsePositiveInt(values, "virtualSize", metaPath)
                : nextPowerOfTwo(Math.max(originalWidth, originalHeight));

        int tileSize = values.containsKey("tileSize")
                ? parsePositiveInt(values, "tileSize", metaPath)
                : 256;

        // La versión más nueva del conversor usa level0Size; una versión anterior
        // del documento lo llamó rootSize. Aceptamos ambos nombres.
        int level0Size;
        if (values.containsKey("level0Size")) {
            level0Size = parsePositiveInt(values, "level0Size", metaPath);
        } else if (values.containsKey("rootSize")) {
            level0Size = parsePositiveInt(values, "rootSize", metaPath);
        } else {
            level0Size = 1024;
        }

        int maxZoom = values.containsKey("maxZoom")
                ? parseNonNegativeInt(values, "maxZoom", metaPath)
                : calculateMaxZoom(virtualSize, level0Size);

        Map<Integer, ImageLevel> levels = new HashMap<>();
        for (int zoom = 0; zoom <= maxZoom; zoom++) {
            String prefix = "level." + zoom + ".";
            String fileKey = prefix + "file";

            if (!values.containsKey(fileKey)) {
                // Para esta primera fase ROOT solo exige level 0. Los demás niveles
                // podrán validarse estrictamente cuando implementemos VIEWPORT/tiles.
                if (zoom == 0) {
                    throw new IOException("Falta el campo '" + fileKey + "' en " + metaPath);
                }
                continue;
            }

            String fileName = values.get(fileKey).trim();
            if (fileName.isEmpty()) {
                throw new IOException("El campo '" + fileKey + "' está vacío en " + metaPath);
            }

            int levelVirtualSize = parsePositiveInt(values, prefix + "virtualSize", metaPath);
            int levelWidth = parsePositiveInt(values, prefix + "width", metaPath);
            int levelHeight = parsePositiveInt(values, prefix + "height", metaPath);
            int offsetX = parseNonNegativeInt(values, prefix + "offsetX", metaPath);
            int offsetY = parseNonNegativeInt(values, prefix + "offsetY", metaPath);

            if (levelWidth > levelVirtualSize || levelHeight > levelVirtualSize) {
                throw new IOException("Las dimensiones reales del nivel " + zoom
                        + " exceden su virtualSize en " + metaPath);
            }

            if ((long) offsetX + levelWidth > levelVirtualSize
                    || (long) offsetY + levelHeight > levelVirtualSize) {
                throw new IOException("Los offsets del nivel " + zoom
                        + " colocan la imagen fuera del espacio virtual en " + metaPath);
            }

            Path rawPath = metaPath.getParent().resolve(fileName).normalize();
            if (!rawPath.startsWith(metaPath.getParent().normalize())) {
                throw new IOException("Ruta de nivel inválida en " + metaPath + ": " + fileName);
            }
            if (!Files.isRegularFile(rawPath)) {
                throw new IOException("No existe el RAW del nivel " + zoom + ": " + rawPath);
            }

            levels.put(zoom, new ImageLevel(
                    zoom,
                    fileName,
                    levelVirtualSize,
                    levelWidth,
                    levelHeight,
                    offsetX,
                    offsetY,
                    rawPath
            ));
        }

        ImageLevel level0 = levels.get(0);
        if (level0.virtualSize() != level0Size) {
            throw new IOException("level.0.virtualSize (" + level0.virtualSize()
                    + ") no coincide con level0Size/rootSize (" + level0Size + ") en " + metaPath);
        }

        return new ImageMeta(
                id,
                name,
                originalWidth,
                originalHeight,
                virtualSize,
                tileSize,
                level0Size,
                maxZoom,
                metaPath,
                levels
        );
    }

    public ImageLevel level(int zoom) {
        return levels.get(zoom);
    }

    public ImageLevel rootLevel() {
        return levels.get(0);
    }

    public String toProtocolLine() {
        return id + "|" + name + "|" + originalWidth + "|" + originalHeight
                + "|" + virtualSize + "|" + maxZoom;
    }

    private static Map<String, String> readValues(Path metaPath) throws IOException {
        Map<String, String> values = new HashMap<>();

        try (BufferedReader reader = Files.newBufferedReader(metaPath, StandardCharsets.UTF_8)) {
            String line;
            while ((line = reader.readLine()) != null) {
                line = line.trim();
                if (line.isEmpty() || line.startsWith("#")) {
                    continue;
                }

                int separator = line.indexOf('=');
                if (separator <= 0) {
                    throw new IOException("Línea inválida en " + metaPath + ": " + line);
                }

                String key = line.substring(0, separator).trim();
                String value = line.substring(separator + 1).trim();
                values.put(key, value);
            }
        }

        return values;
    }

    private static int parsePositiveIntWithFallback(
            Map<String, String> values,
            String preferredKey,
            String fallbackKey,
            Path path
    ) throws IOException {
        if (values.containsKey(preferredKey)) {
            return parsePositiveInt(values, preferredKey, path);
        }
        return parsePositiveInt(values, fallbackKey, path);
    }

    private static int parsePositiveInt(Map<String, String> values, String key, Path path)
            throws IOException {
        int value = parseInt(values, key, path);
        if (value <= 0) {
            throw new IOException(key + " debe ser mayor que 0 en " + path);
        }
        return value;
    }

    private static int parseNonNegativeInt(Map<String, String> values, String key, Path path)
            throws IOException {
        int value = parseInt(values, key, path);
        if (value < 0) {
            throw new IOException(key + " no puede ser negativo en " + path);
        }
        return value;
    }

    private static int parseInt(Map<String, String> values, String key, Path path)
            throws IOException {
        String text = values.get(key);
        if (text == null) {
            throw new IOException("Falta el campo '" + key + "' en " + path);
        }

        try {
            return Integer.parseInt(text);
        } catch (NumberFormatException e) {
            throw new IOException("El campo '" + key + "' no es un entero válido en " + path, e);
        }
    }

    private static int nextPowerOfTwo(int value) throws IOException {
        if (value <= 0) {
            throw new IOException("Dimensión inválida: " + value);
        }

        int power = 1;
        while (power < value) {
            if (power > (1 << 30)) {
                throw new IOException("La dimensión es demasiado grande para representarse con int");
            }
            power <<= 1;
        }
        return power;
    }

    private static int calculateMaxZoom(int virtualSize, int level0Size) throws IOException {
        if (virtualSize < level0Size || virtualSize % level0Size != 0) {
            throw new IOException("virtualSize debe ser múltiplo de level0Size");
        }

        int ratio = virtualSize / level0Size;
        int zoom = 0;
        while (ratio > 1) {
            if ((ratio & 1) != 0) {
                throw new IOException("virtualSize/level0Size debe ser potencia de dos");
            }
            ratio >>= 1;
            zoom++;
        }
        return zoom;
    }

    private static String cleanProtocolField(String value) {
        return value.replace('|', '_').replace('\n', ' ').replace('\r', ' ').trim();
    }
}
