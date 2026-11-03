import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Format,
  cancel,
  checkPermissions,
  requestPermissions,
  scan,
} from "@tauri-apps/plugin-barcode-scanner";
import { useT } from "../../i18n";
import { errorMessage } from "../../ipc/commands";
import { decodeQrPixels } from "../../lib/qrImage";

interface Props {
  /** Teléfono: cámara nativa (plugin); desktop: webcam del WebView. */
  native: boolean;
  /** Progreso a mostrar mientras se escanea (p. ej. "2 de 5"). */
  status: string | null;
  /** Cada QR leído; el padre decide cuándo cerrar (desmontando). */
  onText: (text: string) => void;
  onClose: () => void;
  onError: (message: string) => void;
}

/** Lector de QR: sigue leyendo hasta que el padre lo cierra. */
export default function QrScanner(props: Props) {
  return props.native ? <NativeScanner {...props} /> : <WebcamScanner {...props} />;
}

/**
 * Android/iOS: el plugin pone la cámara detrás del WebView (`windowed`), así
 * que mientras escanea la app se oculta y queda solo este overlay.
 */
function NativeScanner({ status, onText, onClose, onError }: Props) {
  const t = useT();
  const handlers = useRef({ onText, onError });
  handlers.current = { onText, onError };

  useEffect(() => {
    let active = true;
    document.documentElement.classList.add("qr-scanning");
    void (async () => {
      try {
        let perm = await checkPermissions();
        if (perm !== "granted") perm = await requestPermissions();
        if (perm !== "granted") throw new Error(t("transfer.cameraDenied"));
        while (active) {
          const { content } = await scan({ windowed: true, formats: [Format.QRCode] });
          if (active) handlers.current.onText(content);
        }
      } catch (e) {
        if (active) handlers.current.onError(errorMessage(e));
      }
    })();
    return () => {
      active = false;
      document.documentElement.classList.remove("qr-scanning");
      void cancel().catch(() => {});
    };
  }, [t]);

  return createPortal(
    <div className="qr-scan-overlay">
      <div className="qr-scan-frame" />
      <p>{status ?? t("transfer.pointCamera")}</p>
      <button onClick={onClose}>{t("common.cancel")}</button>
    </div>,
    document.body,
  );
}

/** Desktop: webcam vía getUserMedia, analizando cuadros con jsQR. */
function WebcamScanner({ status, onText, onClose, onError }: Props) {
  const t = useT();
  const video = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);
  const handlers = useRef({ onText, onError });
  handlers.current = { onText, onError };

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer = 0;
    let stopped = false;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    let last = "";

    const tick = () => {
      const v = video.current;
      if (stopped || !v) return;
      if (v.readyState >= v.HAVE_CURRENT_DATA && v.videoWidth > 0) {
        canvas.width = v.videoWidth;
        canvas.height = v.videoHeight;
        ctx.drawImage(v, 0, 0);
        const text = decodeQrPixels(ctx.getImageData(0, 0, canvas.width, canvas.height));
        // El mismo QR queda frente a la cámara varios cuadros seguidos.
        if (text && text !== last) {
          last = text;
          handlers.current.onText(text);
        }
      }
      timer = window.setTimeout(tick, 200);
    };

    void (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error(t("transfer.noWebcam"));
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
        });
        if (stopped) return;
        const v = video.current!;
        v.srcObject = stream;
        await v.play();
        setReady(true);
        tick();
      } catch (e) {
        if (!stopped) handlers.current.onError(errorMessage(e) || t("transfer.noWebcam"));
      }
    })();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [t]);

  return (
    <div className="qr-webcam">
      <video ref={video} muted playsInline />
      <p className="dim">{ready ? (status ?? t("transfer.pointCamera")) : t("transfer.startingCamera")}</p>
      <button type="button" onClick={onClose}>
        {t("transfer.stopCamera")}
      </button>
    </div>
  );
}
