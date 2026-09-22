export const bytesPerPixel = format => format === 'RGBA8888' ? 4 : format === 'RGBA4444' ? 2 : 0;

export function decodePixels(buffer, width, height, format) {
  const bpp = bytesPerPixel(format);
  if (!bpp || buffer.byteLength !== width * height * bpp) {
    throw new Error(`Buffer ${format} inválido para ${width} × ${height}.`);
  }
  if (bpp === 4) return new Uint8ClampedArray(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let source = 0, destination = 0; source < buffer.length; source += 2, destination += 4) {
    pixels[destination] = (buffer[source] >>> 4) * 17;
    pixels[destination + 1] = (buffer[source] & 15) * 17;
    pixels[destination + 2] = (buffer[source + 1] >>> 4) * 17;
    pixels[destination + 3] = (buffer[source + 1] & 15) * 17;
  }
  return pixels;
}

export function pixelSurface(buffer, width, height, format) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').putImageData(new ImageData(decodePixels(buffer, width, height, format), width, height), 0, 0);
  return canvas;
}

export function releaseSurface(surface) {
  if (surface) { surface.width = 0; surface.height = 0; }
}
