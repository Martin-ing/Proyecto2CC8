import javax.imageio.ImageIO;
import javax.imageio.ImageReadParam;
import javax.imageio.ImageReader;
import javax.imageio.stream.FileImageInputStream;
import javax.imageio.stream.ImageInputStream;
import javax.swing.JFileChooser;
import javax.swing.filechooser.FileNameExtensionFilter;
import java.awt.Rectangle;
import java.awt.image.BufferedImage;
import java.io.File;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;

/**
 * Conversor incremental JPG/PNG/TIFF/BigTIFF -> pirámide RAW RGBA8888 + META.
 *
 * Estructura esperada:
 *
 * proyecto/
 *   converter/
 *     ImageToRawConverter.java
 *   Imagenes/
 *     Images/
 *       <imagen>/
 *         level0.raw
 *         level1.raw
 *         ...
 *         <imagen>.meta
 *
 * En esta versión:
 * - level0 representa el nivel más general, con tamaño virtual cercano a 1024x1024.
 * - levelN representa la imagen original en su resolución máxima.
 * - cada nivel duplica el tamaño virtual respecto al anterior hasta llegar al virtualSize original.
 *
 * El conversor está diseñado para no cargar la imagen completa en RAM.
 * Para TIFF/BigTIFF muy grandes se recomienda TwelveMonkeys ImageIO TIFF.
 */
public class ImageToRawConverter {

    private static final int TILE_SIZE = 256;
    private static final int TARGET_LEVEL0_VIRTUAL_SIZE = 1024;

    // Buffer físico de escritura del .raw.
    private static final int OUTPUT_BUFFER_SIZE = 64 * 1024;

    // Scratch para convertir pequeños tramos de una fila.
    private static final int PIXEL_SCRATCH_PIXELS = 16 * 1024;

    /*
     * Presupuesto aproximado del BufferedImage temporal usado para
     * decodificar una región. El tamaño total de la imagen no afecta
     * directamente este límite.
     */
    private static final long DECODE_BLOCK_BUDGET = 32L * 1024L * 1024L;

    /*
     * Estimación conservadora: algunos TIFF pueden ser de 16 bits por
     * canal antes de convertirse a RGBA8888.
     */
    private static final long DECODE_BUDGET_BYTES_PER_PIXEL = 8L;

    private static final int MAX_ROWS_PER_REGION = 256;
    private static final long MIN_FREE_SPACE_MARGIN = 128L * 1024L * 1024L;

    private static int imageSequence = 1;

    public static void main(String[] args) {
        try {
            ImageIO.setUseCache(false);
            ImageIO.scanForPlugins();

            Path outputRoot = resolveOutputRoot();
            Files.createDirectories(outputRoot);

            System.out.println("Directorio de salida: " + outputRoot);

            if (args.length > 0) {
                for (String arg : args) {
                    convertImage(Paths.get(arg), outputRoot);
                }
                return;
            }

            JFileChooser chooser = new JFileChooser();
            chooser.setDialogTitle("Seleccionar imágenes JPG, PNG, TIFF o BigTIFF");
            chooser.setMultiSelectionEnabled(true);
            chooser.setFileFilter(
                    new FileNameExtensionFilter(
                            "Imágenes JPG/PNG/TIFF",
                            "jpg", "jpeg", "png", "tif", "tiff"
                    )
            );

            int result = chooser.showOpenDialog(null);

            if (result != JFileChooser.APPROVE_OPTION) {
                System.out.println("No se seleccionaron imágenes.");
                return;
            }

            File[] files = chooser.getSelectedFiles();

            if (files.length == 0 && chooser.getSelectedFile() != null) {
                files = new File[]{chooser.getSelectedFile()};
            }

            for (File file : files) {
                convertImage(file.toPath(), outputRoot);
            }

        } catch (Exception e) {
            System.err.println("Error general: " + e.getMessage());
            e.printStackTrace();
        }
    }

