use std::path::{Path, PathBuf};

use base64::Engine as _;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Nonce};
use rand::RngCore;

use crate::{Result, StoreError};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// Almacén de passwords de conexiones, separado del SQLite principal.
pub trait SecretStore: Send + Sync {
    fn set(&self, conn_id: &str, secret: &str) -> Result<()>;
    fn get(&self, conn_id: &str) -> Result<Option<String>>;
    fn delete(&self, conn_id: &str) -> Result<()>;
}

/// Archivo cifrado con ChaCha20-Poly1305. La clave vive en un archivo
/// aparte dentro del data dir (en Android el sandbox de la app lo aísla;
/// fase 2: mover la clave al Android Keystore).
pub struct FileCipherStore {
    lock: std::sync::Mutex<()>,
    key_path: PathBuf,
    secrets_path: PathBuf,
}

impl FileCipherStore {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            lock: std::sync::Mutex::new(()),
            key_path: data_dir.join("secrets.key"),
            secrets_path: data_dir.join("secrets.json"),
        }
    }

    fn key(&self) -> Result<ChaCha20Poly1305> {
        let key_bytes = if self.key_path.exists() {
            let encoded = std::fs::read_to_string(&self.key_path)
                .map_err(|e| StoreError::Secret(e.to_string()))?;
            B64.decode(encoded.trim())
                .map_err(|e| StoreError::Secret(e.to_string()))?
        } else {
            let mut bytes = [0u8; 32];
            rand::thread_rng().fill_bytes(&mut bytes);
            std::fs::write(&self.key_path, B64.encode(bytes))
                .map_err(|e| StoreError::Secret(e.to_string()))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(
                    &self.key_path,
                    std::fs::Permissions::from_mode(0o600),
                );
            }
            bytes.to_vec()
        };
        ChaCha20Poly1305::new_from_slice(&key_bytes).map_err(|e| StoreError::Secret(e.to_string()))
    }

    fn read_all(&self) -> Result<serde_json::Map<String, serde_json::Value>> {
        if !self.secrets_path.exists() {
            return Ok(serde_json::Map::new());
        }
        let raw = std::fs::read_to_string(&self.secrets_path)
            .map_err(|e| StoreError::Secret(e.to_string()))?;
        serde_json::from_str(&raw).map_err(|e| StoreError::Secret(e.to_string()))
    }

    fn write_all(&self, map: &serde_json::Map<String, serde_json::Value>) -> Result<()> {
        std::fs::write(
            &self.secrets_path,
            serde_json::to_string(map).map_err(|e| StoreError::Secret(e.to_string()))?,
        )
        .map_err(|e| StoreError::Secret(e.to_string()))
    }
}

impl SecretStore for FileCipherStore {
    fn set(&self, conn_id: &str, secret: &str) -> Result<()> {
        let _lock = self
            .lock
            .lock()
            .map_err(|_| StoreError::Secret("secret store lock poisoned".into()))?;
        let cipher = self.key()?;
        let mut nonce_bytes = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);
        let ciphertext = cipher
            .encrypt(nonce, secret.as_bytes())
            .map_err(|e| StoreError::Secret(e.to_string()))?;
        let mut map = self.read_all()?;
        map.insert(
            conn_id.to_string(),
            serde_json::json!({
                "nonce": B64.encode(nonce_bytes),
                "data": B64.encode(ciphertext),
            }),
        );
        self.write_all(&map)
    }

    fn get(&self, conn_id: &str) -> Result<Option<String>> {
        let _lock = self
            .lock
            .lock()
            .map_err(|_| StoreError::Secret("secret store lock poisoned".into()))?;
        let map = self.read_all()?;
        let Some(entry) = map.get(conn_id) else {
            return Ok(None);
        };
        let nonce_bytes = B64
            .decode(entry["nonce"].as_str().unwrap_or_default())
            .map_err(|e| StoreError::Secret(e.to_string()))?;
        let data = B64
            .decode(entry["data"].as_str().unwrap_or_default())
            .map_err(|e| StoreError::Secret(e.to_string()))?;
        let cipher = self.key()?;
        let plain = cipher
            .decrypt(Nonce::from_slice(&nonce_bytes), data.as_ref())
            .map_err(|e| StoreError::Secret(e.to_string()))?;
        Ok(Some(
            String::from_utf8(plain).map_err(|e| StoreError::Secret(e.to_string()))?,
        ))
    }

    fn delete(&self, conn_id: &str) -> Result<()> {
        let _lock = self
            .lock
            .lock()
            .map_err(|_| StoreError::Secret("secret store lock poisoned".into()))?;
        let mut map = self.read_all()?;
        map.remove(conn_id);
        self.write_all(&map)
    }
}

