import { writeText } from "../platform";

/**
 * Copia texto al portapapeles del sistema. Usa el plugin nativo: en Android
 * el WebView no es un contexto seguro y `navigator.clipboard` puede no existir.
 */
export async function copyText(text: string): Promise<void> {
  try {
    await writeText(text);
  } catch {
    await navigator.clipboard.writeText(text);
  }
}