    /**
     * Si el programa se ejecuta desde la carpeta converter, usa la carpeta
     * hermana Imagenes/Images. Si se ejecuta desde la raíz del proyecto,
     * usa ./Imagenes/Images.
     */
    private static Path resolveOutputRoot() {
        Path cwd = Paths.get("").toAbsolutePath().normalize();
        Path currentName = cwd.getFileName();

        if (currentName != null
                && currentName.toString().equalsIgnoreCase("converter")
                && cwd.getParent() != null) {
            return cwd.getParent()
                    .resolve("Imagenes")
                    .resolve("Images")
                    .normalize();
        }

        return cwd.resolve("Imagenes")
                .resolve("Images")
                .normalize();
    }

    private static synchronized String nextImageId() {
        String id = String.format(Locale.US, "IMG%03d", imageSequence);
        imageSequence++;
        return id;
    }

    private static void convertImage(Path inputPath, Path outputRoot) {
        inputPath = inputPath.toAbsolutePath().normalize();

        System.out.println();
        System.out.println("============================================================");
        System.out.println("Procesando: " + inputPath);
        System.out.println("============================================================");

        if (!Files.isRegularFile(inputPath)) {
            System.err.println("El archivo no existe: " + inputPath);
            return;
        }

        String originalName = inputPath.getFileName().toString();
        String displayName = removeExtension(originalName);
        String extension = getExtension(originalName).toLowerCase(Locale.ROOT);

        if (!isSupportedExtension(extension)) {
            System.err.println(
                    "Formato no soportado. Solo se permiten JPG, JPEG, PNG, TIF y TIFF."
            );
            return;
        }

        boolean tiffByExtension = extension.equals("tif") || extension.equals("tiff");
        boolean bigTiff = false;

        try {
            if (tiffByExtension) {
                bigTiff = isBigTiff(inputPath);
            }
        } catch (IOException e) {
            System.err.println("No fue posible inspeccionar la cabecera TIFF: " + e.getMessage());
            return;
        }

        String baseName = sanitizeName(displayName);
        Path imageDirectory = null;

        try {
            imageDirectory = createUniqueDirectory(outputRoot, baseName);
            Path metaPath = imageDirectory.resolve(baseName + ".meta");

            try (ImageInputStream input = new FileImageInputStream(inputPath.toFile())) {

                ImageReader reader = selectReader(input);

                if (reader == null) {
                    if (bigTiff) {
                        throw new IOException(
                                "No se encontró un ImageReader compatible con BigTIFF. " +
                                "Agrega TwelveMonkeys ImageIO TIFF al classpath."
                        );
                    }

                    throw new IOException(
                            "No se encontró un ImageReader compatible con el archivo."
                    );
                }

                String readerClass = reader.getClass().getName();
                String readerFormat;

                try {
                    readerFormat = reader.getFormatName();
                } catch (IOException e) {
                    readerFormat = extension;
                }

                System.out.println("Reader:       " + readerClass);
                System.out.println("Formato:      " + readerFormat);
                System.out.println("BigTIFF:      " + bigTiff);

                if (bigTiff && !isTwelveMonkeysReader(reader)) {
                    reader.dispose();
                    throw new IOException(
                            "El archivo es BigTIFF, pero el lector activo no es TwelveMonkeys. " +
                            "Agrega TwelveMonkeys ImageIO TIFF al proyecto."
                    );
                }

                input.seek(0);
                reader.setInput(input, false, false);

                try {
                    int originalWidth = reader.getWidth(0);
                    int originalHeight = reader.getHeight(0);

                    if (originalWidth <= 0 || originalHeight <= 0) {
                        throw new IOException("Dimensiones de imagen inválidas.");
                    }

                    long originalVirtualSize = nextPowerOfTwo((long) Math.max(originalWidth, originalHeight));
                    int maxZoom = calculateMaxZoom(originalVirtualSize);
                    List<LevelInfo> levels = buildPyramidLevels(originalWidth, originalHeight, originalVirtualSize, maxZoom);
                    long totalRawBytes = calculateTotalRawBytes(levels);

                    String imageId = nextImageId();
                    long sourceFileBytes = Files.size(inputPath);

                    printImageInfo(
                            imageId,
                            displayName,
                            originalWidth,
                            originalHeight,
                            sourceFileBytes,
                            totalRawBytes,
                            originalVirtualSize,
                            maxZoom,
                            levels
                    );

                    verifyDiskSpace(outputRoot, totalRawBytes);

                    for (LevelInfo level : levels) {
                        Path finalRawPath = imageDirectory.resolve(level.fileName);
                        Path tempRawPath = imageDirectory.resolve(level.fileName + ".part");

                        int rowsPerRegion = calculateRowsPerRegion(level.width);

                        System.out.println();
                        System.out.println("------------------------------------------------------------");
                        System.out.printf(
                                Locale.US,
                                "Generando level%d: %,d x %,d | virtual %,d | sampleFactor=%d | %s%n",
                                level.level,
                                level.width,
                                level.height,
                                level.virtualSize,
                                level.sampleFactor,
                                humanBytes(level.rawBytes)
                        );
                        System.out.println("Filas/bloque decodificado: " + rowsPerRegion);

                        writeRawLevelIncrementally(
                                reader,
                                originalWidth,
                                originalHeight,
                                level,
                                tempRawPath,
                                rowsPerRegion
                        );

                        long generatedBytes = Files.size(tempRawPath);

                        if (generatedBytes != level.rawBytes) {
                            throw new IOException(
                                    "El RAW generado para level" + level.level +
                                    " tiene un tamaño inesperado. Esperado=" +
                                    level.rawBytes + ", generado=" + generatedBytes
                            );
                        }

                        Files.move(
                                tempRawPath,
                                finalRawPath,
                                StandardCopyOption.REPLACE_EXISTING
                        );
                    }

                    writeMeta(
                            metaPath,
                            imageId,
                            displayName,
                            originalWidth,
                            originalHeight,
                            originalVirtualSize,
                            maxZoom,
                            levels
                    );

                    System.out.println();
                    System.out.println("Conversión terminada correctamente.");
                    System.out.println("Directorio: " + imageDirectory);
                    System.out.println("META:       " + metaPath.getFileName());
                    System.out.println("Niveles:    " + levels.size());

                    for (LevelInfo level : levels) {
                        System.out.printf(
                                Locale.US,
                                "  level%d.raw -> %,d x %,d | virtual %,d | offset(%d,%d) | %s%n",
                                level.level,
                                level.width,
                                level.height,
                                level.virtualSize,
                                level.offsetX,
                                level.offsetY,
                                humanBytes(level.rawBytes)
                        );
                    }

                } finally {
                    reader.dispose();
                }
            }

        } catch (ArithmeticException e) {
            System.err.println(
                    "Las dimensiones producen un tamaño que excede el rango soportado por long."
            );
            deleteDirectoryRecursively(imageDirectory);

        } catch (Exception e) {
            System.err.println("Error procesando " + inputPath + ": " + e.getMessage());
            e.printStackTrace();
            deleteDirectoryRecursively(imageDirectory);
        }
    }

