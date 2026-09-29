use super::feed::{Acquisition, Entry, Facet, FacetGroup, Feed, Link};
use anyhow::Result;
use quick_xml::events::Event;
use quick_xml::name::QName;
use quick_xml::Reader;
use url::Url;

pub fn parse(bytes: &[u8], base_url: &str) -> Result<Feed> {
    let base = Url::parse(base_url).ok();
    // Don't trim at the event level: entity references split text into
    // multiple Text events, and per-fragment trimming eats the whitespace
    // around them ("Tom &amp; Jerry" → "Tom&Jerry"). Consumers trim the
    // assembled buffer instead.
    let mut reader = Reader::from_reader(bytes);

    let mut feed = Feed::default();
    let mut depth: i32 = 0;
    let mut entry_depth: Option<i32> = None;
    let mut current_entry: Option<Entry> = None;
    let mut text_buf = String::new();
    let mut capture_text = false;
    // Whether the current entry's summary was filled from <content>, which
    // outranks <summary>.
    let mut summary_from_content = false;
    // Depth of an open <content>/<summary>: XHTML descriptions nest <div>/<p>/<a>
    // inside it, which must add to the text instead of resetting it.
    let mut rich: Option<i32> = None;
    // current element path (top of stack inside entry)
    let mut elem_stack: Vec<String> = Vec::new();

    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf)? {
            Event::Eof => break,
            Event::Start(e) => {
                depth += 1;
                let name = local_name(e.name());
                let attrs = collect_attrs(&e);
                elem_stack.push(name.clone());

                if rich.is_some() {
                    // Markup inside a description: keep collecting its text.
                } else if entry_depth.is_some() {
                    if let Some(ent) = current_entry.as_mut() {
                        handle_entry_start(ent, &name, &attrs, &base);
                    }
                    capture_text = matches!(
                        name.as_str(),
                        "title"
                            | "id"
                            | "summary"
                            | "content"
                            | "name"
                            | "creator"
                            | "published"
                            | "updated"
                            | "language"
                            | "identifier"
                            | "series"
                    );
                    text_buf.clear();
                    if matches!(name.as_str(), "content" | "summary") {
                        rich = Some(depth);
                    }
                } else {
                    match name.as_str() {
                        "entry" => {
                            entry_depth = Some(depth);
                            current_entry = Some(Entry::default());
                            summary_from_content = false;
                        }
                        "title" | "id" | "subtitle" => {
                            capture_text = true;
                            text_buf.clear();
                        }
                        "link" => {
                            handle_feed_link(&mut feed, &attrs, &base);
                        }
                        _ => {}
                    }
                }
            }
            Event::Empty(e) => {
                let name = local_name(e.name());
                let attrs = collect_attrs(&e);
                if rich.is_some() {
                    if name == "br" {
                        text_buf.push(BLOCK_BREAK);
                    }
                } else if entry_depth.is_some() {
                    if let Some(ent) = current_entry.as_mut() {
                        handle_entry_start(ent, &name, &attrs, &base);
                    }
                } else if name == "link" {
                    handle_feed_link(&mut feed, &attrs, &base);
                }
            }
            Event::Text(t) => {
                if capture_text {
                    text_buf.push_str(&t.xml_content().unwrap_or_default());
                }
            }
            Event::CData(t) => {
                if capture_text {
                    text_buf.push_str(&String::from_utf8_lossy(t.as_ref()));
                }
            }
            // quick-xml emits entity/char references (&amp; &#39; ...) as
            // separate events rather than expanding them into Text — without
            // this arm they'd be silently dropped from titles and summaries.
            Event::GeneralRef(r) => {
                if capture_text {
                    if let Ok(Some(ch)) = r.resolve_char_ref() {
                        text_buf.push(ch);
                    } else if let Ok(name) = r.decode() {
                        match name.as_ref() {
                            "amp" => text_buf.push('&'),
                            "lt" => text_buf.push('<'),
                            "gt" => text_buf.push('>'),
                            "quot" => text_buf.push('"'),
                            "apos" => text_buf.push('\''),
                            // Unknown entity: keep it verbatim so HTML-typed
                            // summaries can still decode it in the webview.
                            other => {
                                text_buf.push('&');
                                text_buf.push_str(other);
                                text_buf.push(';');
                            }
                        }
                    }
                }
            }
            Event::End(e) => {
                let name = local_name(e.name());
                if rich.is_some_and(|d| depth > d) {
                    // Closing markup inside a description; block elements end a paragraph.
                    if matches!(name.as_str(), "p" | "div" | "li" | "br" | "h1" | "h2" | "h3" | "h4" | "tr") {
                        text_buf.push(BLOCK_BREAK);
                    }
                    elem_stack.pop();
                    depth -= 1;
                    buf.clear();
                    continue;
                }
                if rich == Some(depth) {
                    rich = None;
                    text_buf = tidy_rich_text(&text_buf);
                }
                let in_entry = entry_depth.is_some();

                if in_entry {
                    if let Some(ent) = current_entry.as_mut() {
                        handle_entry_end(
                            ent,
                            &name,
                            &text_buf,
                            &elem_stack,
                            &mut summary_from_content,
                        );
                    }
                    if Some(depth) == entry_depth && name == "entry" {
                        let mut ent = current_entry.take().unwrap_or_default();
                        // Author fallback: some catalogs (notably Project
                        // Gutenberg) stuff the author into <content type="text">
                        // when no <author> element exists. If the summary is
                        // short, single-line, and doesn't read like prose,
                        // promote it to the author field.
                        if ent.authors.is_empty() {
                            if let Some(s) = ent.summary.as_deref() {
                                let s = s.trim();
                                let looks_like_name = !s.is_empty()
                                    && s.len() <= 100
                                    && !s.contains('\n')
                                    && !matches!(s.chars().last(), Some('.') | Some('!') | Some('?'));
                                if looks_like_name {
                                    ent.authors.push(s.to_string());
                                    ent.summary = None;
                                }
                            }
                        }
                        // Decide whether this is a pure-navigation entry
                        // (e.g. Mayberry's root: <entry><title>Genres</title>
                        // <link rel="subsection".../></entry>) or a book entry
                        // that happens to use a subsection link to its detail
                        // page (Gutenberg pattern, with thumbnail + author in
                        // <content>). A link whose type declares the OPDS
                        // catalog profile points at another feed, so the entry
                        // is nav even when it carries a blurb and an icon
                        // thumbnail (COPS does both: "51 books" + custom.png).
                        // The rel varies (subsection, sort/new, none), so key
                        // off the type — excluding type=entry documents (a
                        // book's own detail page) and rel=related (COPS books
                        // link "Other books by X" with a catalog type).
                        // Otherwise fall back to the heuristic: no cover, no
                        // thumbnail, and no summary means nav.
                        let links_to_catalog = ent.navigation.iter().any(|l| {
                            l.rel.as_deref() != Some("related")
                                && l.mime.as_deref().is_some_and(|m| {
                                    m.contains("profile=opds-catalog")
                                        && !m.contains("type=entry")
                                })
                        });
                        // Project Gutenberg lists books as catalog-typed
                        // subsection links with a generic icon, so they'd read
                        // as navigation. Their ids name the book, and every
                        // book's real cover lives at a fixed path.
                        let gutenberg_cover = ent
                            .acquisitions
                            .is_empty()
                            .then(|| gutenberg_cover(&ent.id))
                            .flatten();
                        if let Some(cover) = &gutenberg_cover {
                            ent.cover = Some(cover.clone());
                            ent.thumbnail = Some(cover.clone());
                        }
                        let is_pure_nav = gutenberg_cover.is_none()
                            && ent.acquisitions.is_empty()
                            && !ent.navigation.is_empty()
                            && (links_to_catalog
                                || (ent.cover.is_none()
                                    && ent.thumbnail.is_none()
                                    && ent.summary.is_none()));
                        if is_pure_nav {
                            let entry_title = if !ent.title.is_empty() {
                                Some(ent.title.clone())
                            } else {
                                None
                            };
                            for mut nav in ent.navigation.drain(..) {
                                if nav.title.is_none() {
                                    nav.title = entry_title.clone();
                                }
                                feed.navigation.push(nav);
                            }
                        } else {
                            feed.entries.push(ent);
                        }
                        entry_depth = None;
                    }
                } else {
                    match name.as_str() {
                        "title" => feed.title = text_buf.trim().to_string(),
                        "id" => feed.id = text_buf.trim().to_string(),
                        _ => {}
                    }
                }
                capture_text = false;
                elem_stack.pop();
                depth -= 1;
            }
            _ => {}
        }
        buf.clear();
    }
    Ok(feed)
}

