import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Optional;
import java.util.stream.Stream;

public class ImageCatalog {
    private final Path imagesDirectory;

    public ImageCatalog(Path imagesDirectory) {
        this.imagesDirectory = imagesDirectory;
    }

    public List<ImageMeta> listAvailableImages() throws IOException {

        System.out.println();
        System.out.println("[CATALOGO] Buscando imágenes en:");
        System.out.println("[CATALOGO] " + imagesDirectory.toAbsolutePath());

        if (!Files.isDirectory(imagesDirectory)) {
            throw new IOException(
                    "No existe el directorio de imágenes: "
                            + imagesDirectory.toAbsolutePath()
            );
        }

        List<ImageMeta> result = new ArrayList<>();

        try (Stream<Path> folders = Files.list(imagesDirectory)) {

            List<Path> directories = folders
                    .filter(Files::isDirectory)
                    .toList();

            System.out.println(
                    "[CATALOGO] Carpetas encontradas: "
                            + directories.size()
            );

            for (Path folder : directories) {

                System.out.println(
                        "[CATALOGO] Revisando: "
                                + folder.getFileName()
                );

                Optional<Path> metaFile =
                        findFirstFileWithExtension(folder, ".meta");

                if (metaFile.isEmpty()) {
                    System.out.println(
                            "[CATALOGO]   -> No contiene archivo .meta"
                    );
                    continue;
                }

                System.out.println(
                        "[CATALOGO]   -> META encontrado: "
                                + metaFile.get().getFileName()
                );

                try {

                    ImageMeta meta =
                            ImageMeta.fromFile(metaFile.get());

                    result.add(meta);

                    System.out.println(
                            "[CATALOGO]   -> Imagen cargada correctamente: "
                                    + meta.id()
                                    + " | "
                                    + meta.name()
                    );

                } catch (Exception e) {

                    System.err.println(
                            "[CATALOGO]   -> ERROR leyendo metadata:"
                    );

                    System.err.println(
                            "[CATALOGO]      " + e.getMessage()
                    );

                    e.printStackTrace();
                }
            }
        }

        result.sort(
                Comparator.comparing(ImageMeta::id)
        );

        System.out.println(
                "[CATALOGO] Total de imágenes válidas: "
                        + result.size()
        );

        return result;
    }

    public Optional<ImageMeta> findById(String imageId) throws IOException {
        return listAvailableImages().stream()
                .filter(image -> image.id().equals(imageId))
                .findFirst();
    }

    private Optional<Path> findFirstFileWithExtension(Path directory, String extension)
            throws IOException {
        try (Stream<Path> files = Files.list(directory)) {
            return files
                    .filter(Files::isRegularFile)
                    .filter(path -> path.getFileName().toString().toLowerCase().endsWith(extension))
                    .sorted()
                    .findFirst();
        }
    }
}
