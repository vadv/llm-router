// Entry point only: allocator, runtime, config path, then hand over to app.
#[global_allocator]
static ALLOCATOR: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;

mod api;
mod app;
mod config;
mod history;
mod metamodel;
mod model;
mod provider;
mod routing;
mod schedule;
mod storage;
mod web;
mod web_search;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // The router's init.d passes the path via GW_CONFIG; argv still wins.
    let config_path = std::env::args()
        .nth(1)
        .or_else(|| std::env::var("GW_CONFIG").ok())
        .unwrap_or_else(|| "config.yaml".into());
    let config = config::load(std::path::Path::new(&config_path))?;
    let app = app::App::build(config)?;
    app.run().await
}
