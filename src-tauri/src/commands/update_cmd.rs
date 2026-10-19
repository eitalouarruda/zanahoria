//! Comandos de actualización (ver `crate::update`). En móvil no hay nada que
//! buscar: `check_update` devuelve siempre `None`.

use serde::Serialize;
use tauri::AppHandle;

use crate::error::CmdResult;

#[derive(Serialize)]
pub struct UpdateInfo {
    pub version: String,
}

/// Versión nueva encontrada al arrancar, esperando a que el usuario acepte.
#[cfg(desktop)]
#[derive(Default)]
pub struct UpdateState(pub std::sync::Mutex<Option<crate::update::Release>>);

/// Busca una versión nueva en GitHub. El frontend lo pide al arrancar y
/// pregunta antes de instalar nada.
#[tauri::command]
pub async fn check_update(app: AppHandle) -> Option<UpdateInfo> {
    #[cfg(desktop)]
    {
        use tauri::Manager;
        if !crate::update::supported() {
            return None;
        }
        let current = app.package_info().version.to_string();
        let found = tauri::async_runtime::spawn_blocking(move || crate::update::check(&current))
            .await
            .ok()
            .flatten();
        let info = found.as_ref().map(|r| UpdateInfo {
            version: r.version.clone(),
        });
        *app.state::<UpdateState>().0.lock().unwrap() = found;
        info
    }
    #[cfg(mobile)]
    {
        let _ = app;
        None
    }
}

/// Descarga e instala la versión encontrada y cierra Zanahoria; la versión
/// nueva arranca sola. Avisa del progreso con `update:progress`.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> CmdResult<()> {
    #[cfg(desktop)]
    {
        use tauri::{Emitter, Manager};
        let release = app
            .state::<UpdateState>()
            .0
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| "update.none".to_string())?;
        let current = app.package_info().version.to_string();
        let progress_app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            crate::update::install(&release, &current, |progress| {
                let _ = progress_app.emit("update:progress", progress);
            })
        })
        .await
        .map_err(|e| e.to_string())??;
        app.exit(0);
        Ok(())
    }
    #[cfg(mobile)]
    {
        let _ = app;
        Err("update.none".to_string().into())
    }
}
