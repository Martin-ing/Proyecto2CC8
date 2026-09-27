import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.FileTime;

/** Identidad del contenido, independiente de viewId, streamId y sessionId. */
public record ImageCacheKey(
        String imageId, SourceVersion source, int zoom, int virtualSize,
        int width, int height, int offsetX, int offsetY, int tileSize,
        PixelFormat format, String kind, int x, int y, int bytes
) {
    public ImageCacheKey {
        if (bytes <= 0) throw new IllegalArgumentException("El contenido debe tener bytes");
    }

    public record SourceVersion(Path path, long size, FileTime modified, String fileKey) {
        public static SourceVersion capture(Path path) throws IOException {
            Path canonical = path.toRealPath();
            BasicFileAttributes attributes = Files.readAttributes(canonical, BasicFileAttributes.class);
            return new SourceVersion(canonical, attributes.size(), attributes.lastModifiedTime(),
                    String.valueOf(attributes.fileKey()));
        }
        public void verifyUnchanged() throws IOException {
            if (!equals(capture(path))) throw new IOException("El RAW cambió durante la lectura; vuelve a abrir la imagen");
        }
    }

    public static ImageCacheKey of(ImageMeta image, ImageLevel level, SourceVersion source,
                                   PixelFormat format, String kind, int x, int y, int bytes) {
        return new ImageCacheKey(image.id(), source, level.zoom(), level.virtualSize(),
                level.width(), level.height(), level.offsetX(), level.offsetY(), image.tileSize(),
                format, kind, x, y, bytes);
    }
}
