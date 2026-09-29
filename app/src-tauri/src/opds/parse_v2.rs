use super::feed::{Acquisition, Entry, Facet, FacetGroup, Feed, Group, Link};
use anyhow::Result;
use serde_json::Value;
use url::Url;

pub fn parse(bytes: &[u8], base_url: &str) -> Result<Feed> {
    let base = Url::parse(base_url).ok();
    let v: Value = serde_json::from_slice(bytes)?;
    let mut feed = Feed::default();

    if let Some(meta) = v.get("metadata") {
        feed.title = meta.get("title").and_then(|x| x.as_str()).unwrap_or("").to_string();
        feed.id = meta
            .get("identifier")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
    }

    if let Some(links) = v.get("links").and_then(|x| x.as_array()) {
        for l in links {
            let (href, rel, mime, title) = link_parts(l, &base);
            let rel_s = rel.as_deref().unwrap_or("");
            match rel_s {
                "self" => feed.self_link = Some(href),
                "next" => feed.next = Some(href),
                "previous" | "prev" => feed.prev = Some(href),
                "search" => feed.search_template = Some(href),
                _ => feed.navigation.push(Link { href, rel, title, mime }),
            }
        }
    }

    // OPDS 2.0 facets: an array of collections, each with a metadata title
    // and links refining the current feed.
    if let Some(facets) = v.get("facets").and_then(|x| x.as_array()) {
        for fc in facets {
            let group = fc
                .get("metadata")
                .and_then(|m| m.get("title"))
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let links = match fc.get("links").and_then(|x| x.as_array()) {
                Some(ls) => ls,
                None => continue,
            };
            let mut out = Vec::new();
            for l in links {
                let (href, rel, _mime, title) = link_parts(l, &base);
                if href.is_empty() {
                    continue;
                }
                out.push(Facet {
                    href,
                    title: title.unwrap_or_default(),
                    count: l
                        .get("properties")
                        .and_then(|p| p.get("numberOfItems"))
                        .and_then(|x| x.as_u64()),
                    // The applied facet points back at the current feed.
                    active: rel.as_deref() == Some("self"),
                });
            }
            if !out.is_empty() {
                feed.facets.push(FacetGroup { title: group, facets: out });
            }
        }
    }

    if let Some(nav) = v.get("navigation").and_then(|x| x.as_array()) {
        for l in nav {
            let (href, rel, mime, title) = link_parts(l, &base);
            feed.navigation.push(Link { href, rel, title, mime });
        }
    }

    if let Some(p) = v.get("publications").and_then(|x| x.as_array()) {
        for p in p {
            feed.entries.push(parse_publication(p, &base));
        }
    }

    // OPDS 2.0 groups keep their structure (title + self link + lane of
    // publications) so the library view can render one rail per group.
    // Their entries are also flattened into `feed.entries` so groups-only
    // feeds still show books in views that only read the flat list, and a
    // group's navigation links fold into the feed's navigation so they
    // remain reachable.
    if let Some(gs) = v.get("groups").and_then(|x| x.as_array()) {
        for g in gs {
            let title = g
                .get("metadata")
                .and_then(|m| m.get("title"))
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let href = g.get("links").and_then(|x| x.as_array()).and_then(|ls| {
                ls.iter().find_map(|l| {
                    let (href, rel, _mime, _title) = link_parts(l, &base);
                    (rel.as_deref() == Some("self") && !href.is_empty()).then_some(href)
                })
            });
            if let Some(nav) = g.get("navigation").and_then(|x| x.as_array()) {
                for l in nav {
                    let (href, rel, mime, title) = link_parts(l, &base);
                    feed.navigation.push(Link { href, rel, title, mime });
                }
            }
            let mut entries = Vec::new();
            if let Some(p) = g.get("publications").and_then(|x| x.as_array()) {
                for p in p {
                    entries.push(parse_publication(p, &base));
                }
            }
            if entries.is_empty() {
                continue;
            }
            feed.entries.extend(entries.iter().cloned());
            feed.groups.push(Group { title, href, entries });
        }
    }

    // A standalone publication document (a book's own page, type
    // application/opds-publication+json) is one publication at the root.
    let is_publication = v.get("publications").is_none()
        && v.get("navigation").is_none()
        && v.get("groups").is_none()
        && v.get("links").and_then(|x| x.as_array()).is_some_and(|ls| {
            ls.iter().any(|l| l.get("rel").and_then(|r| r.as_str()).is_some_and(|r| r.contains("acquisition")))
        });
    if is_publication {
        feed.navigation.clear();
        feed.entries.push(parse_publication(&v, &base));
    }

    Ok(feed)
}

