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
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.atomic.AtomicLong;

/**
 * JPG/PNG/TIFF/BigTIFF -> pirámide RAW RGBA8888 + META (Java 17+).
 * Salida: C:\Imagenes grandes\<imagen> (Windows), /mnt/c/Imagenes grandes (WSL).
 * -Dconverter.threads=10 configura los workers compartidos por cada fase.
 * -Dconverter.blockMiB=32 configura el presupuesto estimado de decodificación
 * por worker; no es un límite estricto de RAM del plugin TIFF.
 * -Dconverter.output="..." permite cambiar explícitamente la salida.
 * Cada bloque se decodifica una vez para generar 1/1, 1/2, 1/4 y 1/8.
 * Los niveles menores se derivan del RAW previo en paralelo, conservando
 * el promedio ponderado y redondeo de la versión original.
 * BigTIFF requiere TwelveMonkeys ImageIO TIFF en el classpath.
 */
public class ImageToRawConverter {

    private static final int TILE_SIZE = 256;
    private static final int TARGET_LEVEL0_VIRTUAL_SIZE = 1024;

    // Buffer físico de escritura del .raw.
    private static final int OUTPUT_BUFFER_SIZE = 256 * 1024;

    private static final int DEFAULT_THREADS = 15;
    private static final int DEFAULT_BLOCK_MIB = 32;
    private static final long DECODE_BUDGET_BYTES_PER_PIXEL = 8L;

    private static final long MIN_FREE_SPACE_MARGIN = 128L * 1024L * 1024L;

    /*
     * A partir de una reducción 1/8 se usa promedio de área (box average).
     * Para 1/1, 1/2 y 1/4 se conserva el muestreo rápido anterior.
     */
    private static final int BOX_AVERAGE_MIN_SAMPLE_FACTOR = 8;

    // Cantidad de píxeles de salida por bloque al encadenar RAW -> RAW.
    private static final int RAW_CHAIN_OUTPUT_CHUNK_PIXELS = 16 * 1024;

    private static final DateTimeFormatter PROCESS_TIME_FORMAT =
            DateTimeFormatter.ofPattern("dd/MM/yyyy HH:mm:ss");

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

    private static Path resolveOutputRoot() throws IOException {
        String override = System.getProperty("converter.output");
        if (override != null && !override.isBlank()) {
            return Paths.get(override).toAbsolutePath().normalize();
        }
        if (System.getProperty("os.name", "").toLowerCase(Locale.ROOT).startsWith("windows")) {
            return Paths.get("C:\\Imagenes grandes");
        }
        if (Files.isDirectory(Paths.get("/mnt/c"))) {
            return Paths.get("/mnt/c/Imagenes grandes");
        }
        throw new IOException("No se encontró la unidad C:. Usa -Dconverter.output=/ruta/salida.");
    }

    private static int positiveProperty(String name, int fallback) {
        String value = System.getProperty(name);
        int result = value == null ? fallback : Integer.parseInt(value);
        if (result <= 0) throw new IllegalArgumentException(name + " debe ser mayor que cero.");
        return result;
    }

    private static String nextImageId() {
        // UUID evita repetir IDs aunque el conversor se cierre y se vuelva a ejecutar.
        return "IMG-" + UUID.randomUUID();
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

        LocalDateTime processingStart = LocalDateTime.now();
        long processingStartNanos = System.nanoTime();
        System.out.println("Hora de inicio del procesamiento: "
                + processingStart.format(PROCESS_TIME_FORMAT));

        Path imageDirectory = null;

        try {
            boolean tiffByExtension = extension.equals("tif") || extension.equals("tiff");
            boolean bigTiff = tiffByExtension && isBigTiff(inputPath);

            String baseName = sanitizeName(displayName);
            imageDirectory = createUniqueDirectory(outputRoot, baseName);
            Path metaPath = imageDirectory.resolve(baseName + ".meta");

            int originalWidth;
            int originalHeight;
            String readerClass;
            String readerFormat;

            // Lector temporal únicamente para inspeccionar metadata.
            // Se cierra antes de arrancar los workers.
            try (ImageInputStream input = new FileImageInputStream(inputPath.toFile())) {
                ImageReader reader = selectReader(input);

                if (reader == null) {
                    if (bigTiff) {
                        throw new IOException(
                                "No se encontró un ImageReader compatible con BigTIFF. " +
                                "Agrega TwelveMonkeys ImageIO TIFF al classpath."
                        );
                    }
                    throw new IOException("No se encontró un ImageReader compatible con el archivo.");
                }

                try {
                    readerClass = reader.getClass().getName();
                    try {
                        readerFormat = reader.getFormatName();
                    } catch (IOException e) {
                        readerFormat = extension;
                    }

                    if (bigTiff && !isTwelveMonkeysReader(reader)) {
                        throw new IOException(
                                "El archivo es BigTIFF, pero el lector activo no es TwelveMonkeys. " +
                                "Agrega TwelveMonkeys ImageIO TIFF al proyecto."
                        );
                    }

                    input.seek(0);
                    reader.setInput(input, false, false);

                    originalWidth = reader.getWidth(0);
                    originalHeight = reader.getHeight(0);

                    if (originalWidth <= 0 || originalHeight <= 0) {
                        throw new IOException("Dimensiones de imagen inválidas.");
                    }
                } finally {
                    reader.dispose();
                }
            }

            System.out.println("Reader:       " + readerClass);
            System.out.println("Formato:      " + readerFormat);
            System.out.println("BigTIFF:      " + bigTiff);

            long originalVirtualSize = nextPowerOfTwo((long) Math.max(originalWidth, originalHeight));
            int maxZoom = calculateMaxZoom(originalVirtualSize);
            List<LevelInfo> levels = buildPyramidLevels(
                    originalWidth,
                    originalHeight,
                    originalVirtualSize,
                    maxZoom
            );
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

            System.out.println();
            System.out.println("============================================================");
            System.out.println("INICIANDO PROCESAMIENTO PARALELO");
            System.out.println("  Workers configurados: " + positiveProperty("converter.threads", DEFAULT_THREADS));
            System.out.println("  Fase 1: bloques compartidos para 1/1, 1/2, 1/4 y promedio 1/8");
            System.out.println("  Fase 2: niveles menores desde RAW, también en paralelo");
            System.out.println("============================================================");

            generatePyramidInParallel(
                    inputPath,
                    imageDirectory,
                    bigTiff,
                    originalWidth,
                    originalHeight,
                    levels
            );

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

        } catch (ArithmeticException e) {
            System.err.println(
                    "Las dimensiones producen un tamaño que excede el rango soportado por long."
            );
            deleteDirectoryRecursively(imageDirectory);

        } catch (Exception e) {
            System.err.println("Error procesando " + inputPath + ": " + e.getMessage());
            e.printStackTrace();
            deleteDirectoryRecursively(imageDirectory);

        } finally {
            LocalDateTime processingEnd = LocalDateTime.now();
            long elapsedNanos = System.nanoTime() - processingStartNanos;

            System.out.println();
            System.out.println("Hora de fin del procesamiento:    "
                    + processingEnd.format(PROCESS_TIME_FORMAT));
            System.out.println("Duración total:                   "
                    + formatElapsedTime(elapsedNanos));
            System.out.println("============================================================");
        }
    }

