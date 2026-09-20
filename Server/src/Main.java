import java.nio.file.Files;
import java.nio.file.Path;

public class Main {

    public static void main(String[] args) throws Exception {
        int port = 8080;

        Path imagesDirectory = resolveImagesDirectory();

        System.out.println("==========================================");
        System.out.println("Directorio de ejecución:");
        System.out.println(Path.of("").toAbsolutePath().normalize());

        System.out.println();
        System.out.println("Directorio de imágenes encontrado:");
        System.out.println(imagesDirectory);

        System.out.println("==========================================");

        ImageServer server = new ImageServer(port, imagesDirectory);
        server.start();
    }

    private static Path resolveImagesDirectory() {

        Path current = Path.of("").toAbsolutePath().normalize();

        /*
         * Buscamos hacia arriba porque Java puede estar ejecutándose desde:
         *
         * Proyecto2cc8/
         * Proyecto2cc8/Server/
         * Proyecto2cc8/Server/src/
         * Proyecto2cc8/Server/out/
         *
         * etc.
         */
        Path base = current;

        while (base != null) {

            // Caso:
            //
            // Server/
            // ├── Imagenes/
            // │   └── images/
            //
            Path directCandidate =
                    base.resolve("Imagenes")
                            .resolve("images")
                            .normalize();

            if (Files.isDirectory(directCandidate)) {
                return directCandidate;
            }

            // Caso:
            //
            // Proyecto2cc8/
            // └── Server/
            //     └── Imagenes/
            //         └── images/
            //
            Path serverCandidate =
                    base.resolve("Server")
                            .resolve("Imagenes")
                            .resolve("images")
                            .normalize();

            if (Files.isDirectory(serverCandidate)) {
                return serverCandidate;
            }

            base = base.getParent();
        }

        throw new IllegalStateException(
                "No se encontró la carpeta Imagenes/images.\n" +
                "Se esperaba una estructura como:\n" +
                "Server/Imagenes/images/"
        );
    }
}