    /**
     * Construye la pirámide invertida:
     *
     * level0      = nivel más general (virtualSize cercano a 1024)
     * levelMaxZoom = resolución original (virtualSize original)
     */
    private static List<LevelInfo> buildPyramidLevels(
            int sourceWidth,
            int sourceHeight,
            long originalVirtualSize,
            int maxZoom
    ) {
        List<LevelInfo> levels = new ArrayList<>();

        for (int level = 0; level <= maxZoom; level++) {
            int exponent = maxZoom - level;
            int sampleFactor = 1 << exponent;

            int levelWidth = ceilDiv(sourceWidth, sampleFactor);
            int levelHeight = ceilDiv(sourceHeight, sampleFactor);
            long levelVirtualSize = originalVirtualSize / sampleFactor;
            long levelOffsetX = (levelVirtualSize - levelWidth) / 2L;
            long levelOffsetY = (levelVirtualSize - levelHeight) / 2L;

            long pixelCount = Math.multiplyExact((long) levelWidth, (long) levelHeight);
            long rawBytes = Math.multiplyExact(pixelCount, 4L);

            levels.add(
                    new LevelInfo(
                            level,
                            sampleFactor,
                            levelWidth,
                            levelHeight,
                            levelVirtualSize,
                            levelOffsetX,
                            levelOffsetY,
                            rawBytes,
                            "level" + level + ".raw"
                    )
            );
        }

        return levels;
    }

