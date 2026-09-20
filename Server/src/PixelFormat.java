public enum PixelFormat {
    RGBA4444(2),
    RGBA8888(4);

    private final int bytesPerPixel;

    PixelFormat(int bytesPerPixel) {
        this.bytesPerPixel = bytesPerPixel;
    }

    public int bytesPerPixel() {
        return bytesPerPixel;
    }

    public String protocolName() {
        return name();
    }

    public static PixelFormat fromProtocol(String value) {
        if (value == null) {
            return null;
        }

        try {
            return PixelFormat.valueOf(value.trim().toUpperCase());
        } catch (IllegalArgumentException e) {
            return null;
        }
    }
}
