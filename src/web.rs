// Static UI files, embedded at compile time by build.rs.
//
// The UI uses hash routes (#/pools and so on), so every request path is a
// file path: an unknown path is a missing file, not a route to rewrite.

use axum::body::Body;
use axum::http::{HeaderMap, Method, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};

include!(concat!(env!("OUT_DIR"), "/web_assets.rs"));

/// Embedded file for a request path: "/" is the entry document.
fn find(path: &str) -> Option<&'static (&'static str, &'static [u8], &'static str)> {
    let path = if path == "/" { "/index.html" } else { path };
    ASSETS.iter().find(|(name, _, _)| *name == path)
}

/// The UI stores the client key in the browser, so the entry document
/// gets a CSP; `style-src` needs 'unsafe-inline' for Mantine styles.
const CSP: &str = "script-src 'self'; style-src 'self' 'unsafe-inline'";

/// Serve the UI. The route table handles the API first, so this answers
/// everything else.
pub async fn serve(method: Method, uri: Uri, headers: HeaderMap) -> Response {
    if method != Method::GET && method != Method::HEAD {
        return (StatusCode::METHOD_NOT_ALLOWED, "method not allowed\n").into_response();
    }
    let Some((path, bytes, mime)) = find(uri.path()) else {
        return (StatusCode::NOT_FOUND, "not found\n").into_response();
    };
    // Asset names carry a content hash, so they never change under one name.
    // The entry document must be revalidated, or a new build keeps serving
    // the old asset names.
    let cache = if path.starts_with("/assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    // The 600 KB of JS and CSS go out as plain bytes otherwise; mobile
    // access to the router pays for that.
    let wants_gzip = headers
        .get(header::ACCEPT_ENCODING)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.contains("gzip"));
    let mut response = (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, *mime),
            (header::CACHE_CONTROL, cache),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (header::REFERRER_POLICY, "no-referrer"),
        ],
        Body::from(*bytes),
    )
        .into_response();
    if mime.starts_with("text/html") {
        response
            .headers_mut()
            .insert(header::CONTENT_SECURITY_POLICY, CSP.parse().unwrap());
    }
    if wants_gzip && compressible(mime) {
        compress(&mut response, path, bytes);
    }
    response
}

/// Text and WebAssembly compress well; images already have their own codecs.
fn compressible(mime: &str) -> bool {
    mime.starts_with("text/")
        || mime.contains("javascript")
        || mime.contains("json")
        || mime == "application/wasm"
}

/// The router serves a handful of clients; compressing per request is
/// simpler than pre-compressing at build time.
fn compress(response: &mut Response, path: &str, bytes: &[u8]) {
    use flate2::{Compression, write::GzEncoder};
    use std::io::Write;
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    match encoder.write_all(bytes).and_then(|_| encoder.finish()) {
        Ok(gz) => {
            let headers = response.headers_mut();
            headers.insert(header::CONTENT_ENCODING, "gzip".parse().unwrap());
            headers.insert(header::VARY, "Accept-Encoding".parse().unwrap());
            *response.body_mut() = Body::from(gz);
        }
        Err(e) => eprintln!("[web] gzip {path}: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_serves_the_entry_document() {
        let (path, body, mime) = *find("/").expect("/ must serve index.html");
        assert_eq!(path, "/index.html");
        assert!(mime.starts_with("text/html"));
        assert!(!body.is_empty());
    }

    #[test]
    fn unknown_paths_are_missing_files() {
        assert!(find("/v1/nothing").is_none());
        assert!(find("/index.html/../config.yaml").is_none());
    }

    #[test]
    fn every_asset_has_a_content_type() {
        for (path, body, mime) in ASSETS {
            assert!(!body.is_empty(), "{path} is empty");
            if path.ends_with(".wasm") {
                assert_eq!(*mime, "application/wasm", "{path}");
                assert!(compressible(mime));
            }
            assert!(
                !mime.ends_with("octet-stream"),
                "{path} has no content type"
            );
        }
    }

    #[tokio::test]
    async fn entry_document_carries_security_headers() {
        let mut headers = HeaderMap::new();
        headers.insert(header::ACCEPT_ENCODING, "gzip".parse().unwrap());
        let response = serve(Method::GET, Uri::from_static("/"), headers).await;
        assert_eq!(response.status(), StatusCode::OK);
        let h = response.headers();
        assert_eq!(h.get(header::X_CONTENT_TYPE_OPTIONS).unwrap(), "nosniff");
        assert_eq!(h.get(header::REFERRER_POLICY).unwrap(), "no-referrer");
        let csp = h
            .get(header::CONTENT_SECURITY_POLICY)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(csp.contains("script-src 'self'"), "csp: {csp}");
        assert!(
            !csp.contains("unsafe-eval"),
            "unsafe-eval must never appear: {csp}"
        );
        assert!(csp.contains("style-src 'self' 'unsafe-inline'"));
    }

    #[tokio::test]
    async fn assets_are_gzipped_when_accepted() {
        // Check a hashed asset from the actual frontend build.
        let (path, _, _) = *ASSETS
            .iter()
            .find(|(name, _, _)| name.starts_with("/assets/"))
            .expect("the build embeds assets");
        let uri: Uri = path.parse().unwrap();
        let plain = serve(Method::GET, uri.clone(), HeaderMap::new()).await;
        assert!(plain.headers().get(header::CONTENT_ENCODING).is_none());

        let mut headers = HeaderMap::new();
        headers.insert(header::ACCEPT_ENCODING, "gzip, br".parse().unwrap());
        let zipped = serve(Method::GET, uri, headers).await;
        assert_eq!(
            zipped.headers().get(header::CONTENT_ENCODING).unwrap(),
            "gzip"
        );
        assert_eq!(
            zipped.headers().get(header::VARY).unwrap(),
            "Accept-Encoding"
        );
        let bytes = axum::body::to_bytes(zipped.into_body(), 4 << 20)
            .await
            .unwrap();
        // The marker bytes of a gzip member.
        assert_eq!(&bytes[..2], &[0x1f, 0x8b]);
    }
}