    private static int calculateMaxZoom(long virtualSize) {
        int zoom = 0;
        long current = virtualSize;

        while (current > TARGET_LEVEL0_VIRTUAL_SIZE) {
            current >>= 1;
            zoom++;
        }

        return zoom;
    }

    private static long calculateTotalRawBytes(List<LevelInfo> levels) {
        long total = 0L;

        for (LevelInfo level : levels) {
            total = Math.addExact(total, level.rawBytes);
        }

        return total;
    }

    /**
     * Genera un nivel de la pirámide directamente desde la imagen fuente.
     *
     * Para levelN se usa sourceSubsampling en función del sampleFactor del nivel.
     * Así no es necesario construir la imagen completa en memoria ni generar un
     * nivel intermedio a partir del RAW del nivel anterior.
     */
    private static void writeRawLevelIncrementally(
            ImageReader reader,
            int sourceWidth,
            int sourceHeight,
            LevelInfo level,
            Path rawPath,
            int rowsPerRegion
    ) throws IOException {

        byte[] outputBuffer = new byte[OUTPUT_BUFFER_SIZE];
        int outputPosition = 0;

        int scratchWidth = Math.min(level.width, PIXEL_SCRATCH_PIXELS);
        int[] argbScratch = new int[Math.max(1, scratchWidth)];

        long bytesWritten = 0L;
        int nextProgressPercent = 1;

        try (OutputStream out = Files.newOutputStream(
                rawPath,
                StandardOpenOption.CREATE_NEW,
                StandardOpenOption.WRITE
        )) {
            for (int outputY = 0; outputY < level.height; outputY += rowsPerRegion) {
                int requestedOutputRows = Math.min(rowsPerRegion, level.height - outputY);

                long sourceYLong = (long) outputY * level.sampleFactor;
                long requestedSourceHeightLong = (long) requestedOutputRows * level.sampleFactor;

                if (sourceYLong >= sourceHeight) {
                    throw new IOException(
                            "La posición fuente calculada excede la altura original."
                    );
                }

                int sourceY = Math.toIntExact(sourceYLong);
                int sourceRegionHeight = (int) Math.min(
                        requestedSourceHeightLong,
                        (long) sourceHeight - sourceYLong
                );

                ImageReadParam param = reader.getDefaultReadParam();
                param.setSourceRegion(
                        new Rectangle(0, sourceY, sourceWidth, sourceRegionHeight)
                );
                param.setSourceSubsampling(
                        level.sampleFactor,
                        level.sampleFactor,
                        0,
                        0
                );

                BufferedImage region = reader.read(0, param);

                if (region == null) {
                    throw new IOException(
                            "El lector devolvió null para level" + level.level +
                            " en outputY=" + outputY
                    );
                }

                int expectedRegionWidth = level.width;
                int expectedRegionHeight = requestedOutputRows;

                if (region.getWidth() != expectedRegionWidth
                        || region.getHeight() != expectedRegionHeight) {
                    region.flush();
                    throw new IOException(
                            "El lector devolvió una región con dimensiones inesperadas " +
                            "para level" + level.level + ": " +
                            region.getWidth() + "x" + region.getHeight() +
                            ", esperado " + expectedRegionWidth + "x" + expectedRegionHeight
                    );
                }

                try {
                    for (int localY = 0; localY < region.getHeight(); localY++) {
                        for (int x0 = 0; x0 < level.width; x0 += scratchWidth) {
                            int count = Math.min(scratchWidth, level.width - x0);

                            region.getRGB(
                                    x0,
                                    localY,
                                    count,
                                    1,
                                    argbScratch,
                                    0,
                                    count
                            );

                            for (int i = 0; i < count; i++) {
                                int argb = argbScratch[i];

                                int a = (argb >>> 24) & 0xFF;
                                int r = (argb >>> 16) & 0xFF;
                                int g = (argb >>> 8) & 0xFF;
                                int b = argb & 0xFF;

                                // Formato físico del .raw: R, G, B, A
                                outputBuffer[outputPosition++] = (byte) r;
                                outputBuffer[outputPosition++] = (byte) g;
                                outputBuffer[outputPosition++] = (byte) b;
                                outputBuffer[outputPosition++] = (byte) a;

                                if (outputPosition == outputBuffer.length) {
                                    out.write(outputBuffer);
                                    bytesWritten += outputPosition;
                                    outputPosition = 0;
                                }
                            }
                        }
                    }
                } finally {
                    region.flush();
                }

                int processedRows = outputY + requestedOutputRows;
                int percent = (int) ((processedRows * 100L) / level.height);

                if (percent >= nextProgressPercent || processedRows == level.height) {
                    System.out.printf(
                            Locale.US,
                            "level%d: %3d%% | filas %,d / %,d | escrito aprox. %s%n",
                            level.level,
                            percent,
                            processedRows,
                            level.height,
                            humanBytes(Math.min(bytesWritten, level.rawBytes))
                    );
                    nextProgressPercent = percent + 1;
                }
            }

            if (outputPosition > 0) {
                out.write(outputBuffer, 0, outputPosition);
                bytesWritten += outputPosition;
            }

            out.flush();

        } catch (IOException | RuntimeException e) {
            Files.deleteIfExists(rawPath);
            throw e;
        }

        if (bytesWritten != level.rawBytes) {
            Files.deleteIfExists(rawPath);
            throw new IOException(
                    "Cantidad de bytes RAW incorrecta para level" + level.level +
                    ". Esperado=" + level.rawBytes + ", escrito=" + bytesWritten
            );
        }
    }