    private static void generatePyramidInParallel(
            Path inputPath, Path imageDirectory, boolean bigTiff,
            int originalWidth, int originalHeight, List<LevelInfo> levels
    ) throws Exception {
        int requestedWorkers = positiveProperty("converter.threads", DEFAULT_THREADS);
        int blockMiB = positiveProperty("converter.blockMiB", DEFAULT_BLOCK_MIB);
        if (blockMiB > 256) throw new IllegalArgumentException("converter.blockMiB no debe exceder 256.");
        List<LevelInfo> direct = new ArrayList<>();
        for (LevelInfo level : levels) {
            if (level.sampleFactor <= BOX_AVERAGE_MIN_SAMPLE_FACTOR) direct.add(level);
        }
        direct.sort((a, b) -> Integer.compare(a.sampleFactor, b.sampleFactor));
        int[] shape = new int[2];
        withIndependentReader(inputPath, bigTiff, reader -> {
            int[] selected = chooseBlockShape(reader, originalWidth, originalHeight, blockMiB);
            shape[0] = selected[0];
            shape[1] = selected[1];
        });
        int blockWidth = shape[0], blockHeight = shape[1];
        long columns = ceilDiv(originalWidth, blockWidth);
        long rows = ceilDiv(originalHeight, blockHeight);
        long totalBlocks = columns * rows;
        int workers = (int) Math.min(requestedWorkers, totalBlocks);
        System.out.printf("Fase 1: %d workers | bloques %dx%d | %,d bloques%n",
                workers, blockWidth, blockHeight, totalBlocks);
        System.out.println("Heap máximo JVM: " + humanBytes(Runtime.getRuntime().maxMemory())
                + " | presupuesto de decodificación por worker: " + blockMiB + " MiB"
                + " (más buffers de salida y memoria del lector)");
        for (LevelInfo level : direct) Files.createFile(imageDirectory.resolve(level.fileName + ".part"));
        AtomicLong nextBlock = new AtomicLong();
        AtomicReference<Throwable> failure = new AtomicReference<>();
        Progress progress = new Progress("Original + niveles hasta 1/8", (long) originalWidth * originalHeight);
        runWorkers(workers, failure, worker -> withIndependentReader(inputPath, bigTiff, reader -> {
            validateReaderDimensions(reader, originalWidth, originalHeight);
            // Canales y reader privados: no hay cursores compartidos entre workers.
            try (WorkerOutputs outputs = new WorkerOutputs(imageDirectory, direct);
                 TiledTiffSource tiled = TiledTiffSource.openIfNeeded(inputPath, reader)) {
                long index;
                while ((index = nextBlock.getAndIncrement()) < totalBlocks) {
                    checkRunning(failure);
                    int x = (int) ((index % columns) * blockWidth);
                    int y = (int) ((index / columns) * blockHeight);
                    int width = Math.min(blockWidth, originalWidth - x);
                    int height = Math.min(blockHeight, originalHeight - y);
                    BufferedImage region;
                    if (tiled != null) {
                        region = tiled.read(x, y, width, height);
                    } else {
                        ImageReadParam param = reader.getDefaultReadParam();
                        param.setSourceRegion(new Rectangle(x, y, width, height));
                        region = reader.read(0, param);
                    }
                    if (region == null) throw new IOException("El lector devolvió una región vacía.");
                    try {
                        if (region.getWidth() != width || region.getHeight() != height)
                            throw new IOException("El lector no respetó las dimensiones del bloque.");
                        convertSourceBlock(region, x, y, direct, outputs.channels, failure);
                    } finally {
                        region.flush();
                    }
                    progress.advance((long) width * height);
                }
            }
        }));
        for (LevelInfo level : direct) {
            finalizeGeneratedLevel(imageDirectory.resolve(level.fileName + ".part"),
                    imageDirectory.resolve(level.fileName), level);
        }
        // Nunca se vuelve a decodificar el TIFF para los niveles menores.
        LevelInfo previous = findLevelBySampleFactor(levels, BOX_AVERAGE_MIN_SAMPLE_FACTOR);
        if (previous != null) {
            for (int factor = BOX_AVERAGE_MIN_SAMPLE_FACTOR * 2; ; factor *= 2) {
                LevelInfo target = findLevelBySampleFactor(levels, factor);
                if (target == null) break;
                generateLevelFromPreviousRaw(imageDirectory.resolve(previous.fileName), previous,
                        target, imageDirectory, originalWidth, originalHeight);
                previous = target;
            }
        }
    }

