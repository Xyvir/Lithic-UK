//! The file types this app opens, in one table for every platform.
//!
//! Three of this app's surfaces answer the question "which files does Lithic open", and they
//! answer it in three different vocabularies: Windows wants a ProgID per extension and a
//! description for each (`windows.rs`), a Linux desktop wants a `MimeType=` list in the entry
//! and a `shared-mime-info` glob for the one type no distribution ships (`linux.rs`), and a
//! phone wants intent filters in the manifest, because Android offers an app from a file's
//! *type* and never from its name (`scripts/patch-android.mjs`). They were three lists written
//! at three different times, which is how the EPUB ended up in two of them and the shim's own
//! entry in none.
//!
//! So the list is `associations.json`, beside this module, and it is the only place a type is
//! declared. What each platform does with a row is that platform's business: an extension and a
//! label become a ProgID here, a MIME type becomes a category there. The one field that is not
//! a spelling of the same fact is `imported`, which names the types this app does not edit but
//! converts into a Lith beside the file (a PDF's pages, a book's chapters, an image on a board).
//! Windows and Linux register those like any other, because there the file is on a filesystem
//! with the app's own write access beside it; the phone's filter leaves them out for the reason
//! `patch-android.mjs` states, since a `content://` reference has no beside to write a Lith in.
//!
//! Read by the Android patch script as well, which is the half that cannot ask Rust: it runs
//! before there is anything to compile. That is why the table is data rather than a `const` in
//! this file, and why the script is told to fail loudly if a row it needs is missing.

use std::sync::OnceLock;

use serde::Deserialize;

/// One file type this app opens.
#[derive(Deserialize)]
pub struct Association {
    /// The extension, without its dot.
    pub ext: String,
    /// What the platform's own "Open with" list calls the type.
    pub label: String,
    /// The type as the platform's MIME registry spells it.
    pub mime: String,
    /// Keep Lithic's own mark for this type rather than borrowing the one the platform already
    /// draws, which is a decision recorded with the reason in `windows.rs`.
    #[serde(default)]
    pub own_icon: bool,
    /// A type this app imports into a Lith beside it rather than editing in place.
    ///
    /// Read by `scripts/patch-android.mjs` and by nothing in this crate, which is why the field
    /// carries the allow: a phone has no beside to write a Lith beside a `content://` reference,
    /// so its manifest filters are the one consumer that has to leave these rows out, while the
    /// two desktop registrations offer every type in the table. A test below pins the rows, so
    /// the attribute cannot hide a flag that stopped matching the table.
    #[serde(default)]
    #[allow(dead_code)]
    pub imported: bool,
}

#[derive(Deserialize)]
struct Table {
    types: Vec<Association>,
}

/// The table, parsed once.
///
/// The file is compiled into the binary rather than read at run time: it describes what this
/// build can open, so it is part of the build, and an install that could not find it would
/// register nothing. A parse failure is a defect in the file itself, which the tests beside this
/// module refuse before it can ship, so the panic here is the loud version of a build mistake
/// rather than a case worth carrying.
pub fn all() -> &'static [Association] {
    static TABLE: OnceLock<Vec<Association>> = OnceLock::new();
    TABLE.get_or_init(|| {
        let parsed: Table = serde_json::from_str(include_str!("associations.json"))
            .expect("associations.json is this module's own table and must parse");
        parsed.types
    })
}

/// Whether this type keeps Lithic's own mark instead of borrowing one.
pub fn own_icon(ext: &str) -> bool {
    all()
        .iter()
        .any(|association| association.ext == ext && association.own_icon)
}

/// Every type as one `;`-separated list, which is how a freedesktop entry declares them.
///
/// One entry per MIME type, not per extension: `jpg` and `jpeg` are the same format and the
/// desktop's own registry resolves both to `image/jpeg`, so a list naming it twice would say
/// nothing and read as a mistake. The order is the table's, so the entry's line is stable
/// between builds and a reordering shows up as the one-line diff it is.
pub fn mime_types() -> String {
    let mut list = String::new();
    let mut seen: Vec<&str> = Vec::new();
    for association in all() {
        let mime = association.mime.as_str();
        if seen.contains(&mime) {
            continue;
        }
        seen.push(mime);
        list.push_str(mime);
        list.push(';');
    }
    list
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every row is filled in, and no type is claimed twice: the two rules a table this small
    /// can hold, and both of them are ones a copy-pasted row breaks.
    #[test]
    fn every_row_names_one_type_once() {
        assert!(!all().is_empty(), "a table with no types opens nothing");
        for (index, association) in all().iter().enumerate() {
            assert!(!association.ext.is_empty(), "row {index} has no extension");
            assert!(
                !association.ext.starts_with('.'),
                "{} is written with its dot, and the platforms add their own",
                association.ext
            );
            assert!(
                association.mime.contains('/'),
                "{}'s mime type is not a mime type: {}",
                association.ext,
                association.mime
            );
            assert!(!association.label.is_empty(), "{} has no description", association.ext);
            assert!(
                all().iter().skip(index + 1).all(|later| later.ext != association.ext),
                "{} is declared twice",
                association.ext
            );
        }
    }

    /// The formats this app is *about* keep their own mark, and nothing else claims to: the
    /// flag is a decision about three types, so a fourth one arriving is worth a second look.
    #[test]
    fn only_the_formats_this_app_is_about_keep_their_own_mark() {
        let marked: Vec<&str> = all()
            .iter()
            .filter(|association| association.own_icon)
            .map(|association| association.ext.as_str())
            .collect();
        assert_eq!(marked, vec!["lith", "tid", "json"]);
    }

    /// The imported types are the ones a phone's manifest must not claim, so the set is pinned
    /// here rather than left to whichever row happens to say so: a new type that needs importing
    /// is a decision, and so is one that stops needing it.
    #[test]
    fn the_imported_types_are_the_ones_a_phone_cannot_make_a_sibling_for() {
        let imported: Vec<&str> = all()
            .iter()
            .filter(|association| association.imported)
            .map(|association| association.ext.as_str())
            .collect();
        assert_eq!(imported, vec!["pdf", "epub", "png", "jpg", "jpeg", "bmp", "webp"]);
        assert!(
            !imported.contains(&"lith"),
            "this app's own format is a document it edits, never one it imports"
        );
    }

    /// The MIME list is deduplicated by type rather than by extension, which is the whole reason
    /// `jpg` and `jpeg` can both be rows.
    #[test]
    fn the_mime_list_names_each_type_once_and_ends_with_its_separator() {
        let list = mime_types();
        assert!(list.ends_with(';'), "{list}");
        assert_eq!(
            list.matches("image/jpeg").count(),
            1,
            "jpg and jpeg are one type: {list}"
        );
        assert_eq!(
            list.matches("application/x-lith").count(),
            1,
            "the project's own type is declared once: {list}"
        );
    }
}