#[cfg(all(not(target_os = "android"), feature = "desktop-keyring"))]
mod keyring_store {
    use super::*;
    use keyring::Entry;

    const SERVICE: &str = "com.zanahoria.app";

    fn secret_err(e: keyring::Error) -> StoreError {
        StoreError::Secret(e.to_string())
    }

    /// Entrada del keyring del sistema. En Linux, Secret Service explícito:
    /// el backend por defecto del crate es el keyring del kernel, que no
    /// sobrevive a un reinicio.
    fn entry(conn_id: &str) -> keyring::Result<Entry> {
        #[cfg(target_os = "linux")]
        {
            let cred =
                keyring::secret_service::SsCredential::new_with_target(None, SERVICE, conn_id)?;
            Ok(Entry::new_with_credential(Box::new(cred)))
        }
        #[cfg(not(target_os = "linux"))]
        {
            Entry::new(SERVICE, conn_id)
        }
    }

    /// Dónde guardaban las versiones anteriores en Linux (keyring del kernel).
    #[cfg(target_os = "linux")]
    fn legacy_entry(conn_id: &str) -> Option<Entry> {
        keyring::keyutils::KeyutilsCredential::new_with_target(None, SERVICE, conn_id)
            .ok()
            .map(|c| Entry::new_with_credential(Box::new(c)))
    }

    /// OS keyring (Secret Service / Windows Credential Manager / macOS Keychain).
    pub struct KeyringStore;

    impl KeyringStore {
        /// Password guardado por una versión anterior en el keyring del
        /// kernel: se pasa al keyring persistente y se borra del viejo.
        #[cfg(target_os = "linux")]
        fn migrate_legacy(&self, conn_id: &str) -> Option<String> {
            let legacy = legacy_entry(conn_id)?;
            let pw = legacy.get_password().ok()?;
            if self.set(conn_id, &pw).is_ok() {
                let _ = legacy.delete_credential();
            }
            Some(pw)
        }
    }

    impl SecretStore for KeyringStore {
        fn set(&self, conn_id: &str, secret: &str) -> Result<()> {
            entry(conn_id)
                .and_then(|e| e.set_password(secret))
                .map_err(secret_err)
        }

        fn get(&self, conn_id: &str) -> Result<Option<String>> {
            match entry(conn_id).map_err(secret_err)?.get_password() {
                Ok(pw) => Ok(Some(pw)),
                #[cfg(target_os = "linux")]
                Err(keyring::Error::NoEntry) => Ok(self.migrate_legacy(conn_id)),
                #[cfg(not(target_os = "linux"))]
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(e) => Err(secret_err(e)),
            }
        }

        fn delete(&self, conn_id: &str) -> Result<()> {
            #[cfg(target_os = "linux")]
            if let Some(legacy) = legacy_entry(conn_id) {
                let _ = legacy.delete_credential();
            }
            match entry(conn_id).map_err(secret_err)?.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(e) => Err(secret_err(e)),
            }
        }
    }
}

#[cfg(all(test, target_os = "linux", feature = "desktop-keyring"))]
mod keyring_tests {
    use super::*;
    use keyring::Entry;

    /// Contra el keyring real de la sesión: `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn migrates_kernel_keyring_password_to_secret_service() {
        const ID: &str = "__zanahoria_test__";
        let store = KeyringStore;
        store.delete(ID).unwrap();
        let legacy =
            keyring::keyutils::KeyutilsCredential::new_with_target(None, "com.zanahoria.app", ID)
                .unwrap();
        Entry::new_with_credential(Box::new(legacy))
            .set_password("old")
            .unwrap();

        assert_eq!(store.get(ID).unwrap().as_deref(), Some("old"));
        // Ya migrado: el kernel keyring quedó vacío y Secret Service lo tiene.
        let ss =
            keyring::secret_service::SsCredential::new_with_target(None, "com.zanahoria.app", ID)
                .unwrap();
        assert_eq!(
            Entry::new_with_credential(Box::new(ss))
                .get_password()
                .unwrap(),
            "old"
        );
        store.delete(ID).unwrap();
        assert_eq!(store.get(ID).unwrap(), None);
    }
}

#[cfg(all(not(target_os = "android"), feature = "desktop-keyring"))]
pub use keyring_store::KeyringStore;