fn local_name(n: QName<'_>) -> String {
    let raw = String::from_utf8_lossy(n.as_ref());
    raw.rsplit_once(':').map(|(_, l)| l.to_string()).unwrap_or_else(|| raw.into_owned())
}

fn collect_attrs(e: &quick_xml::events::BytesStart<'_>) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for a in e.attributes().flatten() {
        let k = local_name(a.key);
        // XML-unescape attribute values (&#34; → ", &amp; → &, etc.).
        let v = a
            .unescape_value()
            .map(|c| c.into_owned())
            .unwrap_or_else(|_| String::from_utf8_lossy(&a.value).into_owned());
        out.push((k, v));
    }
    out
}

fn attr<'a>(attrs: &'a [(String, String)], key: &str) -> Option<&'a str> {
    attrs.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
}

fn resolve(base: &Option<Url>, href: &str) -> String {
    if let Some(b) = base {
        if let Ok(u) = b.join(href) {
            return u.to_string();
        }
    }
    href.to_string()
}

fn handle_feed_link(feed: &mut Feed, attrs: &[(String, String)], base: &Option<Url>) {
    let href = match attr(attrs, "href") {
        Some(h) => resolve(base, h),
        None => return,
    };
    let rel = attr(attrs, "rel").map(|s| s.to_string());
    let mime = attr(attrs, "type").map(|s| s.to_string());
    let title = attr(attrs, "title").map(|s| s.to_string());

    match rel.as_deref() {
        Some("self") => feed.self_link = Some(href),
        Some("next") => feed.next = Some(href),
        Some("previous") | Some("prev") => feed.prev = Some(href),
        Some("search") => {
            // We'll re-resolve the template after fetching the OpenSearch description.
            // For inline OPDS search links with type opensearchdescription, defer; for
            // direct search hrefs containing {searchTerms}, use as-is.
            if href.contains("{searchTerms}") {
                feed.search_template = Some(href);
            } else if mime.as_deref() == Some("application/opensearchdescription+xml") {
                // We mark this; a real-world client would fetch and parse the OSDD.
                feed.search_template = Some(href);
            }
        }
        Some("http://opds-spec.org/facet") => {
            // Attribute keys are stripped to local names, so
            // opds:facetGroup → facetGroup and thr:count → count.
            let group = attr(attrs, "facetGroup").unwrap_or("").to_string();
            let facet = Facet {
                href,
                title: title.unwrap_or_default(),
                count: attr(attrs, "count").and_then(|c| c.parse().ok()),
                active: attr(attrs, "activeFacet") == Some("true"),
            };
            push_facet(feed, group, facet);
        }
        _ => {
            feed.navigation.push(Link { href, rel, title, mime });
        }
    }
}

