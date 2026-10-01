//! OPDS 1.2 (Atom) and 2.0 (JSON) catalog client, ported from common-stacks
//! (same author, MIT). Trimmed for this app: catalogs are stored by the
//! frontend and passed in per call, auth is None/Basic/Bearer (no OAuth
//! authentication documents), and there is no federated search.

pub mod feed;
pub mod parse_v1;
pub mod parse_v2;

use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use feed::Feed;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, USER_AGENT};
use serde::Deserialize;
use std::time::Duration;

// Prefer OPDS 2.0 JSON when offered (it's the only way catalogs expose
// audiobooks), falling back to OPDS 1.2 Atom via q-weighted negotiation.
const OPDS_ACCEPT: &str = "application/opds+json, application/atom+xml;profile=opds-catalog;q=0.8, application/atom+xml;q=0.7, application/xml;q=0.6, */*;q=0.5";
const UA: &str = "CrossPoint Sync (+https://github.com/crosspoint-reader/crosspoint-sync)";

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Auth {
  #[default]
  None,
  Basic { username: String, password: String },
  Bearer { token: String },
}

pub fn apply(req: reqwest::RequestBuilder, auth: &Auth) -> reqwest::RequestBuilder {
  match auth {
    Auth::None => req,
    Auth::Basic { username, password } => {
      req.header("Authorization", format!("Basic {}", B64.encode(format!("{}:{}", username, password))))
    }
    Auth::Bearer { token } => req.header("Authorization", format!("Bearer {}", token)),
  }
}

fn client(timeout: u64) -> reqwest::Client {
  let mut headers = HeaderMap::new();
  headers.insert(ACCEPT, HeaderValue::from_static(OPDS_ACCEPT));
  headers.insert(USER_AGENT, HeaderValue::from_static(UA));
  reqwest::Client::builder()
    .default_headers(headers)
    .timeout(Duration::from_secs(timeout))
    .connect_timeout(Duration::from_secs(15))
    .build()
    .expect("reqwest client")
}

fn check(resp: reqwest::Response) -> Result<reqwest::Response> {
  if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
    return Err(anyhow!("This catalog needs a username and password (or token). Edit it to add them."));
  }
  Ok(resp.error_for_status()?)
}

// Some catalogs (Gutenberg's m. host) answer the odd 502-504; one retry clears it.
async fn get(auth: &Auth, url: &str) -> Result<reqwest::Response> {
  let resp = apply(client(60).get(url), auth).send().await?;
  if matches!(resp.status().as_u16(), 502..=504) {
    tokio::time::sleep(Duration::from_millis(800)).await;
    return check(apply(client(60).get(url), auth).send().await?);
  }
  check(resp)
}

pub async fn fetch_feed(auth: &Auth, url: &str) -> Result<Feed> {
  let resp = get(auth, url).await?;
  let ct = resp
    .headers()
    .get(reqwest::header::CONTENT_TYPE)
    .and_then(|v| v.to_str().ok())
    .unwrap_or("")
    .to_ascii_lowercase();
  let bytes = resp.bytes().await?;
  if ct.contains("json") {
    parse_v2::parse(&bytes, url)
  } else if ct.contains("xml") || ct.contains("atom") {
    parse_v1::parse(&bytes, url)
  } else {
    // Best-effort sniff.
    let head = std::str::from_utf8(&bytes[..bytes.len().min(256)]).unwrap_or("");
    match head.trim_start().chars().next() {
      Some('{') => parse_v2::parse(&bytes, url),
      Some('<') => parse_v1::parse(&bytes, url),
      _ => Err(anyhow!("That address didn't return an OPDS catalog ({})", ct)),
    }
  }
}

pub async fn search(auth: &Auth, root_url: &str, query: &str) -> Result<Feed> {
  let root = fetch_feed(auth, root_url).await?;
  let advertised = root.search_template.ok_or_else(|| anyhow!("This catalog doesn't support search"))?;
  // Catalogs advertise either a template directly or an OpenSearch description (OSDD).
  let template = if expand_search_template(&advertised, "").is_some() {
    advertised
  } else {
    let body = get(auth, &advertised).await?.text().await?;
    parse_osdd(&body, &advertised).ok_or_else(|| anyhow!("Couldn't read this catalog's search description"))?
  };
  let url = expand_search_template(&template, query).ok_or_else(|| anyhow!("Unsupported search template: {}", template))?;
  fetch_feed(auth, &url).await
}

/// Download a book, reporting (downloaded, total) as it streams.
/// Returns (bytes, Content-Type, Content-Disposition).
pub async fn download(
  auth: &Auth,
  url: &str,
  mut on_progress: impl FnMut(u64, Option<u64>),
) -> Result<(Vec<u8>, Option<String>, Option<String>)> {
  let mut resp = check(apply(client(600).get(url), auth).send().await?)?;
  let header = |k| resp.headers().get(k).and_then(|v| v.to_str().ok()).map(String::from);
  let ct = header(reqwest::header::CONTENT_TYPE);
  let cd = header(reqwest::header::CONTENT_DISPOSITION);
  let total = resp.content_length();
  let mut bytes = Vec::new();
  while let Some(chunk) = resp.chunk().await? {
    bytes.extend_from_slice(&chunk);
    on_progress(bytes.len() as u64, total);
  }
  Ok((bytes, ct, cd))
}