    /** Bloques múltiplos de 8: ningún promedio queda partido entre workers. */
    private static int[] chooseBlockShape(ImageReader reader, int width, int height, int blockMiB)
            throws IOException {
        long maxPixels = blockMiB * 1024L * 1024L / DECODE_BUDGET_BYTES_PER_PIXEL;
        long paddedWidth = ((long) width + 7L) / 8L * 8L;
        long bw = Math.min(paddedWidth, Math.min(4096L, maxPixels / 8L));
        long bh;
        try {
            int tw = reader.getTileWidth(0), th = reader.getTileHeight(0);
            long ax = alignedTileSize(tw), ay = alignedTileSize(th);
            boolean zeroOrigin = reader.getTileGridXOffset(0) == 0 && reader.getTileGridYOffset(0) == 0;
            if (isTwelveMonkeysReader(reader) && reader.isImageTiled(0)
                    && (!zeroOrigin || ax <= 0 || ay <= 0 || ax > maxPixels / ay)) {
                throw new IllegalArgumentException("Un grupo de tiles alineado excede converter.blockMiB; "
                        + "aumenta ese presupuesto para leer este TIFF sin dividir sus tiles.");
            }
            if (zeroOrigin && ax > 0 && ay > 0 && ax <= maxPixels / ay) {
                // Junta tiles/strips completos cuando caben en el presupuesto.
                // El último bloque puede ser parcial en el borde de la imagen.
                bw = Math.min(((long) width + ax - 1L) / ax * ax,
                        Math.max(ax, maxPixels / ay / ax * ax));
                bh = Math.max(ay, maxPixels / bw / ay * ay);
                System.out.printf("Organización reportada por el lector: %dx%d | bloques alineados%n", tw, th);
                return new int[]{(int) bw, (int) bh};
            }
        } catch (UnsupportedOperationException | IOException ignored) {
            // Algunos lectores no exponen una geometría útil; región genérica.
        }
        if (paddedWidth <= maxPixels / 8L) bw = paddedWidth;
        bw = Math.max(8L, bw / 8L * 8L);
        bh = Math.max(8L, maxPixels / bw / 8L * 8L);
        bh = Math.min(bh, ((long) height + 7L) / 8L * 8L);
        System.out.println("Bloques genéricos; la cantidad real de decodificaciones depende del lector.");
        return new int[]{(int) bw, (int) bh};
    }

    private static long alignedTileSize(int size) {
        if (size <= 0) return 0;
        int a = size, b = 8;
        while (b != 0) { int remainder = a % b; a = b; b = remainder; }
        return (long) size / a * 8L;
    }

    /**
     * Presenta al decoder solo los tiles del bloque como un BigTIFF virtual cuyo
     * origen es (0,0). Evita el recorte horizontal defectuoso de TwelveMonkeys
     * y que read(region) vuelva a recorrer/decodificar los tiles anteriores.
     * Solo se crea una cabecera pequeña en RAM; los píxeles se leen directamente
     * del TIFF original, que se abre exclusivamente en modo lectura.
     */
    private static final class TiledTiffSource implements AutoCloseable {
        final FileImageInputStream source;
        final ImageReader decoder;
        final java.nio.ByteOrder order;
        final List<TiffField> fields = new ArrayList<>();
        final long[] offsets, counts;
        final int tileWidth, tileHeight, imageWidth, imageHeight, planes;
        final long tilesAcross, tilesDown;

        static TiledTiffSource openIfNeeded(Path path, ImageReader reader) throws IOException {
            if (!isTwelveMonkeysReader(reader) || !reader.isImageTiled(0)) return null;
            return new TiledTiffSource(path, reader);
        }