    private static ImageReader selectReader(ImageInputStream input) throws IOException {
        input.seek(0);

        Iterator<ImageReader> iterator = ImageIO.getImageReaders(input);
        List<ImageReader> readers = new ArrayList<>();

        while (iterator.hasNext()) {
            readers.add(iterator.next());
        }

        if (readers.isEmpty()) {
            return null;
        }

        // Para TIFF preferimos TwelveMonkeys si está instalado.
        for (ImageReader reader : readers) {
            if (isTwelveMonkeysReader(reader)) {
                disposeOthers(readers, reader);
                return reader;
            }
        }

        ImageReader selected = readers.get(0);
        disposeOthers(readers, selected);
        return selected;
    }

    private static void disposeOthers(List<ImageReader> readers, ImageReader selected) {
        for (ImageReader reader : readers) {
            if (reader != selected) {
                reader.dispose();
            }
        }
    }

    private static boolean isTwelveMonkeysReader(ImageReader reader) {
        return reader.getClass()
                .getName()
                .toLowerCase(Locale.ROOT)
                .contains("twelvemonkeys");
    }

    /**
     * TIFF clásico usa magic 42; BigTIFF usa magic 43.
     */
    private static boolean isBigTiff(Path path) throws IOException {
        byte[] header = new byte[4];

        try (var in = Files.newInputStream(path)) {
            int read = in.read(header);
            if (read < 4) {
                return false;
            }
        }

        boolean littleEndian = header[0] == 0x49 && header[1] == 0x49;
        boolean bigEndian = header[0] == 0x4D && header[1] == 0x4D;

        if (!littleEndian && !bigEndian) {
            return false;
        }

        int magic;

        if (littleEndian) {
            magic = (header[2] & 0xFF) | ((header[3] & 0xFF) << 8);
        } else {
            magic = ((header[2] & 0xFF) << 8) | (header[3] & 0xFF);
        }

        return magic == 43;
    }

