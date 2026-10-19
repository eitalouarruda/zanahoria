mod commands;
mod error;
mod state;
#[cfg(desktop)]
mod update;

use tauri::Manager;

use commands::{backup_cmd, connections, mutations, platform, query, schema, storage, update_cmd};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let store = app_store::AppStore::open(&data_dir)
                .map_err(|e| format!("failed to open app store: {e}"))?;
            app.manage(state::AppState::new(store));
            #[cfg(desktop)]
            app.manage(update_cmd::UpdateState::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            connections::list_saved_connections,
            connections::save_connection,
            connections::delete_connection,
            connections::test_connection,
            connections::connect,
            connections::disconnect,
            query::run_query,
            query::fetch_more,
            query::cancel_query,
            schema::list_databases,
            schema::get_schema,
            schema::refresh_schema,
            mutations::preview_mutations,
            mutations::apply_mutations,
            storage::get_history,
            storage::clear_history,
            storage::list_favorites,
            storage::save_favorite,
            storage::delete_favorite,
            storage::save_text_file,
            storage::kv_get,
            storage::kv_set,
            platform::get_platform_capabilities,
            backup_cmd::sqlite_backup,
            backup_cmd::detect_backup_tools,
            backup_cmd::set_backup_tool_path,
            backup_cmd::sniff_dump_file,
            backup_cmd::start_backup,
            backup_cmd::start_restore,
            backup_cmd::cancel_job,
            update_cmd::check_update,
            update_cmd::install_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
