//! Exportar/importar conexiones entre dispositivos (archivo .txt o QR).
//!
//! Las conexiones viajan con su password, así que el paquete va cifrado con
//! una clave que el usuario tipea al exportar y vuelve a tipear al importar:
//! Argon2id deriva la key y ChaCha20-Poly1305 cifra el JSON comprimido.
//!
//! Formato: `ZNH1.` + base64url sin padding de `salt(16) | nonce(12) | cifrado`.
//! El prefijo usa `.`, que no es base64url: varios paquetes pegados en un mismo
//! texto se separan sin ambigüedad.

use std::io::{Read, Write};

use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine as _;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Nonce};
use db_core::ConnectionConfig;
use rand::RngCore;
use serde::{Deserialize, Serialize};

use crate::{Result, StoreError};

pub const PREFIX: &str = "ZNH1.";
const B64URL: base64::engine::GeneralPurpose = base64::engine::general_purpose::URL_SAFE_NO_PAD;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
/// Error de descifrado; el frontend lo traduce como "clave incorrecta".
pub const BAD_PASSPHRASE: &str = "bad passphrase or corrupted data";

#[derive(Serialize, Deserialize)]
struct Bundle {
    v: u8,
    connections: Vec<ConnectionConfig>,
}

/// Argon2id con los parámetros mínimos recomendados por OWASP (19 MiB, t=2):
/// rápido en un teléfono y caro para un ataque de fuerza bruta.
fn derive_key(passphrase: &str, salt: &[u8]) -> Result<ChaCha20Poly1305> {
    let params =
        Params::new(19 * 1024, 2, 1, Some(32)).map_err(|e| StoreError::Other(e.to_string()))?;
    let mut key = [0u8; 32];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|e| StoreError::Other(e.to_string()))?;
    ChaCha20Poly1305::new_from_slice(&key).map_err(|e| StoreError::Other(e.to_string()))
}

/// Cifra las conexiones (con sus passwords) en un paquete de texto.
pub fn seal(connections: Vec<ConnectionConfig>, passphrase: &str) -> Result<String> {
    if passphrase.is_empty() {
        return Err(StoreError::Other("empty passphrase".into()));
    }
    let json = serde_json::to_vec(&Bundle { v: 1, connections })
        .map_err(|e| StoreError::Other(e.to_string()))?;
    let mut deflate = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::best());
    deflate
        .write_all(&json)
        .map_err(|e| StoreError::Other(e.to_string()))?;
    let compressed = deflate
        .finish()
        .map_err(|e| StoreError::Other(e.to_string()))?;

    let mut salt = [0u8; SALT_LEN];
    let mut nonce = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut salt);
    rand::thread_rng().fill_bytes(&mut nonce);
    let cipher = derive_key(passphrase, &salt)?;
    let sealed = cipher
        .encrypt(Nonce::from_slice(&nonce), compressed.as_slice())
        .map_err(|e| StoreError::Other(e.to_string()))?;

    let mut raw = Vec::with_capacity(SALT_LEN + NONCE_LEN + sealed.len());
    raw.extend_from_slice(&salt);
    raw.extend_from_slice(&nonce);
    raw.extend_from_slice(&sealed);
    Ok(format!("{PREFIX}{}", B64URL.encode(raw)))
}

/// Descifra un paquete `ZNH1.…`. Clave incorrecta o datos alterados dan
/// [`BAD_PASSPHRASE`] (el AEAD no distingue entre ambos casos).
pub fn open(token: &str, passphrase: &str) -> Result<Vec<ConnectionConfig>> {
    let body: String = token
        .trim()
        .strip_prefix(PREFIX)
        .ok_or_else(|| StoreError::Other("not a Zanahoria export".into()))?
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    let raw = B64URL
        .decode(body)
        .map_err(|_| StoreError::Other(BAD_PASSPHRASE.into()))?;
    if raw.len() <= SALT_LEN + NONCE_LEN {
        return Err(StoreError::Other(BAD_PASSPHRASE.into()));
    }
    let (salt, rest) = raw.split_at(SALT_LEN);
    let (nonce, sealed) = rest.split_at(NONCE_LEN);
    let compressed = derive_key(passphrase, salt)?
        .decrypt(Nonce::from_slice(nonce), sealed)
        .map_err(|_| StoreError::Other(BAD_PASSPHRASE.into()))?;
    let mut json = Vec::new();
    flate2::read::DeflateDecoder::new(compressed.as_slice())
        .read_to_end(&mut json)
        .map_err(|e| StoreError::Other(e.to_string()))?;
    let bundle: Bundle =
        serde_json::from_slice(&json).map_err(|e| StoreError::Other(e.to_string()))?;
    if bundle.v != 1 {
        return Err(StoreError::Other(format!(
            "unsupported export version {}",
            bundle.v
        )));
    }
    Ok(bundle.connections)
}

#[cfg(test)]
mod tests {
    use super::*;
    use db_core::Engine;

    fn conn(id: &str, password: Option<&str>, group: Option<&str>) -> ConnectionConfig {
        ConnectionConfig {
            id: id.into(),
            name: format!("conn {id}"),
            engine: Engine::Postgres,
            host: "db.example.com".into(),
            port: Some(5432),
            database: "app".into(),
            user: "admin".into(),
            password: password.map(Into::into),
            use_tls: true,
            safe_mode: false,
            color: Some("#ff8800".into()),
            group: group.map(Into::into),
        }
    }

    #[test]
    fn roundtrip_keeps_password_and_group() {
        let token = seal(
            vec![
                conn("a", Some("s3cret"), Some("Prod")),
                conn("b", None, None),
            ],
            "clave",
        )
        .unwrap();
        assert!(token.starts_with(PREFIX));
        assert!(!token.contains("s3cret"));
        let back = open(&token, "clave").unwrap();
        assert_eq!(back.len(), 2);
        assert_eq!(back[0].password.as_deref(), Some("s3cret"));
        assert_eq!(back[0].group.as_deref(), Some("Prod"));
        assert_eq!(back[1].password, None);
        assert_eq!(back[1].host, "db.example.com");
    }

    #[test]
    fn wrong_passphrase_is_rejected() {
        let token = seal(vec![conn("a", Some("x"), None)], "right").unwrap();
        let err = open(&token, "wrong").unwrap_err().to_string();
        assert!(err.contains(BAD_PASSPHRASE), "{err}");
    }

    #[test]
    fn tampered_or_wrapped_tokens() {
        let token = seal(vec![conn("a", Some("x"), None)], "k").unwrap();
        // Saltos de línea (texto pegado o envuelto) no afectan.
        let wrapped = format!("{}\n{}", &token[..20], &token[20..]);
        assert_eq!(open(&wrapped, "k").unwrap().len(), 1);
        let mut bad = token.clone().into_bytes();
        let last = bad.len() - 3;
        bad[last] = if bad[last] == b'A' { b'B' } else { b'A' };
        assert!(open(std::str::from_utf8(&bad).unwrap(), "k").is_err());
        assert!(open("hola", "k").is_err());
    }

    #[test]
    fn empty_passphrase_is_refused() {
        assert!(seal(vec![conn("a", None, None)], "").is_err());
    }
}