fn parse_publication(p: &Value, base: &Option<Url>) -> Entry {
    let mut ent = Entry::default();
    if let Some(meta) = p.get("metadata") {
        ent.title = meta.get("title").and_then(|x| x.as_str()).unwrap_or("").to_string();
        ent.id = meta.get("identifier").and_then(|x| x.as_str()).unwrap_or("").to_string();
        ent.summary = meta.get("description").and_then(|x| x.as_str()).map(|s| s.to_string());
        ent.language = meta.get("language").and_then(|x| x.as_str()).map(|s| s.to_string());
        ent.published = meta.get("published").and_then(|x| x.as_str()).map(|s| s.to_string());
        ent.updated = meta.get("modified").and_then(|x| x.as_str()).map(|s| s.to_string());

        if let Some(author) = meta.get("author") {
            collect_names(author, &mut ent.authors);
        }
        if let Some(subj) = meta.get("subject").and_then(|x| x.as_array()) {
            for s in subj {
                if let Some(name) = s.as_str() {
                    ent.categories.push(name.to_string());
                } else if let Some(name) = s.get("name").and_then(|x| x.as_str()) {
                    ent.categories.push(name.to_string());
                }
            }
        }
        if let Some(series) = meta.get("belongsTo").and_then(|x| x.get("series")) {
            if let Some(name) = series.get("name").and_then(|x| x.as_str()) {
                ent.series = Some(name.to_string());
            }
        }
    }
    if let Some(images) = p.get("images").and_then(|x| x.as_array()) {
        for img in images {
            if let Some(href) = img.get("href").and_then(|x| x.as_str()) {
                let resolved = resolve(base, href);
                if ent.cover.is_none() {
                    ent.cover = Some(resolved.clone());
                }
                ent.thumbnail = Some(resolved);
            }
        }
    }
    if let Some(links) = p.get("links").and_then(|x| x.as_array()) {
        for l in links {
            let (href, rel, mime, title) = link_parts(l, base);
            let rel_s = rel.as_deref().unwrap_or("");
            if rel_s.contains("acquisition") {
                ent.acquisitions.push(Acquisition {
                    href,
                    mime,
                    rel,
                    title,
                    size: None,
                });
            } else {
                ent.navigation.push(Link { href, rel, title, mime });
            }
        }
    }
    ent
}

fn link_parts(
    l: &Value,
    base: &Option<Url>,
) -> (String, Option<String>, Option<String>, Option<String>) {
    let href = l
        .get("href")
        .and_then(|x| x.as_str())
        .map(|h| resolve(base, h))
        .unwrap_or_default();
    let rel = match l.get("rel") {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Array(a)) => a.first().and_then(|x| x.as_str()).map(|s| s.to_string()),
        _ => None,
    };
    let mime = l.get("type").and_then(|x| x.as_str()).map(|s| s.to_string());
    let title = l.get("title").and_then(|x| x.as_str()).map(|s| s.to_string());
    (href, rel, mime, title)
}

fn collect_names(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::String(s) => out.push(s.clone()),
        Value::Object(_) => {
            if let Some(name) = v.get("name").and_then(|x| x.as_str()) {
                out.push(name.to_string());
            }
        }
        Value::Array(arr) => {
            for x in arr {
                collect_names(x, out);
            }
        }
        _ => {}
    }
}

fn resolve(base: &Option<Url>, href: &str) -> String {
    if let Some(b) = base {
        if let Ok(u) = b.join(href) {
            return u.to_string();
        }
    }
    href.to_string()
}

#[cfg(test)]
mod tests {
    #[test]
    fn standalone_publication_document_is_one_entry() {
        let json = br#"{"metadata":{"title":"Dune","author":"Frank Herbert","description":"Full blurb"},
          "links":[{"rel":"self","href":"/pub/1","type":"application/opds-publication+json"},
                   {"rel":"http://opds-spec.org/acquisition","href":"/dl/1.epub","type":"application/epub+zip"}],
          "images":[{"href":"/c/1.jpg"}]}"#;
        let feed = super::parse(json, "https://x.org/pub/1").unwrap();
        assert_eq!(feed.entries.len(), 1);
        let e = &feed.entries[0];
        assert_eq!((e.title.as_str(), e.summary.as_deref()), ("Dune", Some("Full blurb")));
        assert_eq!(e.acquisitions[0].href, "https://x.org/dl/1.epub");
        assert_eq!(e.cover.as_deref(), Some("https://x.org/c/1.jpg"));
    }
}