        TiledTiffSource(Path path, ImageReader reader) throws IOException {
            source = new FileImageInputStream(path.toFile());
            ImageReader created = null;
            try {
                int marker = source.readUnsignedShort();
                if (marker != 0x4949 && marker != 0x4d4d) throw new IOException("Cabecera TIFF inválida.");
                order = marker == 0x4949 ? java.nio.ByteOrder.LITTLE_ENDIAN : java.nio.ByteOrder.BIG_ENDIAN;
                source.setByteOrder(order);
                int magic = source.readUnsignedShort();
                boolean big = magic == 43;
                if (!big && magic != 42) throw new IOException("Versión TIFF no soportada.");
                if (big && (source.readUnsignedShort() != 8 || source.readUnsignedShort() != 0))
                    throw new IOException("Offsets BigTIFF no soportados.");
                long ifd = big ? source.readLong() : source.readUnsignedInt();
                if (ifd <= 0 || ifd >= source.length()) throw new IOException("IFD TIFF fuera del archivo.");
                source.seek(ifd);
                long entryCount = big ? source.readLong() : source.readUnsignedShort();
                if (entryCount <= 0 || entryCount > 65536) throw new IOException("Cantidad de campos TIFF inválida.");
                for (int i = 0; i < entryCount; i++) {
                    int tag = source.readUnsignedShort(), type = source.readUnsignedShort();
                    long count = big ? source.readLong() : source.readUnsignedInt();
                    byte[] slot = new byte[big ? 8 : 4];
                    source.readFully(slot);
                    long next = source.getStreamPosition();
                    // Los IFD secundarios no intervienen en la decodificación de la primera imagen.
                    if (tag == 330 || tag == 34665 || tag == 34853 || tag == 40965 || type == 13 || type == 18)
                        continue;
                    int unit = tiffTypeSize(type);
                    if (count < 0 || count > Long.MAX_VALUE / unit) throw new IOException("Campo TIFF demasiado grande.");
                    long bytes = count * unit;
                    java.nio.ByteBuffer value = java.nio.ByteBuffer.wrap(slot).order(order);
                    long address = bytes > slot.length ? (big ? value.getLong() : Integer.toUnsignedLong(value.getInt())) : -1;
                    if (address >= 0 && (address > source.length() || bytes > source.length() - address))
                        throw new IOException("Campo TIFF fuera del archivo: " + tag);
                    if (bytes > slot.length && address < 0) throw new IOException("Offset TIFF inválido.");
                    byte[] inline = new byte[8];
                    if (bytes <= 8) {
                        if (address >= 0) { source.seek(address); source.readFully(inline, 0, (int) bytes); }
                        else System.arraycopy(slot, 0, inline, 0, (int) bytes);
                    }
                    fields.add(new TiffField(tag, type, count, bytes, address, inline));
                    source.seek(next);
                }
                imageWidth = reader.getWidth(0);
                imageHeight = reader.getHeight(0);
                tileWidth = reader.getTileWidth(0);
                tileHeight = reader.getTileHeight(0);
                if (tileWidth <= 0 || tileHeight <= 0) throw new IOException("Dimensiones de tile inválidas.");
                tilesAcross = ceilDiv(imageWidth, tileWidth);
                tilesDown = ceilDiv(imageHeight, tileHeight);
                long planar = integerValue(find(284), 1);
                planes = planar == 2 ? Math.toIntExact(integerValue(find(277), 1)) : 1;
                offsets = integerValues(required(324));
                counts = integerValues(required(325));
                long expected = Math.multiplyExact(Math.multiplyExact(tilesAcross, tilesDown), planes);
                if (offsets.length != expected || counts.length != expected)
                    throw new IOException("Tablas de tiles TIFF incompatibles con sus dimensiones.");
                for (int i = 0; i < offsets.length; i++) {
                    if (offsets[i] < 0 || counts[i] <= 0 || offsets[i] > source.length()
                            || counts[i] > source.length() - offsets[i])
                        throw new IOException("Tile TIFF vacío o fuera del archivo: " + i);
                }
                created = reader.getOriginatingProvider().createReaderInstance();
                decoder = created;
                System.out.println("[" + Thread.currentThread().getName()
                        + "] Lectura TIFF por tiles aislados: sin recorte horizontal global");
            } catch (IOException | RuntimeException | Error e) {
                if (created != null) created.dispose();
                try { source.close(); } catch (IOException closeError) { e.addSuppressed(closeError); }
                throw e;
            }
        }

        TiffField find(int tag) {
            for (TiffField field : fields) if (field.tag == tag) return field;
            return null;
        }
        TiffField required(int tag) throws IOException {
            TiffField field = find(tag);
            if (field == null) throw new IOException("Falta campo TIFF necesario: " + tag);
            return field;
        }
        long integerValue(TiffField field, long fallback) throws IOException {
            return field == null ? fallback : integerValues(field)[0];
        }
        long[] integerValues(TiffField field) throws IOException {
            if (field.count <= 0 || field.count > Integer.MAX_VALUE)
                throw new IOException("Cantidad inválida de valores TIFF: " + field.tag);
            long[] values = new long[(int) field.count];
            if (field.bytes > 8) source.seek(field.address);
            java.nio.ByteBuffer local = java.nio.ByteBuffer.wrap(field.inline).order(order);
            for (int i = 0; i < values.length; i++) {
                switch (field.type) {
                    case 3: values[i] = field.bytes > 8 ? source.readUnsignedShort() : Short.toUnsignedInt(local.getShort()); break;
                    case 4: values[i] = field.bytes > 8 ? source.readUnsignedInt() : Integer.toUnsignedLong(local.getInt()); break;
                    case 16: values[i] = field.bytes > 8 ? source.readLong() : local.getLong(); break;
                    default: throw new IOException("Tipo no entero en tabla TIFF: " + field.type);
                }
                if (values[i] < 0) throw new IOException("Valor TIFF fuera del rango long.");
            }
            return values;
        }

        BufferedImage read(int x, int y, int width, int height) throws IOException {
            if (x % tileWidth != 0 || y % tileHeight != 0)
                throw new IOException("El bloque TIFF debe empezar en un límite de tile.");
            int across = ceilDiv(width, tileWidth), down = ceilDiv(height, tileHeight);
            int selected = Math.multiplyExact(Math.multiplyExact(across, down), planes);
            int tableStart = Math.toIntExact(16L + 8L + fields.size() * 20L + 8L);
            int headerSize = Math.toIntExact(tableStart + selected * 16L);
            ByteBuffer header = ByteBuffer.allocate(headerSize).order(order);
            header.putShort((short) (order == java.nio.ByteOrder.LITTLE_ENDIAN ? 0x4949 : 0x4d4d));
            header.putShort((short) 43).putShort((short) 8).putShort((short) 0).putLong(16L);
            header.putLong(fields.size());
            long firstIndex = (long) (y / tileHeight) * tilesAcross + x / tileWidth;
            for (TiffField field : fields) {
                header.putShort((short) field.tag);
                if (field.tag == 256 || field.tag == 257) {
                    header.putShort((short) 4).putLong(1);
                    header.putInt(field.tag == 256 ? width : height).putInt(0);
                } else if (field.tag == 324 || field.tag == 325) {
                    header.putShort((short) 16).putLong(selected);
                    if (selected == 1) {
                        int index = Math.toIntExact(firstIndex);
                        header.putLong(field.tag == 324 ? Math.addExact(offsets[index], headerSize) : counts[index]);
                    } else {
                        header.putLong(field.tag == 324 ? tableStart : tableStart + selected * 8L);
                    }
                } else {
                    header.putShort((short) field.type).putLong(field.count);
                    if (field.bytes <= 8) header.put(field.inline);
                    else header.putLong(Math.addExact(field.address, headerSize));
                }
            }
            header.putLong(0); // No hay otra página en la vista virtual.
            int item = 0;
            for (int plane = 0; plane < planes; plane++) {
                for (int row = 0; row < down; row++) {
                    for (int col = 0; col < across; col++) {
                        int original = Math.toIntExact(plane * tilesAcross * tilesDown + firstIndex + row * tilesAcross + col);
                        header.putLong(tableStart + item * 8, Math.addExact(offsets[original], headerSize));
                        header.putLong(tableStart + selected * 8 + item * 8, counts[original]);
                        item++;
                    }
                }
            }
            try (VirtualTiffInput view = new VirtualTiffInput(header.array(), source)) {
                decoder.setInput(view, false, false);
                try {
                    return decoder.read(0); // Siempre (0,0), solo contiene los tiles de este bloque.
                } finally {
                    decoder.setInput(null);
                }
            } catch (IOException | RuntimeException e) {
                throw new IOException("Error leyendo bloque TIFF (" + x + "," + y + "," + width + "," + height + ")", e);
            }
        }
        public void close() throws IOException {
            try { decoder.dispose(); } finally { source.close(); }
        }
    }

