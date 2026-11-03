import { describe, expect, it } from "vitest";
import QRCode from "qrcode";
import jsQR from "jsqr";
import type { ConnectionConfig, SavedConnection } from "../ipc/types";
import {
  addScan,
  emptyScan,
  exportFileText,
  extractTokens,
  missingParts,
  planImport,
  splitForQr,
  type ScanProgress,
} from "./connTransfer";

const token = (len: number) =>
  "ZNH1." + Array.from({ length: len }, (_, i) => "Ab9_-x"[i % 6]).join("");

describe("extractTokens", () => {
  it("lee el .txt exportado ignorando comentarios", () => {
    const t = token(50);
    expect(extractTokens(exportFileText(t, 2))).toEqual([t]);
  });

  it("une líneas cortadas y separa varios paquetes", () => {
    const a = token(40);
    const b = "ZNH1.zzzz";
    expect(extractTokens(`${a.slice(0, 10)}\n  ${a.slice(10)}\n${b}\n`)).toEqual([a, b]);
    expect(extractTokens("nada por acá")).toEqual([]);
  });
});

describe("QR en partes", () => {
  it("un paquete corto va en un solo QR", () => {
    const t = token(100);
    expect(splitForQr(t)).toEqual([t]);
    expect(addScan(emptyScan(), t)).toMatchObject({ kind: "token", token: t });
  });

  it("junta las partes en cualquier orden y avisa las que faltan", () => {
    const t = token(2000);
    const parts = splitForQr(t, 700);
    expect(parts).toHaveLength(3);
    let progress: ScanProgress = emptyScan();
    for (const p of [parts[2], parts[0], parts[2]]) {
      const r = addScan(progress, p);
      expect(r.kind).toBe("partial");
      progress = r.progress;
    }
    expect(missingParts(progress)).toEqual([2]);
    expect(addScan(progress, parts[1])).toMatchObject({ kind: "token", token: t });
  });

  it("una parte de otro export reinicia la lectura", () => {
    const a = splitForQr(token(1500), 700);
    const b = splitForQr("ZNH1.OTRO" + token(1500).slice(9), 700);
    const first = addScan(emptyScan(), a[0]).progress;
    const r = addScan(first, b[1]);
    expect(r.kind).toBe("partial");
    expect(missingParts(r.progress)).toEqual([1, 3]);
  });

  it("rechaza QR ajenos", () => {
    expect(addScan(emptyScan(), "https://example.com").kind).toBe("invalid");
  });

  it("cada parte se puede codificar y leer como QR", async () => {
    const t = token(1600);
    for (const part of splitForQr(t)) {
      const qr = QRCode.create(part, { errorCorrectionLevel: "M" });
      const n = qr.modules.size;
      const scale = 4;
      const margin = 4;
      const side = (n + margin * 2) * scale;
      const pixels = new Uint8ClampedArray(side * side * 4).fill(255);
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          if (!qr.modules.get(y, x)) continue;
          for (let dy = 0; dy < scale; dy++) {
            for (let dx = 0; dx < scale; dx++) {
              const i = (((y + margin) * scale + dy) * side + (x + margin) * scale + dx) * 4;
              pixels[i] = pixels[i + 1] = pixels[i + 2] = 0;
            }
          }
        }
      }
      expect(jsQR(pixels, side, side)?.data).toBe(part);
    }
  });
});

describe("planImport", () => {
  const conn = (id: string, group: string | null): ConnectionConfig => ({
    id,
    name: id,
    engine: "postgres",
    host: "h",
    port: 5432,
    database: "d",
    user: "u",
    password: "p",
    useTls: false,
    safeMode: true,
    group,
  });
  const saved = [{ ...conn("a", "Prod"), hasPassword: true }] as SavedConnection[];

  it("usa el grupo existente o lo crea, y marca los reemplazos", () => {
    const plan = planImport(
      [conn("a", "prod"), conn("b", " Staging "), conn("c", "staging"), conn("d", null)],
      saved,
      ["Prod"],
    );
    expect(plan.map((p) => [p.config.id, p.config.group, p.replaces, p.newGroup])).toEqual([
      ["a", "Prod", true, false],
      ["b", "Staging", false, true],
      ["c", "Staging", false, true],
      ["d", null, false, false],
    ]);
  });
});