/// Parse an OpenSearch Description Document and return the best atom/opds
/// search URL template. Returns None if no usable template is found.
/// Expand an OPDS search template. Catalogs advertise either OpenSearch's
/// {searchTerms} (OPDS 1.2 and OSDD documents) or, per the OPDS 2.0 spec's
/// search convention, an RFC 6570 URI template expanding the `query`
/// variable ({?query}, {&query}, or {query}). Returns None when the string
/// contains no recognizable template.
fn expand_search_template(template: &str, query: &str) -> Option<String> {
    let q = urlencoding(query);
    if template.contains("{searchTerms}") {
        return Some(template.replace("{searchTerms}", &q));
    }
    // RFC 6570 expressions, possibly multi-variable: {?query,per-page,page},
    // {&query}, {query}. Expand `query`; drop variables we don't send.
    let mut out = String::new();
    let mut rest = template;
    let mut expanded_query = false;
    while let Some(start) = rest.find('{') {
        let Some(len) = rest[start..].find('}') else { break };
        out.push_str(&rest[..start]);
        let expr = &rest[start + 1..start + len];
        rest = &rest[start + len + 1..];

        let (op, vars) = match expr.as_bytes().first() {
            Some(b'?') => ("?", &expr[1..]),
            Some(b'&') => ("&", &expr[1..]),
            _ => ("", expr),
        };
        if vars.split(',').any(|v| v == "query") {
            match op {
                "" => out.push_str(&q),
                _ => out.push_str(&format!("{}query={}", op, q)),
            }
            expanded_query = true;
        }
        // Expressions without `query` expand to nothing.
    }
    out.push_str(rest);
    expanded_query.then_some(out)
}

fn parse_osdd(xml: &str, base_url: &str) -> Option<String> {
    use quick_xml::events::Event;
    use quick_xml::Reader;

    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    // (priority, template)
    let mut best: Option<(u8, String)> = None;
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Eof) | Err(_) => break,
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                let name = e.name();
                let local = name
                    .as_ref()
                    .rsplit(|b| *b == b':')
                    .next()
                    .unwrap_or(name.as_ref());
                if local != b"Url" {
                    continue;
                }
                let mut tpl: Option<String> = None;
                let mut ty = String::new();
                let mut rel = String::new();
                for a in e.attributes().flatten() {
                    let k = a.key.as_ref();
                    let key = k
                        .rsplit(|b| *b == b':')
                        .next()
                        .unwrap_or(k);
                    let v = a
                        .unescape_value()
                        .map(|c| c.into_owned())
                        .unwrap_or_else(|_| String::from_utf8_lossy(&a.value).into_owned());
                    match key {
                        b"template" => tpl = Some(v),
                        b"type" => ty = v,
                        b"rel" => rel = v,
                        _ => {}
                    }
                }
                let Some(tpl) = tpl else { continue };
                if rel.eq_ignore_ascii_case("suggestions") || rel.eq_ignore_ascii_case("self") {
                    continue;
                }
                // Prefer OPDS-flavored atom feeds; then plain atom; then anything.
                let prio = if ty.contains("opds-catalog") {
                    0
                } else if ty.contains("atom+xml") {
                    1
                } else if ty.is_empty() {
                    2
                } else if ty.contains("html") {
                    9 // last resort — we can't parse HTML results
                } else {
                    3
                };
                let absolute = resolve_url(base_url, &tpl);
                if best.as_ref().map_or(true, |(p, _)| prio < *p) {
                    best = Some((prio, absolute));
                }
            }
            _ => {}
        }
        buf.clear();
    }
    best.map(|(_, t)| t)
}

fn resolve_url(base: &str, href: &str) -> String {
    if let Ok(b) = url::Url::parse(base) {
        if let Ok(joined) = b.join(href) {
            return joined.to_string();
        }
    }
    href.to_string()
}

fn urlencoding(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

#[cfg(test)]
mod search_template_tests {
    use super::expand_search_template;

    #[test]
    fn expands_known_template_forms() {
        // Standard Ebooks (RFC 6570 multi-variable form expansion)
        assert_eq!(
            expand_search_template("https://x.org/all{?query,per-page,page}", "silver age").unwrap(),
            "https://x.org/all?query=silver+age"
        );
        assert_eq!(
            expand_search_template("https://x.org/s?a=1{&query,page}", "q").unwrap(),
            "https://x.org/s?a=1&query=q"
        );
        assert_eq!(
            expand_search_template("https://x.org/s/{query}", "q").unwrap(),
            "https://x.org/s/q"
        );
        assert_eq!(
            expand_search_template("https://x.org/s?q={searchTerms}", "q").unwrap(),
            "https://x.org/s?q=q"
        );
        // No query variable anywhere: unusable.
        assert!(expand_search_template("https://x.org/all{?page}", "q").is_none());
        assert!(expand_search_template("https://x.org/all", "q").is_none());
    }
}

#[cfg(test)]
mod live_tests {
  // Network: `cargo test -- --ignored`. Gutenberg's search returns books as
  // subsection links to per-book feeds, which carry the acquisitions.
  #[tokio::test]
  #[ignore]
  async fn gutenberg_search_to_download_link() {
    let root = "https://m.gutenberg.org/ebooks.opds/";
    let hits = super::search(&super::Auth::None, root, "pride and prejudice").await.unwrap();
    // List entries are books with real covers that link to their detail feed.
    let hit = &hits.entries[0];
    assert!(hit.cover.as_deref().is_some_and(|c| c.contains("/cache/epub/")));
    let feed = super::fetch_feed(&super::Auth::None, &hit.navigation[0].href).await.unwrap();
    let entry = &feed.entries[0];
    assert!(entry.cover.is_some());
    assert!(entry.acquisitions.iter().any(|a| a.mime.as_deref() == Some("application/epub+zip")));
  }
}