    private static final class TiffField {
        final int tag, type;
        final long count, bytes, address;
        final byte[] inline;
        TiffField(int tag, int type, long count, long bytes, long address, byte[] inline) {
            this.tag = tag; this.type = type; this.count = count;
            this.bytes = bytes; this.address = address; this.inline = inline;
        }
    }

    private static int tiffTypeSize(int type) throws IOException {
        switch (type) {
            case 1: case 2: case 6: case 7: return 1;
            case 3: case 8: return 2;
            case 4: case 9: case 11: case 13: return 4;
            case 5: case 10: case 12: case 16: case 17: case 18: return 8;
            default: throw new IOException("Tipo de campo TIFF no soportado: " + type);
        }
    }

    /** Espacio virtual: cabecera sintética seguida del archivo original sin modificar. */
    private static final class VirtualTiffInput extends javax.imageio.stream.ImageInputStreamImpl {
        final byte[] header;
        final ImageInputStream source;
        VirtualTiffInput(byte[] header, ImageInputStream source) { this.header = header; this.source = source; }
        public int read() throws IOException {
            checkClosed(); bitOffset = 0;
            int value;
            if (streamPos < header.length) value = header[(int) streamPos] & 255;
            else { source.seek(streamPos - header.length); value = source.read(); }
            if (value >= 0) streamPos++;
            return value;
        }
        public int read(byte[] bytes, int offset, int length) throws IOException {
            checkClosed();
            java.util.Objects.checkFromIndexSize(offset, length, bytes.length);
            if (length == 0) return 0;
            bitOffset = 0;
            int count;
            if (streamPos < header.length) {
                count = (int) Math.min(length, header.length - streamPos);
                System.arraycopy(header, (int) streamPos, bytes, offset, count);
            } else {
                source.seek(streamPos - header.length);
                count = source.read(bytes, offset, length);
            }
            if (count > 0) streamPos += count;
            return count;
        }
        public long length() {
            try { return Math.addExact(header.length, source.length()); }
            catch (IOException | ArithmeticException e) { return -1; }
        }
        // close() heredado cierra solo esta vista. Cada worker conserva su fuente.
    }

    private static void convertSourceBlock(BufferedImage region, int globalX, int globalY,
            List<LevelInfo> levels, FileChannel[] channels, AtomicReference<Throwable> failure)
            throws IOException {
        int width = region.getWidth(), height = region.getHeight();
        byte[][] buffers = new byte[levels.size()][];
        int[] widths = new int[levels.size()];
        int[] positions = new int[levels.size()];
        int averageIndex = -1;
        for (int i = 0; i < levels.size(); i++) {
            int factor = levels.get(i).sampleFactor;
            widths[i] = ceilDiv(width, factor);
            buffers[i] = new byte[Math.multiplyExact(Math.multiplyExact(widths[i], ceilDiv(height, factor)), 4)];
            if (factor == BOX_AVERAGE_MIN_SAMPLE_FACTOR) averageIndex = i;
        }
        int[] argb = new int[width];
        long[] sums = averageIndex < 0 ? null : new long[widths[averageIndex] * 4];
        for (int y = 0; y < height; y++) {
            checkRunning(failure);
            // Una única conversión de color por píxel alimenta las cuatro escalas.
            region.getRGB(0, y, width, 1, argb, 0, width);
            for (int i = 0; i < levels.size(); i++) {
                int factor = levels.get(i).sampleFactor;
                if (factor >= BOX_AVERAGE_MIN_SAMPLE_FACTOR || y % factor != 0) continue;
                byte[] buffer = buffers[i];
                int p = positions[i];
                for (int x = 0; x < width; x += factor) {
                    int pixel = argb[x];
                    buffer[p++] = (byte) (pixel >>> 16);
                    buffer[p++] = (byte) (pixel >>> 8);
                    buffer[p++] = (byte) pixel;
                    buffer[p++] = (byte) (pixel >>> 24);
                }
                positions[i] = p;
            }
            if (averageIndex >= 0) {
                for (int x = 0; x < width; x++) {
                    int pixel = argb[x], base = (x / 8) * 4;
                    sums[base] += (pixel >>> 16) & 255;
                    sums[base + 1] += (pixel >>> 8) & 255;
                    sums[base + 2] += pixel & 255;
                    sums[base + 3] += (pixel >>> 24) & 255;
                }
                if (y % 8 == 7 || y == height - 1) {
                    int p = positions[averageIndex];
                    for (int x = 0; x < widths[averageIndex]; x++) {
                        long count = (long) Math.min(8, width - x * 8) * (y % 8 + 1);
                        for (int c = 0; c < 4; c++) {
                            buffers[averageIndex][p++] = (byte) roundedAverage(sums[x * 4 + c], count);
                            sums[x * 4 + c] = 0;
                        }
                    }
                    positions[averageIndex] = p;
                }
            }
        }
        for (int i = 0; i < levels.size(); i++) {
            checkRunning(failure);
            LevelInfo level = levels.get(i);
            if (positions[i] != buffers[i].length) throw new IOException("Bloque RAW incompleto.");
            int outX = globalX / level.sampleFactor, outY = globalY / level.sampleFactor;
            long offset = ((long) outY * level.width + outX) * 4L;
            if (widths[i] == level.width) {
                writeFullyAt(channels[i], ByteBuffer.wrap(buffers[i]), offset);
            } else {
                int rowBytes = widths[i] * 4;
                for (int row = 0; row < ceilDiv(height, level.sampleFactor); row++) {
                    writeFullyAt(channels[i], ByteBuffer.wrap(buffers[i], row * rowBytes, rowBytes),
                            offset + (long) row * level.width * 4L);
                }
            }
        }
    }

