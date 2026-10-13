use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformCapabilities {
    pub os: String,
    pub is_mobile: bool,
    /// Backups vía binarios externos: solo desktop.
    pub backup_supported: bool,
}

#[tauri::command]
pub fn get_platform_capabilities() -> PlatformCapabilities {
    let is_mobile = cfg!(any(target_os = "android", target_os = "ios"));
    PlatformCapabilities {
        os: std::env::consts::OS.to_string(),
        is_mobile,
        backup_supported: !is_mobile,
    }
}
