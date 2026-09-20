import java.nio.file.Path;

public record ImageLevel(
        int zoom,
        String fileName,
        int virtualSize,
        int width,
        int height,
        int offsetX,
        int offsetY,
        Path rawPath
) {
}