    private static int calculateRowsPerRegion(int outputWidth) {
        long estimatedRowBytes = Math.multiplyExact(
                (long) outputWidth,
                DECODE_BUDGET_BYTES_PER_PIXEL
        );

        long rows = DECODE_BLOCK_BUDGET / Math.max(1L, estimatedRowBytes);

        if (rows < 1L) {
            rows = 1L;
        }

        rows = Math.min(rows, MAX_ROWS_PER_REGION);

        return (int) rows;
    }

    private static void verifyDiskSpace(Path outputRoot, long expectedRawBytes)
            throws IOException {

        FileStore store = Files.getFileStore(outputRoot);
        long usable = store.getUsableSpace();

        long margin = Math.max(
                MIN_FREE_SPACE_MARGIN,
                expectedRawBytes / 100L
        );

        long required;

        try {
            required = Math.addExact(expectedRawBytes, margin);
        } catch (ArithmeticException e) {
            required = Long.MAX_VALUE;
        }

        System.out.println("Espacio libre:       " + humanBytes(usable));
        System.out.println("Pirámide RAW total:  " + humanBytes(expectedRawBytes));
        System.out.println("Requerido aprox.:    " + humanBytes(required));

        if (usable < required) {
            throw new IOException(
                    "No hay suficiente espacio libre para generar la pirámide RAW. " +
                    "Libre=" + humanBytes(usable) +
                    ", requerido~=" + humanBytes(required)
            );
        }
    }

    private static void writeMeta(
            Path metaPath,
            String imageId,
            String displayName,
            int originalWidth,
            int originalHeight,
            long originalVirtualSize,
            int maxZoom,
            List<LevelInfo> levels
    ) throws IOException {

        long level0VirtualSize = levels.isEmpty() ? originalVirtualSize : levels.get(0).virtualSize;

        StringBuilder meta = new StringBuilder();

        meta.append("id=").append(imageId).append('\n');
        meta.append("name=").append(displayName).append('\n');
        meta.append("originalWidth=").append(originalWidth).append('\n');
        meta.append("originalHeight=").append(originalHeight).append('\n');
        meta.append("virtualSize=").append(originalVirtualSize).append('\n');
        meta.append("tileSize=").append(TILE_SIZE).append('\n');
        meta.append("level0Size=").append(level0VirtualSize).append('\n');
        meta.append("maxZoom=").append(maxZoom).append('\n');
        meta.append('\n');

        for (int i = 0; i < levels.size(); i++) {
            LevelInfo level = levels.get(i);
            meta.append("level.").append(level.level).append(".file=").append(level.fileName).append('\n');
            meta.append("level.").append(level.level).append(".virtualSize=").append(level.virtualSize).append('\n');
            meta.append("level.").append(level.level).append(".width=").append(level.width).append('\n');
            meta.append("level.").append(level.level).append(".height=").append(level.height).append('\n');
            meta.append("level.").append(level.level).append(".offsetX=").append(level.offsetX).append('\n');
            meta.append("level.").append(level.level).append(".offsetY=").append(level.offsetY).append('\n');

            if (i < levels.size() - 1) {
                meta.append('\n');
            }
        }

        Files.writeString(
                metaPath,
                meta.toString(),
                StandardCharsets.UTF_8,
                StandardOpenOption.CREATE,
                StandardOpenOption.TRUNCATE_EXISTING,
                StandardOpenOption.WRITE
        );
    }

    private static void printImageInfo(
            String imageId,
            String displayName,
            int originalWidth,
            int originalHeight,
            long sourceFileBytes,
            long totalRawBytes,
            long originalVirtualSize,
            int maxZoom,
            List<LevelInfo> levels
    ) {
        System.out.println("ID imagen:          " + imageId);
        System.out.println("Nombre:             " + displayName);
        System.out.println("Dimensiones orig.:  " + originalWidth + " x " + originalHeight);
        System.out.println("Archivo fuente:     " + humanBytes(sourceFileBytes));
        System.out.println("Pirámide RAW total: " + humanBytes(totalRawBytes));
        System.out.println("Virtual original:   " + originalVirtualSize + " x " + originalVirtualSize);
        System.out.println("Tile size:          " + TILE_SIZE);
        System.out.println("Max zoom:           " + maxZoom);
        System.out.println("Cantidad niveles:   " + levels.size());
        System.out.println("Buffer salida:      " + humanBytes(OUTPUT_BUFFER_SIZE));
        System.out.println();

        for (LevelInfo level : levels) {
            System.out.printf(
                    Locale.US,
                    "  level%d -> %,d x %,d | virtual %,d | offset(%d,%d) | sampleFactor=%d | %s%n",
                    level.level,
                    level.width,
                    level.height,
                    level.virtualSize,
                    level.offsetX,
                    level.offsetY,
                    level.sampleFactor,
                    humanBytes(level.rawBytes)
            );
        }
    }

