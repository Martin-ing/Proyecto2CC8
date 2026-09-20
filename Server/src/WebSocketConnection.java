import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

public class WebSocketConnection {
    private static final int MAX_PAYLOAD_SIZE = 16 * 1024 * 1024;

    private final InputStream input;
    private final OutputStream output;
    private boolean closed;

    public WebSocketConnection(InputStream input, OutputStream output) {
        this.input = input;
        this.output = output;
    }

    public String readTextMessage() throws IOException {
        while (!closed) {
            int first = input.read();
            if (first == -1) {
                return null;
            }

            int second = input.read();
            if (second == -1) {
                throw new EOFException("Frame WebSocket incompleto");
            }

            boolean fin = (first & 0x80) != 0;
            int opcode = first & 0x0F;
            boolean masked = (second & 0x80) != 0;
            long payloadLength = second & 0x7F;

            if (!fin) {
                throw new IOException("Este primer avance no admite mensajes WebSocket fragmentados");
            }

            if (payloadLength == 126) {
                payloadLength = readUnsignedShort();
            } else if (payloadLength == 127) {
                payloadLength = readUnsignedLong();
            }

            if (payloadLength < 0 || payloadLength > MAX_PAYLOAD_SIZE) {
                throw new IOException("Payload WebSocket demasiado grande: " + payloadLength);
            }

            if (!masked) {
                throw new IOException("El frame recibido del cliente no está enmascarado");
            }

            byte[] mask = readExactly(4);
            byte[] payload = readExactly((int) payloadLength);

            for (int i = 0; i < payload.length; i++) {
                payload[i] = (byte) (payload[i] ^ mask[i % 4]);
            }

            switch (opcode) {
                case 0x1:
                    return new String(payload, StandardCharsets.UTF_8);
                case 0x2:
                    throw new IOException("No se esperan frames binarios desde el cliente todavía");
                case 0x8:
                    sendClose();
                    closed = true;
                    return null;
                case 0x9:
                    sendFrame(0xA, payload);
                    break;
                case 0xA:
                    break;
                default:
                    throw new IOException("Opcode WebSocket no soportado: " + opcode);
            }
        }

        return null;
    }

    public void sendText(String message) throws IOException {
        sendFrame(0x1, message.getBytes(StandardCharsets.UTF_8));
    }

    public void sendBinary(byte[] payload) throws IOException {
        sendFrame(0x2, payload);
    }

    public void sendBinary(byte[] payload, int offset, int length) throws IOException {
        if (offset == 0 && length == payload.length) {
            sendBinary(payload);
            return;
        }
        sendFrame(0x2, Arrays.copyOfRange(payload, offset, offset + length));
    }

    public void sendClose() throws IOException {
        if (!closed) {
            sendFrame(0x8, new byte[0]);
        }
    }

    private synchronized void sendFrame(int opcode, byte[] payload) throws IOException {
        output.write(0x80 | opcode); // FIN=1

        int length = payload.length;
        if (length <= 125) {
            output.write(length);
        } else if (length <= 0xFFFF) {
            output.write(126);
            output.write((length >>> 8) & 0xFF);
            output.write(length & 0xFF);
        } else {
            output.write(127);
            long longLength = length;
            for (int shift = 56; shift >= 0; shift -= 8) {
                output.write((int) ((longLength >>> shift) & 0xFF));
            }
        }

        output.write(payload);
        output.flush();
    }

    private int readUnsignedShort() throws IOException {
        byte[] bytes = readExactly(2);
        return ((bytes[0] & 0xFF) << 8) | (bytes[1] & 0xFF);
    }

    private long readUnsignedLong() throws IOException {
        byte[] bytes = readExactly(8);
        return ByteBuffer.wrap(bytes).getLong();
    }

    private byte[] readExactly(int length) throws IOException {
        byte[] data = input.readNBytes(length);
        if (data.length != length) {
            throw new EOFException("Se esperaban " + length + " bytes y llegaron " + data.length);
        }
        return data;
    }
}