fn push_facet(feed: &mut Feed, group: String, facet: Facet) {
    if let Some(g) = feed.facets.iter_mut().find(|g| g.title == group) {
        g.facets.push(facet);
    } else {
        feed.facets.push(FacetGroup { title: group, facets: vec![facet] });
    }
}

fn handle_entry_start(
    ent: &mut Entry,
    name: &str,
    attrs: &[(String, String)],
    base: &Option<Url>,
) {
    if name == "link" {
        let href = match attr(attrs, "href") {
            Some(h) => resolve(base, h),
            None => return,
        };
        let rel = attr(attrs, "rel").map(|s| s.to_string());
        let mime = attr(attrs, "type").map(|s| s.to_string());
        let title = attr(attrs, "title").map(|s| s.to_string());

        let rel_s = rel.as_deref().unwrap_or("");
        if rel_s.starts_with("http://opds-spec.org/acquisition") {
            ent.acquisitions.push(Acquisition {
                href,
                mime,
                rel,
                title,
                size: None,
            });
        } else if rel_s == "http://opds-spec.org/image" {
            ent.cover = Some(href);
        } else if rel_s == "http://opds-spec.org/image/thumbnail"
            || rel_s == "http://opds-spec.org/thumbnail"
        {
            ent.thumbnail = Some(href);
        } else if rel_s == "subsection" || rel_s.is_empty() || rel_s == "alternate" {
            ent.navigation.push(Link { href, rel, title, mime });
        } else {
            ent.navigation.push(Link { href, rel, title, mime });
        }
    } else if name == "category" {
        // label is the human-readable form; term is the machine code.
        if let Some(label) = attr(attrs, "label") {
            ent.categories.push(label.to_string());
        } else if let Some(term) = attr(attrs, "term") {
            ent.categories.push(term.to_string());
        }
    }
}

