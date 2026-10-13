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
    key_path: PathBuf,
    secrets_path: PathBuf,
}

impl FileCipherStore {
    pub fn new(data_dir: &Path) -> Self {
        Self {
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
        let mut map = self.read_all()?;
        map.remove(conn_id);
        self.write_all(&map)
    }
}

#[cfg(not(target_os = "android"))]
mod keyring_store {
    use super::*;

    const SERVICE: &str = "com.zanahoria.app";

    /// OS keyring (Secret Service / Windows Credential Manager / macOS Keychain).
    pub struct KeyringStore;

    impl SecretStore for KeyringStore {
        fn set(&self, conn_id: &str, secret: &str) -> Result<()> {
            keyring::Entry::new(SERVICE, conn_id)
                .and_then(|e| e.set_password(secret))
                .map_err(|e| StoreError::Secret(e.to_string()))
        }

        fn get(&self, conn_id: &str) -> Result<Option<String>> {
            match keyring::Entry::new(SERVICE, conn_id)
                .map_err(|e| StoreError::Secret(e.to_string()))?
                .get_password()
            {
                Ok(pw) => Ok(Some(pw)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(e) => Err(StoreError::Secret(e.to_string())),
            }
        }

        fn delete(&self, conn_id: &str) -> Result<()> {
            match keyring::Entry::new(SERVICE, conn_id)
                .map_err(|e| StoreError::Secret(e.to_string()))?
                .delete_credential()
            {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(e) => Err(StoreError::Secret(e.to_string())),
            }
        }
    }
}

#[cfg(not(target_os = "android"))]
pub use keyring_store::KeyringStore;

/// Elige el mejor SecretStore disponible: keyring en desktop (si el servicio
/// responde), archivo cifrado como fallback y en Android.
pub fn default_secret_store(data_dir: &Path) -> Box<dyn SecretStore> {
    #[cfg(not(target_os = "android"))]
    {
        let probe = KeyringStore;
        if probe.get("__zanahoria_probe__").is_ok() {
            return Box::new(probe);
        }
    }
    Box::new(FileCipherStore::new(data_dir))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_cipher_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let store = FileCipherStore::new(dir.path());
        store.set("conn1", "s3cret").unwrap();
        assert_eq!(store.get("conn1").unwrap().as_deref(), Some("s3cret"));
        store.delete("conn1").unwrap();
        assert_eq!(store.get("conn1").unwrap(), None);
    }
}
