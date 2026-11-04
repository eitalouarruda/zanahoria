type Handler = (event: { payload: any }) => void;
const api = "/api/zanahoria";
const handlers = new Map<string, Set<Handler>>();
const pendingDownloads = new Map<string, string>();
const finishedJobs = new Map<string, boolean>();
let boot: Promise<string> | null = null;
let socket: WebSocket | null = null;
let ready: Promise<void> = Promise.resolve();
let after = 0;
let expired = false;
let generation = 0;
let reconnect: ReturnType<typeof setTimeout> | undefined;
function status(message: string) { window.dispatchEvent(new CustomEvent("zanahoria:status", { detail: message })); }
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(api + path, init);
  if (!r.ok) {
    if (r.status === 401) { expired = true; socket?.close(); status("Tu sesión de Quimera expiró. Vuelve a ingresar para continuar."); }
    const body = await r.text(); let message = body;
    try { message = JSON.parse(body).message ?? body; } catch { /* plain HTTP error */ }
    throw new Error(message);
  }
  return r.status === 204 ? undefined as T : r.json();
}
function connect(id: string) {
  clearTimeout(reconnect);
  const current = ++generation;
  ready = new Promise<void>((resolve, reject) => {
    socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${api}/client/${id}/events?after=${after}`);
    const timeout = window.setTimeout(() => { reject(new Error("No se pudo conectar con Zanahoria")); socket?.close(); }, 10000);
    socket.onopen = () => { clearTimeout(timeout); status(""); resolve(); };
    socket.onerror = () => { clearTimeout(timeout); reject(new Error("No se pudo conectar con Zanahoria")); };
    socket.onmessage = (message) => {
      const event = JSON.parse(message.data);
      if (event.type === "gap") { status(event.message); return; }
      if (event.seq <= after) return;
      after = event.seq;
      for (const handler of handlers.get(event.event) ?? []) { try { handler({ payload: event.payload }); } catch (e) { console.error(e); } }
      if (event.event === "backup:event" && event.payload.kind === "done") {
        finishedJobs.set(event.payload.jobId, event.payload.success);
        finishDownload(event.payload.jobId);
      }
    };
    socket.onclose = () => {
      if (current !== generation) return;
      clearTimeout(timeout);
      reject(new Error("La conexión con Zanahoria se cerró"));
      if (expired) return;
      status("Reconectando con Zanahoria…");
      reconnect = window.setTimeout(() => { void request(`/client/${id}/files`).then(() => connect(id)).catch(e => status(String(e))); }, 1200);
    };
  });
  void ready.catch(() => {});
}
async function client(): Promise<string> {
  if (!boot) boot = (async () => {
    let id = sessionStorage.getItem("zanahoria-web-client");
    if (id) { try { await request(`/client/${id}/files`); } catch { if (expired) throw new Error("Inicia sesión en Quimera"); id = null; } }
    if (!id) { id = (await request<{ id: string }>("/client", { method: "POST" })).id; sessionStorage.setItem("zanahoria-web-client", id); }
    connect(id); await ready; return id;
  })().catch(e => { boot = null; status(String(e)); throw e; });
  return boot;
}
export async function listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void> {
  const set = handlers.get(event) ?? new Set<Handler>(); handlers.set(event, set); set.add(handler);
  void client().catch(e => status(String(e)));
  return () => { set.delete(handler); };
}
export async function invoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const id = await client(); await ready;
  const value = await request<T>(`/client/${id}/rpc/${command}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(args) });
  if (["save_text_file", "export_query", "export_rows", "sqlite_backup"].includes(command)) await downloadFile(String(args.path ?? args.dest));
  if (command === "start_backup") { const [job] = value as [string, string]; pendingDownloads.set(job, (args.options as { output: string }).output); finishDownload(job); }
  return value;
}
function finishDownload(job: string) {
  const path = pendingDownloads.get(job);
  if (!path || !finishedJobs.has(job)) return;
  pendingDownloads.delete(job);
  if (finishedJobs.get(job)) void downloadFile(path).catch(e => status(String(e)));
  finishedJobs.delete(job);
}
export async function downloadFile(path: string) {
  const id = await client(); const name = path.split("/").pop()!;
  const a = document.createElement("a"); a.href = `${api}/client/${id}/files/${encodeURIComponent(name)}`; a.download = name.slice(37); document.body.append(a); a.click(); a.remove();
}
export type ServerFile = { name: string; path: string; size: number };
export async function listFiles(): Promise<ServerFile[]> { return request(`/client/${await client()}/files`); }
export async function deleteFile(name: string) { return request(`/client/${await client()}/files/${encodeURIComponent(name)}`, { method: "DELETE" }); }
async function allocate(name: string): Promise<{ path: string; name: string }> {
  return request(`/client/${await client()}/files`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
}
export async function uploadFile(file: File): Promise<string> {
  const id = await client(); const target = await allocate(file.name);
  const result = await request<{ path: string }>(`/client/${id}/files/${encodeURIComponent(target.name)}`, { method: "PUT", body: file, headers: { "Content-Type": "application/octet-stream" } });
  return result.path;
}
export async function saveFile(defaultName: string): Promise<string | null> {
  const value = await fileDialog("Guardar archivo", async (dialog, finish) => {
    const label = document.createElement("label"); label.textContent = "Nombre del archivo";
    const input = document.createElement("input"); input.value = defaultName.split(/[\\/]/).pop() || "export.txt"; input.setAttribute("aria-label", "Nombre del archivo"); label.append(input); dialog.append(label);
    const button = document.createElement("button"); button.textContent = "Guardar"; button.className = "primary";
    button.onclick = () => { button.disabled = true; void allocate(input.value).then(f => finish(f.path)).catch(e => { button.disabled = false; alert(String(e)); }); }; dialog.append(button); input.focus();
  }); return value;
}
export async function pickFile(): Promise<string | null> {
  return fileDialog("Seleccionar archivo", async (dialog, finish) => {
    const hint = document.createElement("p"); hint.textContent = "Los archivos se guardan en el servidor de Quimera. Seleccionar un SQLite local sube una copia."; hint.className = "dim"; dialog.append(hint);
    const input = document.createElement("input"); input.type = "file"; input.setAttribute("aria-label", "Subir archivo");
    input.onchange = () => { if (input.files?.[0]) { input.disabled = true; void uploadFile(input.files[0]).then(finish).catch(e => { input.disabled = false; alert(String(e)); }); } }; dialog.append(input);
    const files = await listFiles();
    for (const file of files) { const b = document.createElement("button"); b.textContent = file.name.slice(37) + ` (${Math.ceil(file.size / 1024)} KB)`; b.onclick = () => finish(file.path); dialog.append(b); }
  });
}
function fileDialog(title: string, setup: (dialog: HTMLElement, finish: (path: string | null) => void) => Promise<void>): Promise<string | null> {
  return new Promise(resolve => {
    const backdrop = document.createElement("div"); backdrop.className = "modal-backdrop web-file-dialog";
    const dialog = document.createElement("section"); dialog.className = "modal"; dialog.setAttribute("role", "dialog"); dialog.setAttribute("aria-modal", "true"); dialog.setAttribute("aria-label", title);
    const heading = document.createElement("h3"); heading.textContent = title; dialog.append(heading);
    const previous = document.activeElement as HTMLElement | null;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") finish(null); };
    function finish(path: string | null) { document.removeEventListener("keydown", key, true); backdrop.remove(); previous?.focus(); resolve(path); }
    document.addEventListener("keydown", key, true);
    const cancel = document.createElement("button"); cancel.textContent = "Cancelar"; cancel.onclick = () => finish(null); dialog.append(cancel);
    backdrop.append(dialog); document.body.append(backdrop);
    void setup(dialog, finish).catch(e => { alert(String(e)); finish(null); });
  });
}
