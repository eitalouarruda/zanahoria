#!/usr/bin/env bash
# Zanahoria — script de desarrollo local (Linux)
#
# Uso:
#   ./dev.sh            # arranca la app en modo dev (tauri dev)
#   ./dev.sh --db       # levanta las bases de datos de prueba (docker compose) y arranca la app
#   ./dev.sh --db-only  # solo levanta las bases de datos de prueba
#   ./dev.sh --android  # arranca en modo dev para Android (requiere SDK/NDK)
set -euo pipefail

cd "$(dirname "$0")"

start_databases() {
  echo "==> Levantando bases de datos de prueba (postgres, mysql, mariadb, redis)..."
  docker compose up -d --wait
  echo "==> Bases listas:"
  echo "    postgres  localhost:55432  user/pass: zanahoria/zanahoria  db: zanahoria"
  echo "    mysql     localhost:33306  user/pass: zanahoria/zanahoria  db: zanahoria"
  echo "    mariadb   localhost:33307  user/pass: zanahoria/zanahoria  db: zanahoria"
  echo "    redis     localhost:63790"
}

MODE="dev"
for arg in "$@"; do
  case "$arg" in
    --db) start_databases ;;
    --db-only) start_databases; exit 0 ;;
    --android) MODE="android" ;;
    *) echo "flag desconocido: $arg"; exit 1 ;;
  esac
done

if [ ! -d node_modules ]; then
  echo "==> Instalando dependencias del frontend..."
  pnpm install
fi

if [ "$MODE" = "android" ]; then
  exec pnpm tauri android dev
else
  exec pnpm tauri dev
fi
