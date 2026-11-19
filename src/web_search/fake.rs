// Deterministic in-memory adapter for tests and route fixtures: no network,
// no keys. Scenario fields decide what search and read return and how often
// each was called.

use std::sync::atomic::{AtomicUsize, Ordering};

use futures_util::future::BoxFuture;

use super::{AdapterError, ProviderHit, ProviderReadPage, SearchAdapter};

pub struct FakeAdapter {
    hits: Vec<ProviderHit>,
    page: Option<ProviderReadPage>,
    search_failure: Option<AdapterError>,
    read_failure: Option<AdapterError>,
    search_calls: AtomicUsize,
}

impl FakeAdapter {
    pub fn new() -> Self {
        Self {
            hits: Vec::new(),
            page: None,
            search_failure: None,
            read_failure: None,
            search_calls: AtomicUsize::new(0),
        }
    }

    pub fn with_hits(mut self, hits: Vec<ProviderHit>) -> Self {
        self.hits = hits;
        self
    }

    pub fn with_page(
        mut self,
        url: Option<String>,
        title: Option<String>,
        content_markdown: String,
    ) -> Self {
        self.page = Some(ProviderReadPage {
            url,
            title,
            content_markdown,
        });
        self
    }

    pub fn failing(mut self, search_failure: AdapterError) -> Self {
        self.search_failure = Some(search_failure);
        self
    }

    pub fn failing_read(mut self, read_failure: AdapterError) -> Self {
        self.read_failure = Some(read_failure);
        self
    }

    pub fn search_calls(&self) -> usize {
        self.search_calls.load(Ordering::Relaxed)
    }
}

impl SearchAdapter for FakeAdapter {
    fn search<'a>(
        &'a self,
        _query: &'a str,
        _count: u32,
    ) -> BoxFuture<'a, Result<Vec<ProviderHit>, AdapterError>> {
        Box::pin(async move {
            self.search_calls.fetch_add(1, Ordering::Relaxed);
            if let Some(failure) = self.search_failure {
                return Err(failure);
            }
            Ok(self.hits.clone())
        })
    }

    fn read<'a>(&'a self, url: &'a str) -> BoxFuture<'a, Result<ProviderReadPage, AdapterError>> {
        Box::pin(async move {
            if let Some(failure) = self.read_failure {
                return Err(failure);
            }
            // Echo the requested URL when no page was configured, mirroring
            // a provider that reports the URL it read.
            Ok(self.page.clone().unwrap_or(ProviderReadPage {
                url: Some(url.to_owned()),
                title: None,
                content_markdown: String::new(),
            }))
        })
    }
}