fn handle_entry_end(
    ent: &mut Entry,
    name: &str,
    text: &str,
    stack: &[String],
    summary_from_content: &mut bool,
) {
    let parent = stack.iter().rev().nth(1).map(|s| s.as_str()).unwrap_or("");
    let txt = text.trim();
    if txt.is_empty() {
        return;
    }
    match name {
        "title" if parent == "entry" => ent.title = txt.to_string(),
        "id" if parent == "entry" => ent.id = txt.to_string(),
        // Atom convention: <summary> is a short blurb, <content> the full
        // description. Prefer content regardless of document order — feeds
        // that carry both used to lose the long one when summary came last.
        "content" if parent == "entry" => {
            ent.summary = Some(txt.to_string());
            *summary_from_content = true;
        }
        "summary" if parent == "entry" && !*summary_from_content => {
            ent.summary = Some(txt.to_string())
        }
        "name" if parent == "author" => ent.authors.push(txt.to_string()),
        "creator" if parent == "entry" => ent.authors.push(txt.to_string()),
        "published" if parent == "entry" => ent.published = Some(txt.to_string()),
        "updated" if parent == "entry" => ent.updated = Some(txt.to_string()),
        "language" => ent.language = Some(txt.to_string()),
        "identifier" => ent.identifiers.push(txt.to_string()),
        "series" => ent.series = Some(txt.to_string()),
        _ => {}
    }
}

/// Paragraph boundary inside a captured XHTML description.
const BLOCK_BREAK: char = '\u{1e}';

