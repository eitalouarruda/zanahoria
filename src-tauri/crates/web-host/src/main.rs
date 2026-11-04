#[cfg(unix)]
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    zanahoria_web::run().await
}
#[cfg(not(unix))]
fn main() {
    eprintln!(
        "The headless server uses Unix sockets; use the native Zanahoria app on this platform."
    );
}
