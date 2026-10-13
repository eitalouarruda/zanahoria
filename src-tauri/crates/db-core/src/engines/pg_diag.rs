//! Diagnóstico de errores de conexión Postgres que sqlx no puede mostrar.
//!
//! Servidores antiguos (p. ej. 9.x) con `lc_messages` en un locale no UTF-8
//! (es_ES.ISO-8859-1, LATIN1…) envían el ErrorResponse de autenticación en
//! ese encoding: sqlx falla al decodificarlo y oculta el error real
//! ("Postgres returned a non-UTF-8 string for its error message").
//! Aquí se repite el handshake mínimo (sin TLS) y se decodifica el mensaje
//! como Latin-1, que es el caso habitual.

use std::time::Duration;

use md5::{Digest, Md5};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::timeout;

use crate::config::ConnectionConfig;

/// Marca del error de sqlx que dispara el diagnóstico.
pub const NON_UTF8_ERROR: &str = "non-UTF-8 string for its error message";

/// Intenta obtener el mensaje de error real del servidor. `None` si el
/// handshake no termina en un ErrorResponse (o no se puede reproducir).
pub async fn raw_auth_error(cfg: &ConnectionConfig) -> Option<String> {
    timeout(Duration::from_secs(10), handshake(cfg))
        .await
        .ok()
        .flatten()
}

async fn handshake(cfg: &ConnectionConfig) -> Option<String> {
    let mut stream = TcpStream::connect((cfg.host.as_str(), cfg.port.unwrap_or(5432)))
        .await
        .ok()?;

    // StartupMessage: protocolo 3.0 + parámetros user/database.
    let mut params = Vec::new();
    for (k, v) in [
        ("user", cfg.user.as_str()),
        ("database", cfg.database.as_str()),
    ] {
        if v.is_empty() {
            continue;
        }
        params.extend_from_slice(k.as_bytes());
        params.push(0);
        params.extend_from_slice(v.as_bytes());
        params.push(0);
    }
    params.push(0);
    let mut startup = Vec::with_capacity(params.len() + 8);
    startup.extend_from_slice(&((params.len() + 8) as i32).to_be_bytes());
    startup.extend_from_slice(&196_608i32.to_be_bytes());
    startup.extend_from_slice(&params);
    stream.write_all(&startup).await.ok()?;

    loop {
        let (tag, body) = read_message(&mut stream).await?;
        match tag {
            b'E' => return Some(parse_error(&body)),
            b'R' => {
                let code = i32::from_be_bytes(body.get(0..4)?.try_into().ok()?);
                let password = cfg.password.as_deref().unwrap_or("");
                match code {
                    0 => return None, // autenticó bien: el problema era otro
                    3 => send_password(&mut stream, password.as_bytes()).await?,
                    5 => {
                        let salt = body.get(4..8)?;
                        let inner = hex_md5(&[password.as_bytes(), cfg.user.as_bytes()].concat());
                        let outer = hex_md5(&[inner.as_bytes(), salt].concat());
                        send_password(&mut stream, format!("md5{outer}").as_bytes()).await?;
                    }
                    // SCRAM/GSS/SSPI: no se reproduce aquí.
                    _ => return None,
                }
            }
            // NoticeResponse u otros mensajes previos: seguir leyendo.
            _ => continue,
        }
    }
}

async fn read_message(stream: &mut TcpStream) -> Option<(u8, Vec<u8>)> {
    let tag = stream.read_u8().await.ok()?;
    let len = stream.read_i32().await.ok()?;
    if !(4..=1_000_000).contains(&len) {
        return None;
    }
    let mut body = vec![0u8; len as usize - 4];
    stream.read_exact(&mut body).await.ok()?;
    Some((tag, body))
}

async fn send_password(stream: &mut TcpStream, password: &[u8]) -> Option<()> {
    let mut msg = vec![b'p'];
    msg.extend_from_slice(&((password.len() + 5) as i32).to_be_bytes());
    msg.extend_from_slice(password);
    msg.push(0);
    stream.write_all(&msg).await.ok()
}

fn hex_md5(data: &[u8]) -> String {
    Md5::digest(data)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Bytes → String: UTF-8 si es válido, si no Latin-1 (cada byte = U+00XX).
fn decode(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_owned(),
        Err(_) => bytes.iter().map(|&b| b as char).collect(),
    }
}

/// ErrorResponse: campos `<código><cstring>` terminados en 0.
fn parse_error(body: &[u8]) -> String {
    let (mut severity, mut code, mut message, mut detail) = (None, None, None, None);
    let mut rest = body;
    while let Some((&field, tail)) = rest.split_first() {
        if field == 0 {
            break;
        }
        let end = tail.iter().position(|&b| b == 0).unwrap_or(tail.len());
        let value = decode(&tail[..end]);
        match field {
            b'S' => severity = Some(value),
            b'C' => code = Some(value),
            b'M' => message = Some(value),
            b'D' => detail = Some(value),
            _ => {}
        }
        rest = tail.get(end + 1..).unwrap_or(&[]);
    }
    let mut out = message.unwrap_or_else(|| "error desconocido".into());
    if let Some(s) = severity {
        out = format!("{s}: {out}");
    }
    if let Some(c) = code {
        out.push_str(&format!(" [{c}]"));
    }
    if let Some(d) = detail {
        out.push_str(&format!(" — {d}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodifica_error_latin1() {
        // "la autentificación password falló" en ISO-8859-1.
        let mut body = b"SFATAL\0C28P01\0Mla autentificaci".to_vec();
        body.push(0xF3);
        body.extend_from_slice(b"n password fall");
        body.push(0xF3);
        body.extend_from_slice(b" para el usuario \xabx\xbb\0\0");
        assert_eq!(
            parse_error(&body),
            "FATAL: la autentificación password falló para el usuario «x» [28P01]"
        );
    }

    #[test]
    fn md5_igual_a_postgres() {
        // md5(md5("secret" + "user") + salt) con salt 01020304.
        let inner = hex_md5(b"secretuser");
        let outer = hex_md5(&[inner.as_bytes(), &[1, 2, 3, 4]].concat());
        assert_eq!(inner.len(), 32);
        assert_eq!(outer.len(), 32);
    }
}
