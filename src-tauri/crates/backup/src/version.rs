//! Versiones de PostgreSQL/MySQL en formato numérico comparable.

/// Convierte un texto de versión al estilo `server_version_num`:
/// "PostgreSQL 9.6.24 on x86_64…" → 90624, "18.6 (Debian…)" → 180006,
/// "pg_restore (PostgreSQL) 18.6" → 180006, "8.0.36" → 80036 (MySQL usa
/// el mismo esquema de 3 componentes que Postgres < 10).
pub fn version_num(s: &str) -> Option<u32> {
    let token = s
        .split(|c: char| c.is_whitespace() || c == '(' || c == ')' || c == ',')
        .find(|t| t.starts_with(|c: char| c.is_ascii_digit()))?;
    let nums: Vec<u32> = token
        .split(|c: char| !c.is_ascii_digit())
        .filter(|p| !p.is_empty())
        .take(3)
        .filter_map(|p| p.parse().ok())
        .collect();
    let major = *nums.first()?;
    let minor = nums.get(1).copied().unwrap_or(0);
    let patch = nums.get(2).copied().unwrap_or(0);
    // Postgres ≥ 10 tiene dos componentes (major.minor); MariaDB 10.x/11.x
    // tiene tres, pero solo comparamos majors entre servidores del mismo engine.
    Some(if (10..100).contains(&major) && nums.len() == 2 {
        major * 10000 + minor
    } else {
        major * 10000 + minor * 100 + patch
    })
}

/// Major de Postgres comparable: 90624 → 906 (9.6), 180006 → 1800 (18).
pub fn pg_major(num: u32) -> u32 {
    if num >= 100000 {
        num / 10000 * 100
    } else {
        num / 100
    }
}

/// Major de Postgres legible: 90624 → "9.6", 180006 → "18".
pub fn pg_major_label(num: u32) -> String {
    if num >= 100000 {
        (num / 10000).to_string()
    } else {
        format!("{}.{}", num / 10000, num / 100 % 100)
    }
}

/// Versión de archive (pg_dump -Fc/-Ft/-Fd) más nueva que sabe leer un
/// pg_restore. Un pg_restore viejo falla con "unsupported version (1.x) in
/// file header" ante archives más nuevos.
pub fn max_archive_version(tool_num: u32) -> (u8, u8) {
    // 1.13 (search_path seguro, CVE-2018-1058) se backporteó a estas minors.
    let has_1_13 = tool_num >= 100003
        || (90608..100000).contains(&tool_num)
        || (90512..90600).contains(&tool_num)
        || (90417..90500).contains(&tool_num)
        || (90322..90400).contains(&tool_num);
    match tool_num {
        n if n >= 170000 => (1, 16),
        n if n >= 160000 => (1, 15),
        n if n >= 120000 => (1, 14),
        _ if has_1_13 => (1, 13),
        _ => (1, 12),
    }
}

/// Primera versión de pg_restore que escribe un archive dado (para sugerir
/// qué instalar cuando el pg_restore disponible es demasiado viejo).
pub fn min_tool_for_archive(archive: (u8, u8)) -> &'static str {
    match archive {
        (1, 16..) => "17",
        (1, 15) => "16",
        (1, 14) => "12",
        (1, 13) => "11",
        _ => "9.0",
    }
}

/// ¿psql entiende `\restrict` / `\unrestrict`? (agregados en 17.6 y
/// backporteados a 16.10, 15.14, 14.19 y 13.22; pg_dump/pg_restore nuevos
/// los escriben en la salida SQL).
pub fn psql_supports_restrict(psql_num: u32) -> bool {
    psql_num >= 170006
        || (160010..170000).contains(&psql_num)
        || (150014..160000).contains(&psql_num)
        || (140019..150000).contains(&psql_num)
        || (130022..140000).contains(&psql_num)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_versions() {
        assert_eq!(
            version_num("PostgreSQL 9.6.24 on x86_64-pc-linux-gnu"),
            Some(90624)
        );
        assert_eq!(version_num("9.0.5"), Some(90005));
        assert_eq!(version_num("18.6 (Debian 18.6-1.pgdg13+2)"), Some(180006));
        assert_eq!(version_num("pg_restore (PostgreSQL) 18.6"), Some(180006));
        assert_eq!(version_num("15.4 (Debian 15.4-1.pgdg120+1)"), Some(150004));
        assert_eq!(version_num("8.0.36"), Some(80036));
        assert_eq!(version_num("10.11.6-MariaDB"), Some(101106));
        assert_eq!(version_num("garbage"), None);
    }

    #[test]
    fn majors() {
        assert_eq!(pg_major(90624), 906);
        assert_eq!(pg_major(90005), 900);
        assert_eq!(pg_major(180006), 1800);
        assert!(pg_major(90624) < pg_major(100001));
        assert_eq!(pg_major_label(90624), "9.6");
        assert_eq!(pg_major_label(150004), "15");
    }

    #[test]
    fn archive_support() {
        assert_eq!(max_archive_version(180006), (1, 16));
        assert_eq!(max_archive_version(160010), (1, 15));
        assert_eq!(max_archive_version(90624), (1, 13));
        assert_eq!(max_archive_version(90005), (1, 12));
    }

    #[test]
    fn restrict_support() {
        assert!(psql_supports_restrict(180006));
        assert!(psql_supports_restrict(160010));
        assert!(!psql_supports_restrict(170005));
        assert!(!psql_supports_restrict(90624));
    }
}