    private static void writeFullyAt(FileChannel channel, ByteBuffer buffer, long position) throws IOException {
        while (buffer.hasRemaining()) {
            if (Thread.currentThread().isInterrupted()) throw new IOException("Escritura interrumpida.");
            int count = channel.write(buffer, position);
            if (count <= 0) throw new IOException("No se pudo avanzar la escritura RAW.");
            position += count;
        }
    }

    private static void checkRunning(AtomicReference<Throwable> failure) throws IOException {
        if (failure.get() != null || Thread.currentThread().isInterrupted())
            throw new IOException("Conversión cancelada por interrupción o fallo de otro worker.");
    }

    private static void runWorkers(int count, AtomicReference<Throwable> failure, WorkerOperation task)
            throws IOException {
        List<Thread> started = new ArrayList<>();
        boolean interrupted = false;
        try {
            for (int i = 0; i < count; i++) {
                final int worker = i;
                Thread thread = new Thread(() -> {
                    try { checkRunning(failure); task.run(worker); }
                    catch (Throwable e) { failure.compareAndSet(null, e); }
                }, "converter-" + (i + 1));
                thread.start();
                started.add(thread);
            }
        } catch (Throwable e) { failure.compareAndSet(null, e); }
        // No se borran .part ni se publica META mientras algún worker sigue escribiendo.
        for (Thread thread : started) {
            boolean joined = false;
            while (!joined) {
                try { thread.join(); joined = true; }
                catch (InterruptedException e) {
                    interrupted = true;
                    failure.compareAndSet(null, e);
                    for (Thread other : started) other.interrupt();
                }
            }
        }
        if (interrupted) Thread.currentThread().interrupt();
        Throwable error = failure.get();
        if (error != null) throw new IOException("Falló el procesamiento paralelo: " + error, error);
    }

    private static final class WorkerOutputs implements AutoCloseable {
        final FileChannel[] channels;
        WorkerOutputs(Path directory, List<LevelInfo> levels) throws IOException {
            channels = new FileChannel[levels.size()];
            try {
                for (int i = 0; i < levels.size(); i++)
                    channels[i] = FileChannel.open(directory.resolve(levels.get(i).fileName + ".part"), StandardOpenOption.WRITE);
            } catch (IOException | RuntimeException | Error e) {
                try { close(); } catch (IOException closeError) { e.addSuppressed(closeError); }
                throw e;
            }
        }
        public void close() throws IOException {
            IOException error = null;
            for (FileChannel channel : channels) {
                if (channel != null) {
                    try { channel.close(); }
                    catch (IOException e) { if (error == null) error = e; else error.addSuppressed(e); }
                }
            }
            if (error != null) throw error;
        }
    }

    private static final class PositionedOutputStream extends OutputStream {
        final FileChannel channel;
        long position;
        PositionedOutputStream(FileChannel channel, long position) { this.channel = channel; this.position = position; }
        public void write(int value) throws IOException { write(new byte[]{(byte) value}, 0, 1); }
        public void write(byte[] bytes, int offset, int length) throws IOException {
            writeFullyAt(channel, ByteBuffer.wrap(bytes, offset, length), position);
            position += length;
        }
    }

    private static final class Progress {
        final String label;
        final long total, start = System.nanoTime();
        long completed;
        int nextPercent = 1;
        Progress(String label, long total) { this.label = label; this.total = total; }
        synchronized void advance(long amount) {
            completed += amount;
            int percent = (int) (100.0 * completed / total);
            if (percent >= nextPercent || completed == total) {
                System.out.printf("%s: %3d%% | tiempo %s%n", label, percent, formatElapsedTime(System.nanoTime() - start));
                nextPercent = percent + 1;
            }
        }
    }

    private static void withIndependentReader(
            Path inputPath,
            boolean bigTiff,
            ReaderOperation operation
    ) throws IOException {

        try (ImageInputStream input = new FileImageInputStream(inputPath.toFile())) {
            ImageReader reader = selectReader(input);

            if (reader == null) {
                throw new IOException(
                        bigTiff
                                ? "No se encontró un ImageReader compatible con BigTIFF."
                                : "No se encontró un ImageReader compatible con el archivo."
                );
            }

            try {
                if (bigTiff && !isTwelveMonkeysReader(reader)) {
                    throw new IOException(
                            "El archivo es BigTIFF, pero el lector del worker no es TwelveMonkeys."
                    );
                }

                input.seek(0);
                reader.setInput(input, false, false);

                System.out.println(
                        "[" + Thread.currentThread().getName() + "] " +
                        "ImageInputStream propio abierto | ImageReader propio: " +
                        reader.getClass().getSimpleName()
                );

                operation.run(reader);
            } finally {
                reader.dispose();
            }
        }
    }

