import jsQR from "jsqr";

/** Lado máximo al analizar una imagen: más grande solo hace lento a jsQR. */
const MAX_SIDE = 1600;

/** Lee el QR de una imagen (archivo elegido o pegada); null si no hay. */
export async function decodeQrImage(blob: Blob): Promise<string | null> {
  const bitmap = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0, w, h);
    return decodeQrPixels(ctx.getImageData(0, 0, w, h));
  } finally {
    bitmap.close();
  }
}

/** QR en un cuadro (imagen o video); acepta QR claros sobre fondo oscuro. */
export function decodeQrPixels(image: ImageData): string | null {
  return jsQR(image.data, image.width, image.height, { inversionAttempts: "attemptBoth" })?.data ?? null;
}