/// Collapse whitespace within paragraphs and join them with blank lines.
fn tidy_rich_text(raw: &str) -> String {
    if !raw.contains(BLOCK_BREAK) {
        return raw.to_string();
    }
    raw.split(BLOCK_BREAK)
        .map(|p| p.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// `https://www.gutenberg.org/ebooks/11.opds` -> that book's cover image URL.
fn gutenberg_cover(id: &str) -> Option<String> {
    let rest = id.split_once("gutenberg.org/ebooks/")?.1;
    let n = rest.strip_suffix(".opds").unwrap_or(rest);
    (!n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
        .then(|| format!("https://www.gutenberg.org/cache/epub/{n}/pg{n}.cover.medium.jpg"))
}

#[cfg(test)]
mod tests {
    use super::parse;

    #[test]
    fn decodes_entities_in_text() {
        let xml = br#"<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Tom &amp; Jerry</title>
    <id>1</id>
    <author><name>Jane Doe</name></author>
    <summary type="html">They weren&#39;t &lt;b&gt;ready&lt;/b&gt;</summary>
    <link rel="http://opds-spec.org/acquisition" href="/book.epub" type="application/epub+zip"/>
  </entry>
</feed>"#;
        let feed = parse(xml, "https://example.com/feed").unwrap();
        let ent = &feed.entries[0];
        assert_eq!(ent.title, "Tom & Jerry");
        assert_eq!(ent.summary.as_deref(), Some("They weren't <b>ready</b>"));
    }

    #[test]
    fn content_outranks_summary_regardless_of_order() {
        // Feeds that carry both fields put the short blurb in <summary> and
        // the full description in <content>; document order must not matter.
        let xml = br#"<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>A</title>
    <id>1</id>
    <author><name>Jane Doe</name></author>
    <content type="html">The full, much longer description of the book.</content>
    <summary>Short blurb.</summary>
    <link rel="http://opds-spec.org/acquisition" href="/a.epub" type="application/epub+zip"/>
  </entry>
  <entry>
    <title>B</title>
    <id>2</id>
    <author><name>Jane Doe</name></author>
    <summary>Short blurb.</summary>
    <content type="html">The full, much longer description of the book.</content>
    <link rel="http://opds-spec.org/acquisition" href="/b.epub" type="application/epub+zip"/>
  </entry>
</feed>"#;
        let feed = parse(xml, "https://example.com/feed").unwrap();
        for ent in &feed.entries {
            assert_eq!(
                ent.summary.as_deref(),
                Some("The full, much longer description of the book."),
                "entry {} lost the full description",
                ent.id
            );
        }
    }

    #[test]
    fn cops_nav_entries_with_blurb_and_icon_are_navigation() {
        // COPS nav entries carry a content blurb and an icon thumbnail, but
        // their subsection link types declare the OPDS catalog profile.
        let xml = br#"<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Fantasy</title>
    <id>cops:custom:54:1</id>
    <content type="text">51 books</content>
    <link href="/feed/custom/54/1" type="application/atom+xml;profile=opds-catalog;kind=acquisition" rel="subsection"/>
    <link href="/images/custom.png" type="image/png" rel="http://opds-spec.org/image/thumbnail" title="icon"/>
  </entry>
</feed>"#;
        let feed = parse(xml, "https://example.com/feed").unwrap();
        assert!(feed.entries.is_empty());
        assert_eq!(feed.navigation.len(), 1);
        assert_eq!(feed.navigation[0].title.as_deref(), Some("Fantasy"));
        assert_eq!(
            feed.navigation[0].href,
            "https://example.com/feed/custom/54/1"
        );
    }

    #[test]
    fn xhtml_content_keeps_its_text_and_paragraphs() {
        let xml = br#"<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Pride and Prejudice</title>
    <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">
      <p>This edition had all images removed.</p>
      <p>
Summary:
A novel about <a href="/x">first impressions</a>.
      </p>
    </div></content>
    <link type="application/epub+zip" rel="http://opds-spec.org/acquisition" href="/b.epub"/>
  </entry>
</feed>"#;
        let feed = parse(xml, "https://example.com/feed").unwrap();
        assert_eq!(
            feed.entries[0].summary.as_deref(),
            Some("This edition had all images removed.\n\nSummary: A novel about first impressions.")
        );
    }

    #[test]
    fn gutenberg_list_entries_are_books_with_real_covers() {
        // m.gutenberg.org / www list pages: catalog-typed subsection link + icon thumbnail.
        let xml = br#"<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>https://www.gutenberg.org/ebooks/11.opds</id>
    <title>Alice's Adventures in Wonderland</title>
    <content type="text">Lewis Carroll</content>
    <link type="application/atom+xml;profile=opds-catalog" rel="subsection" href="/ebooks/11.opds"/>
    <link type="image/png" rel="http://opds-spec.org/image/thumbnail" href="data:image/png;base64,AAAA"/>
  </entry>
</feed>"#;
        let feed = parse(xml, "https://m.gutenberg.org/ebooks/search.opds/").unwrap();
        assert!(feed.navigation.is_empty());
        let e = &feed.entries[0];
        assert_eq!(e.authors, vec!["Lewis Carroll"]);
        assert_eq!(e.cover.as_deref(), Some("https://www.gutenberg.org/cache/epub/11/pg11.cover.medium.jpg"));
        assert_eq!(e.navigation[0].href, "https://m.gutenberg.org/ebooks/11.opds");
    }

    #[test]
    fn gutenberg_detail_link_entry_stays_a_book() {
        // Gutenberg book entries link to their detail page with a bare
        // atom type (no catalog profile) and carry a thumbnail — they must
        // stay in entries so the Book page can resolve them.
        let xml = br#"<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Frankenstein</title>
    <id>urn:gutenberg:84</id>
    <content type="text">Mary Shelley</content>
    <link href="/ebooks/84" type="application/atom+xml" rel="subsection"/>
    <link href="/cache/84/small.jpg" type="image/jpeg" rel="http://opds-spec.org/image/thumbnail"/>
  </entry>
</feed>"#;
        let feed = parse(xml, "https://example.com/feed").unwrap();
        assert_eq!(feed.entries.len(), 1);
        assert_eq!(feed.entries[0].title, "Frankenstein");
    }

    #[test]
    fn sorted_catalog_entry_is_navigation() {
        // COPS "Recent additions" uses a sort rel instead of subsection;
        // the catalog-profile type still marks it as navigation. A book's
        // own detail document (type=entry) must not.
        let xml = br#"<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Recent additions</title>
    <id>cops:recentbooks</id>
    <content type="text">50 most recent books</content>
    <link href="/feed/recent" type="application/atom+xml;profile=opds-catalog;kind=acquisition" rel="http://opds-spec.org/sort/new"/>
    <link href="/images/recent.png" type="image/png" rel="http://opds-spec.org/image/thumbnail" title="icon"/>
  </entry>
  <entry>
    <title>A Book</title>
    <id>book:1</id>
    <content type="text">A summary.</content>
    <link href="/entry/1" type="application/atom+xml;type=entry;profile=opds-catalog" rel="alternate"/>
    <link href="/thumb/1.jpg" type="image/jpeg" rel="http://opds-spec.org/image/thumbnail"/>
  </entry>
</feed>"#;
        let feed = parse(xml, "https://example.com/feed").unwrap();
        assert_eq!(feed.entries.len(), 1);
        assert_eq!(feed.entries[0].title, "A Book");
        assert_eq!(feed.navigation.len(), 1);
        assert_eq!(feed.navigation[0].title.as_deref(), Some("Recent additions"));
    }

    #[test]
    fn facet_links_are_grouped_not_navigation() {
        let xml = br#"<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog" xmlns:thr="http://purl.org/syndication/thread/1.0">
  <link href="/feed/tags/7/Fantasy" rel="http://opds-spec.org/facet" title="Fantasy" opds:facetGroup="Tags" thr:count="2"/>
  <link href="/feed/tags/1/Funny" rel="http://opds-spec.org/facet" title="Funny" opds:facetGroup="Tags" opds:activeFacet="true"/>
  <link href="/feed/ratings/1/4_stars" rel="http://opds-spec.org/facet" title="4 stars" opds:facetGroup="Ratings" thr:count="1"/>
</feed>"#;
        let feed = parse(xml, "https://example.com/feed").unwrap();
        assert!(feed.navigation.is_empty());
        assert_eq!(feed.facets.len(), 2);
        let tags = &feed.facets[0];
        assert_eq!(tags.title, "Tags");
        assert_eq!(tags.facets.len(), 2);
        assert_eq!(tags.facets[0].title, "Fantasy");
        assert_eq!(tags.facets[0].count, Some(2));
        assert!(!tags.facets[0].active);
        assert!(tags.facets[1].active);
        assert_eq!(feed.facets[1].title, "Ratings");
    }

    #[test]
    fn category_prefers_label_over_term() {
        let xml = br#"<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Book</title>
    <id>1</id>
    <category term="FIC009000" label="Fantasy"/>
    <category term="Humour"/>
    <link rel="http://opds-spec.org/acquisition" href="/b.epub" type="application/epub+zip"/>
  </entry>
</feed>"#;
        let feed = parse(xml, "https://example.com/feed").unwrap();
        assert_eq!(feed.entries[0].categories, vec!["Fantasy", "Humour"]);
    }
}


