use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Feed {
    pub title: String,
    pub id: String,
    pub entries: Vec<Entry>,
    /// Navigation links (subsections) that are themselves feeds.
    pub navigation: Vec<Link>,
    /// Facet groups: refinements (filters/sorts) of the current feed.
    pub facets: Vec<FacetGroup>,
    /// OPDS 2.0 groups: titled lanes of publications, each previewing a
    /// fuller feed (the group's `self` link).
    pub groups: Vec<Group>,
    pub next: Option<String>,
    pub prev: Option<String>,
    pub self_link: Option<String>,
    pub search_template: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Entry {
    pub id: String,
    pub title: String,
    pub authors: Vec<String>,
    pub summary: Option<String>,
    pub published: Option<String>,
    pub updated: Option<String>,
    pub language: Option<String>,
    pub identifiers: Vec<String>,
    pub categories: Vec<String>,
    pub series: Option<String>,
    /// Cover/thumbnail URLs, absolute.
    pub cover: Option<String>,
    pub thumbnail: Option<String>,
    /// Acquisition links (downloadable formats).
    pub acquisitions: Vec<Acquisition>,
    /// Sub-feed navigation links (e.g., grouped subsection entries).
    pub navigation: Vec<Link>,
}

/// An OPDS 2.0 group: a titled lane of publications previewing a fuller
/// feed. Its entries are also flattened into `Feed::entries` so views that
/// only read the flat list still show books.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Group {
    pub title: String,
    /// The full feed this group previews (its `self` link), absolute.
    pub href: Option<String>,
    pub entries: Vec<Entry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Acquisition {
    pub href: String,
    pub mime: Option<String>,
    pub rel: Option<String>,
    pub title: Option<String>,
    pub size: Option<u64>,
}

/// Facets grouped by `opds:facetGroup` (OPDS 1.x) or the facet collection's
/// metadata title (OPDS 2.0). Ungrouped facets land in a group with an
/// empty title.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct FacetGroup {
    pub title: String,
    pub facets: Vec<Facet>,
}

/// A single refinement link for the current feed (e.g. filter by tag,
/// author, or rating; sort by newest).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Facet {
    pub href: String,
    pub title: String,
    /// Number of entries behind this facet (thr:count / numberOfItems).
    pub count: Option<u64>,
    /// Whether this facet is currently applied to the feed.
    pub active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Link {
    pub href: String,
    pub rel: Option<String>,
    pub title: Option<String>,
    pub mime: Option<String>,
}
