public record TileId(
        String imageId,
        int zoom,
        int tileX,
        int tileY
) {
    @Override
    public String toString() {
        return imageId + ":" + zoom + ":" + tileX + ":" + tileY;
    }
}