    private static int ceilDiv(int value, int divisor) {
        return (int) (((long) value + divisor - 1L) / divisor);
    }

    private static long nextPowerOfTwo(long value) {
        if (value <= 0L) {
            throw new IllegalArgumentException("La dimensión debe ser positiva.");
        }

        long result = 1L;

        while (result < value) {
            if (result > (Long.MAX_VALUE >>> 1)) {
                throw new IllegalArgumentException(
                        "No se puede calcular la siguiente potencia de dos."
                );
            }
            result <<= 1;
        }

        return result;
    }

    private static boolean isSupportedExtension(String extension) {
        return extension.equals("jpg")
                || extension.equals("jpeg")
                || extension.equals("png")
                || extension.equals("tif")
                || extension.equals("tiff");
    }

    private static String removeExtension(String fileName) {
        int dot = fileName.lastIndexOf('.');
        return dot > 0 ? fileName.substring(0, dot) : fileName;
    }

    private static String getExtension(String fileName) {
        int dot = fileName.lastIndexOf('.');
        return dot >= 0 ? fileName.substring(dot + 1) : "";
    }

    private static String sanitizeName(String name) {
        String sanitized = name.replaceAll("[^a-zA-Z0-9._-]", "_");
        return sanitized.isBlank() ? "imagen" : sanitized;
    }

    private static Path createUniqueDirectory(Path root, String baseName)
            throws IOException {

        Path candidate = root.resolve(baseName);
        int suffix = 1;

        while (Files.exists(candidate)) {
            candidate = root.resolve(baseName + "_" + suffix++);
        }

        Files.createDirectories(candidate);
        return candidate;
    }

    /**
     * Como cada conversión usa un directorio nuevo y único, ante un error
     * se elimina todo ese directorio para no dejar niveles incompletos.
     */
    private static void deleteDirectoryRecursively(Path directory) {
        if (directory == null || !Files.exists(directory)) {
            return;
        }

        try (var paths = Files.walk(directory)) {
            paths.sorted((a, b) -> b.getNameCount() - a.getNameCount())
                    .forEach(path -> {
                        try {
                            Files.deleteIfExists(path);
                        } catch (IOException ignored) {
                        }
                    });
        } catch (IOException ignored) {
        }
    }

    private static String humanBytes(long bytes) {
        if (bytes < 1024L) {
            return bytes + " B";
        }

        final String[] units = {"KiB", "MiB", "GiB", "TiB", "PiB"};
        double value = bytes;
        int unit = -1;

        do {
            value /= 1024.0;
            unit++;
        } while (value >= 1024.0 && unit < units.length - 1);

        return String.format(Locale.US, "%.2f %s", value, units[unit]);
    }

    private static final class LevelInfo {
        final int level;
        final int sampleFactor;
        final int width;
        final int height;
        final long virtualSize;
        final long offsetX;
        final long offsetY;
        final long rawBytes;
        final String fileName;

        LevelInfo(
                int level,
                int sampleFactor,
                int width,
                int height,
                long virtualSize,
                long offsetX,
                long offsetY,
                long rawBytes,
                String fileName
        ) {
            this.level = level;
            this.sampleFactor = sampleFactor;
            this.width = width;
            this.height = height;
            this.virtualSize = virtualSize;
            this.offsetX = offsetX;
            this.offsetY = offsetY;
            this.rawBytes = rawBytes;
            this.fileName = fileName;
        }
    }
}