    private static void validateReaderDimensions(
            ImageReader reader,
            int expectedWidth,
            int expectedHeight
    ) throws IOException {
        int width = reader.getWidth(0);
        int height = reader.getHeight(0);

        if (width != expectedWidth || height != expectedHeight) {
            throw new IOException(
                    "El reader independiente reportó dimensiones diferentes. " +
                    "Esperado=" + expectedWidth + "x" + expectedHeight +
                    ", obtenido=" + width + "x" + height
            );
        }
    }

    private static void generateLevelFromPreviousRaw(
            Path sourceRawPath,
            LevelInfo sourceLevel,
            LevelInfo targetLevel,
            Path imageDirectory,
            int originalWidth,
            int originalHeight
    ) throws IOException {

        Path finalRawPath = imageDirectory.resolve(targetLevel.fileName);
        Path tempRawPath = imageDirectory.resolve(targetLevel.fileName + ".part");
        Files.deleteIfExists(tempRawPath);

        System.out.println();
        System.out.printf(
                Locale.US,
                "[%s] Generando level%d (1/%d) desde level%d (1/%d): " +
                "%,d x %,d | %s%n",
                Thread.currentThread().getName(),
                targetLevel.level,
                targetLevel.sampleFactor,
                sourceLevel.level,
                sourceLevel.sampleFactor,
                targetLevel.width,
                targetLevel.height,
                humanBytes(targetLevel.rawBytes)
        );

        Files.createFile(tempRawPath);
        int workerCount = Math.min(positiveProperty("converter.threads", DEFAULT_THREADS), targetLevel.height);
        AtomicReference<Throwable> failure = new AtomicReference<>();
        Progress progress = new Progress("level" + targetLevel.level, targetLevel.height);
        runWorkers(workerCount, failure, worker -> {
            int startRow = (int) ((long) targetLevel.height * worker / workerCount);
            int endRow = (int) ((long) targetLevel.height * (worker + 1) / workerCount);
            writeRawLevelAveragedFromPreviousRaw(sourceRawPath, sourceLevel, targetLevel,
                    originalWidth, originalHeight, tempRawPath, startRow, endRow, failure, progress);
        });

        finalizeGeneratedLevel(tempRawPath, finalRawPath, targetLevel);
        System.out.println(
                "[" + Thread.currentThread().getName() + "] level" +
                targetLevel.level + " terminado."
        );
    }

