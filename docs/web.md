# Edición web para Quimera

La edición nativa Tauri se conserva. `src/platform` selecciona IPC nativo o
HTTP/WebSocket, diálogos de archivos web y clipboard del navegador. Los comandos
Rust se comparten mediante `crates/web-host`; no se duplican motores de datos.

```bash
pnpm install --frozen-lockfile
pnpm build:web
cargo test --locked --manifest-path src-tauri/Cargo.toml -p zanahoria-web
cargo build --locked --manifest-path src-tauri/Cargo.toml -p zanahoria-web --profile web
```

Linux: ejecutar `zanahoria-web` con `ZANAHORIA_DATA` (directorio privado) y
`ZANAHORIA_SOCKET` (socket Unix). No publica TCP ni autentica usuarios por sí mismo:
solo debe ser accesible al proxy autenticado de Quimera. El grupo del socket tiene
acceso a todos los datos de este propietario. Assets `dist-web/` se sirven desde
`/tools/zanahoria/`; el transporte usa `/api/zanahoria/` del mismo origen.

`Dockerfile.web` construye un artefacto nativo compatible con Ubuntu 24.04 sin
GTK/WebKit, Node ni contenedor en ejecución. Exportar con `docker buildx build
-f Dockerfile.web --output type=local,dest=artifact .` desde contexto limitado al
Dockerfile y fuentes Rust. No incluir `gen/android` ni archivos de firma.

Los comandos externos de backup requieren `pg_dump`, `pg_restore`, `psql`,
`mysqldump` y `mysql` instalados. No se permiten rutas arbitrarias de ejecutables.

El usuario único comparte conexiones/archivos pero cada cliente tiene pools,
eventos y consultas propios. Journal limitado con replay por secuencia. Los
archivos solo pueden estar en el directorio administrado; subir SQLite crea una
copia. Descargar SQLite registrado genera snapshot consistente. Los secretos
están cifrados en disco y nunca se devuelven en el listado de conexiones.

Los endpoints privados POST `/quiesce` y `/resume` permiten backups sin carreras:
quiesce rechaza consultas/jobs/operaciones activos y bloquea nuevas operaciones.
El administrador debe hacer copia SQLite consistente antes de resume. Quimera
implementa ese protocolo y documenta instalación/recuperación en
`docs/zanahoria-web.md` de su repositorio.

Pruebas unitarias web: SQLite real, mutaciones con preview, exportación en cuatro
formatos, backup, validación de rutas y archivos, aislamiento de clientes y gate
de mantenimiento. `deploy/web-acceptance.compose.yml` ofrece motores desechables
con límites y puertos loopback. No usar esas credenciales fuera de las pruebas.
La cámara/portapapeles necesitan contexto seguro y permiso del navegador. El
actualizador y controles de ventanas del escritorio se excluyen del modo web.

## Aceptación completa con motores reales

En un servidor de prueba, iniciar `docker compose -p quimera-zanahoria-acceptance
-f deploy/web-acceptance.compose.yml up -d --wait`. Para probar crear bases de
restauración, otorgar al usuario **solo de estos fixtures** permisos de creación
en MySQL y MariaDB. No ejecutar los casos contra motores personales.

Instalar Playwright en un directorio de pruebas separado y Chromium. Ejecutar
`scripts/web-acceptance.cjs` con Node, `NODE_PATH` apuntando a ese node_modules,
`ZANAHORIA_ACCEPTANCE_URL` apuntando al Core de prueba,
`QUIMERA_ACCEPTANCE_PASSWORD` de ese Core y
`ZANAHORIA_ACCEPTANCE_DISPOSABLE=true`. Los puertos de fixture son vistos desde
el proceso Rust. El script comprueba CRUD SQL/Redis, esquemas, historial,
favoritos, transferencia cifrada, aislamiento, replay, paginación, cancelación,
respaldos y restauración. Eliminar únicamente el proyecto Compose de pruebas
con `down -v` al terminar.