/// Keyring del sistema con el archivo cifrado como respaldo. Se lee de los
/// dos: si el keyring no respondió alguna vez al guardar, el password quedó en
/// el archivo y tiene que seguir apareciendo cuando el keyring vuelva.
pub struct FallbackStore {
    primary: Option<Box<dyn SecretStore>>,
    fallback: FileCipherStore,
}

impl FallbackStore {
    pub fn new(primary: Option<Box<dyn SecretStore>>, fallback: FileCipherStore) -> Self {
        Self { primary, fallback }
    }
}

impl SecretStore for FallbackStore {
    fn set(&self, conn_id: &str, secret: &str) -> Result<()> {
        if let Some(primary) = &self.primary {
            if primary.set(conn_id, secret).is_ok() {
                // Una copia vieja en el respaldo taparía cambios futuros.
                let _ = self.fallback.delete(conn_id);
                return Ok(());
            }
        }
        self.fallback.set(conn_id, secret)
    }

    fn get(&self, conn_id: &str) -> Result<Option<String>> {
        if let Some(primary) = &self.primary {
            if let Ok(Some(pw)) = primary.get(conn_id) {
                return Ok(Some(pw));
            }
        }
        self.fallback.get(conn_id)
    }

    fn delete(&self, conn_id: &str) -> Result<()> {
        if let Some(primary) = &self.primary {
            let _ = primary.delete(conn_id);
        }
        self.fallback.delete(conn_id)
    }
}

/// Keyring en desktop (si el servicio responde) con archivo cifrado como
/// respaldo; solo el archivo en Android.
pub fn default_secret_store(data_dir: &Path) -> Box<dyn SecretStore> {
    #[allow(unused_mut)]
    let mut primary: Option<Box<dyn SecretStore>> = None;
    #[cfg(all(not(target_os = "android"), feature = "desktop-keyring"))]
    if KeyringStore.get("__zanahoria_probe__").is_ok() {
        primary = Some(Box::new(KeyringStore));
    }
    Box::new(FallbackStore::new(primary, FileCipherStore::new(data_dir)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concurrent_file_secrets_preserve_every_connection() {
        let dir = tempfile::tempdir().unwrap();
        let store = std::sync::Arc::new(FileCipherStore::new(dir.path()));
        std::thread::scope(|scope| {
            for id in 0..12 {
                let store = store.clone();
                scope.spawn(move || {
                    store
                        .set(&format!("conn-{id}"), &format!("test-only-secret-{id}"))
                        .unwrap()
                });
            }
        });
        for id in 0..12 {
            assert_eq!(
                store.get(&format!("conn-{id}")).unwrap().unwrap(),
                format!("test-only-secret-{id}")
            );
        }
    }

    #[test]
    fn file_cipher_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let store = FileCipherStore::new(dir.path());
        store.set("conn1", "s3cret").unwrap();
        assert_eq!(store.get("conn1").unwrap().as_deref(), Some("s3cret"));
        store.delete("conn1").unwrap();
        assert_eq!(store.get("conn1").unwrap(), None);
    }

    /// Keyring que siempre falla (servicio caído o bloqueado).
    struct Broken;

    impl SecretStore for Broken {
        fn set(&self, _: &str, _: &str) -> Result<()> {
            Err(StoreError::Secret("down".into()))
        }
        fn get(&self, _: &str) -> Result<Option<String>> {
            Err(StoreError::Secret("down".into()))
        }
        fn delete(&self, _: &str) -> Result<()> {
            Err(StoreError::Secret("down".into()))
        }
    }

    #[test]
    fn fallback_keeps_password_when_keyring_fails() {
        let dir = tempfile::tempdir().unwrap();
        let store = FallbackStore::new(Some(Box::new(Broken)), FileCipherStore::new(dir.path()));
        store.set("conn1", "s3cret").unwrap();
        assert_eq!(store.get("conn1").unwrap().as_deref(), Some("s3cret"));
        store.delete("conn1").unwrap();
        assert_eq!(store.get("conn1").unwrap(), None);
    }

    #[test]
    fn fallback_reads_file_when_keyring_lacks_entry() {
        let dir = tempfile::tempdir().unwrap();
        // Guardado con el keyring caído...
        FileCipherStore::new(dir.path())
            .set("conn1", "s3cret")
            .unwrap();
        // ...y leído con un keyring que responde pero no lo tiene.
        let other = tempfile::tempdir().unwrap();
        let empty = FileCipherStore::new(other.path());
        let store = FallbackStore::new(Some(Box::new(empty)), FileCipherStore::new(dir.path()));
        assert_eq!(store.get("conn1").unwrap().as_deref(), Some("s3cret"));
    }
}
