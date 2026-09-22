public enum DataChannel {
    CURRENT,
    PREVIOUS,
    NEXT;

    public static DataChannel fromProtocol(String value) {
        if (value == null) {
            return null;
        }
        try {
            return DataChannel.valueOf(value.trim().toUpperCase());
        } catch (IllegalArgumentException e) {
            return null;
        }
    }
}