    private static void finalizeGeneratedLevel(
            Path tempRawPath,
            Path finalRawPath,
            LevelInfo level
    ) throws IOException {

        long generatedBytes = Files.size(tempRawPath);
        if (generatedBytes != level.rawBytes) {
            Files.deleteIfExists(tempRawPath);
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

    private static LevelInfo findLevelBySampleFactor(
            List<LevelInfo> levels,
            int sampleFactor
    ) {
        for (LevelInfo level : levels) {
            if (level.sampleFactor == sampleFactor) {
                return level;
            }
        }
        return null;
    }

    private static void writeRawLevelAveragedFromPreviousRaw(
            Path sourceRawPath,
            LevelInfo sourceLevel,
            LevelInfo targetLevel,
            int originalWidth,
            int originalHeight,
            Path rawPath, int startRow, int endRow,
            AtomicReference<Throwable> failure, Progress progress
    ) throws IOException {

        if (targetLevel.sampleFactor != sourceLevel.sampleFactor * 2) {
            throw new IOException("La reducción RAW encadenada debe ser exactamente 2x.");
        }

        int expectedWidth = ceilDiv(sourceLevel.width, 2);
        int expectedHeight = ceilDiv(sourceLevel.height, 2);

        if (targetLevel.width != expectedWidth || targetLevel.height != expectedHeight) {
            throw new IOException(
                    "Dimensiones incompatibles en reducción RAW encadenada. " +
                    "Esperado=" + expectedWidth + "x" + expectedHeight +
                    ", target=" + targetLevel.width + "x" + targetLevel.height
            );
        }

        long expectedSourceBytes = Math.multiplyExact(
                Math.multiplyExact((long) sourceLevel.width, (long) sourceLevel.height),
                4L
        );
        long actualSourceBytes = Files.size(sourceRawPath);

        if (actualSourceBytes != expectedSourceBytes) {
            throw new IOException(
                    "El RAW fuente tiene tamaño inesperado: " + sourceRawPath +
                    ". Esperado=" + expectedSourceBytes +
                    ", actual=" + actualSourceBytes
            );
        }

        int chunkOutputPixels = Math.max(
                1,
                Math.min(targetLevel.width, RAW_CHAIN_OUTPUT_CHUNK_PIXELS)
        );

        byte[] topRow = new byte[Math.multiplyExact(chunkOutputPixels * 2, 4)];
        byte[] bottomRow = new byte[topRow.length];

        long bytesWritten;
        try (
                FileChannel sourceChannel = FileChannel.open(
                        sourceRawPath,
                        StandardOpenOption.READ
                );
                FileChannel targetChannel = FileChannel.open(rawPath, StandardOpenOption.WRITE)
        ) {
            OutputStream out = new PositionedOutputStream(targetChannel, (long) startRow * targetLevel.width * 4L);
            RawBufferWriter writer = new RawBufferWriter(out);

            for (int outputY = startRow; outputY < endRow; outputY++) {
                checkRunning(failure);
                int sourceY0 = outputY * 2;
                int sourceY1 = sourceY0 + 1;
                boolean hasBottomRow = sourceY1 < sourceLevel.height;

                for (int outputX = 0;
                     outputX < targetLevel.width;
                     outputX += chunkOutputPixels) {

                    int outputCount = Math.min(
                            chunkOutputPixels,
                            targetLevel.width - outputX
                    );

                    int sourceX = outputX * 2;
                    int sourcePixelCount = Math.min(
                            outputCount * 2,
                            sourceLevel.width - sourceX
                    );
                    int sourceByteCount = Math.multiplyExact(sourcePixelCount, 4);

                    long topPosition = Math.multiplyExact(
                            Math.addExact(
                                    Math.multiplyExact((long) sourceY0, (long) sourceLevel.width),
                                    (long) sourceX
                            ),
                            4L
                    );

                    readFullyAt(
                            sourceChannel,
                            ByteBuffer.wrap(topRow, 0, sourceByteCount),
                            topPosition
                    );

                    if (hasBottomRow) {
                        long bottomPosition = Math.multiplyExact(
                                Math.addExact(
                                        Math.multiplyExact((long) sourceY1, (long) sourceLevel.width),
                                        (long) sourceX
                                ),
                                4L
                        );

                        readFullyAt(
                                sourceChannel,
                                ByteBuffer.wrap(bottomRow, 0, sourceByteCount),
                                bottomPosition
                        );
                    }

                    for (int i = 0; i < outputCount; i++) {
                        int localSourceX0 = i * 2;
                        int horizontalPixels = Math.min(2, sourcePixelCount - localSourceX0);
                        int rowCount = hasBottomRow ? 2 : 1;

                        long sumR = 0L;
                        long sumG = 0L;
                        long sumB = 0L;
                        long sumA = 0L;
                        long totalWeight = 0L;

                        /*
                         * Los píxeles del borde pueden representar menos píxeles
                         * originales que los píxeles interiores. Por eso no se
                         * promedian todos con peso 1: se pondera cada promedio
                         * previo por la cantidad real de píxeles originales que
                         * representa. Así evitamos distorsionar los bordes cuando
                         * el ancho/alto original no es divisible por 8, 16, etc.
                         */
                        for (int dy = 0; dy < rowCount; dy++) {
                            int globalSourceY = sourceY0 + dy;
                            int representedHeight = Math.min(
                                    sourceLevel.sampleFactor,
                                    originalHeight - globalSourceY * sourceLevel.sampleFactor
                            );
                            byte[] row = dy == 0 ? topRow : bottomRow;

                            for (int dx = 0; dx < horizontalPixels; dx++) {
                                int globalSourceX = sourceX + localSourceX0 + dx;
                                int representedWidth = Math.min(
                                        sourceLevel.sampleFactor,
                                        originalWidth - globalSourceX * sourceLevel.sampleFactor
                                );
                                long weight = Math.multiplyExact(
                                        (long) representedWidth,
                                        (long) representedHeight
                                );
                                int byteIndex = (localSourceX0 + dx) * 4;

                                sumR += (row[byteIndex] & 0xFF) * weight;
                                sumG += (row[byteIndex + 1] & 0xFF) * weight;
                                sumB += (row[byteIndex + 2] & 0xFF) * weight;
                                sumA += (row[byteIndex + 3] & 0xFF) * weight;
                                totalWeight += weight;
                            }
                        }

                        writer.writeRgba(
                                roundedAverage(sumR, totalWeight),
                                roundedAverage(sumG, totalWeight),
                                roundedAverage(sumB, totalWeight),
                                roundedAverage(sumA, totalWeight)
                        );
                    }
                }

                progress.advance(1);
            }

            writer.finish();
            bytesWritten = writer.getBytesWritten();

        }

        long expectedBytes = (long) (endRow - startRow) * targetLevel.width * 4L;
        if (bytesWritten != expectedBytes) {
            throw new IOException("Cantidad de bytes RAW incorrecta en worker de level" + targetLevel.level);
        }
    }

    private static void readFullyAt(
            FileChannel channel,
            ByteBuffer buffer,
            long position
    ) throws IOException {
        long currentPosition = position;

        while (buffer.hasRemaining()) {
            int read = channel.read(buffer, currentPosition);

            if (read < 0) {
                throw new IOException(
                        "EOF inesperado leyendo RAW en posición " + currentPosition
                );
            }

            if (read == 0) {
                Thread.yield();
                continue;
            }

            currentPosition += read;
        }
    }

    private static String formatElapsedTime(long elapsedNanos) {
        long totalSeconds = Math.max(0L, elapsedNanos / 1_000_000_000L);
        long hours = totalSeconds / 3600L;
        long minutes = (totalSeconds % 3600L) / 60L;
        long seconds = totalSeconds % 60L;

        return String.format(Locale.US, "%02d:%02d:%02d", hours, minutes, seconds);
    }

    @FunctionalInterface
    private interface WorkerOperation {
        void run(int worker) throws Exception;
    }

    @FunctionalInterface
    private interface ReaderOperation {
        void run(ImageReader reader) throws IOException;
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

    private static int roundedAverage(long sum, long count) throws IOException {
        if (count <= 0L) {
            throw new IOException("No hay píxeles para calcular el promedio.");
        }

        return (int) ((sum + count / 2L) / count);
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

    private static final class RawBufferWriter {
        private final OutputStream out;
        private final byte[] buffer = new byte[OUTPUT_BUFFER_SIZE];
        private int position = 0;
        private long bytesWritten = 0L;

        RawBufferWriter(OutputStream out) {
            this.out = out;
        }

        void writeRgba(int r, int g, int b, int a) throws IOException {
            if (position + 4 > buffer.length) {
                flushBuffer();
            }

            buffer[position++] = (byte) r;
            buffer[position++] = (byte) g;
            buffer[position++] = (byte) b;
            buffer[position++] = (byte) a;
        }

        long getBytesWritten() {
            return bytesWritten + position;
        }

        void finish() throws IOException {
            flushBuffer();
            out.flush();
        }

        private void flushBuffer() throws IOException {
            if (position == 0) {
                return;
            }

            out.write(buffer, 0, position);
            bytesWritten += position;
            position = 0;
        }
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
