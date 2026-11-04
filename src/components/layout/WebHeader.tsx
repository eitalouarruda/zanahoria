import { useEffect, useState } from "react";
import { listFiles, uploadFile, downloadFile, deleteFile, type ServerFile } from "../../platform/web";
export default function WebHeader() {
  const [message, setMessage] = useState("");
  const [show, setShow] = useState(false);
  const [files, setFiles] = useState<ServerFile[]>([]);
  const [error, setError] = useState("");
  const refresh = async () => { try { setFiles(await listFiles()); } catch(e) { setError(String(e)); } };
  useEffect(() => { const handler = (e: Event) => setMessage((e as CustomEvent<string>).detail); window.addEventListener("zanahoria:status", handler); return () => window.removeEventListener("zanahoria:status", handler); }, []);
  return <>
    <header className="web-header"><a href="/" target="_top">← Quimera</a><strong>Zanahoria</strong><span className="dim">{message || "Conectada al servidor"}</span><button onClick={() => { setShow(true); void refresh(); }}>Archivos</button></header>
    {message && <div className="web-status" role="status">{message} <button onClick={() => location.reload()}>Volver a conectar</button></div>}
    {show && <div className="modal-backdrop"><section className="modal web-files" role="dialog" aria-modal="true" aria-label="Archivos del servidor"><h3>Archivos del servidor</h3><p className="dim">Las bases SQLite seleccionadas desde tu dispositivo se suben como copias. Los respaldos y exportaciones se descargan al terminar.</p><label>Subir archivo<input type="file" onChange={e => { const file=e.target.files?.[0]; if(file) void uploadFile(file).then(refresh).catch(e=>setError(String(e))); }} /></label>{error && <p className="error-banner" role="alert">{error}</p>}{files.map(file => <div className="web-file" key={file.name}><span title={file.path}>{file.name.slice(37)}<small className="dim"> {Math.ceil(file.size/1024)} KB</small></span><button onClick={() => void downloadFile(file.path).catch(e=>setError(String(e)))}>Descargar</button><button onClick={() => { if(confirm(`¿Eliminar ${file.name.slice(37)} del servidor?`)) void deleteFile(file.name).then(refresh).catch(e=>setError(String(e))); }}>Eliminar</button></div>)}<button onClick={() => setShow(false)}>Cerrar</button></section></div>}
  </>;
}
