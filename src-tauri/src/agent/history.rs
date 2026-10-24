// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

//! The drafts a conversation has produced, so the person can go back to an earlier one.
//!
//! Sanctum keeps its own copy of every distinct `app.html` it sees at the end of a turn, in
//! memory, never in the work folder: the agent can rewrite that folder at will, and a copy it
//! could edit would not be a record. Going back writes a kept copy over `app.html` again, so the
//! agent carries on from it. Nothing here touches the library; versions there are separate.

use crate::commands::scan::extract_name;
use crate::commands::versioning::hash_bytes_hex;
use serde::Serialize;

/// Most drafts kept per conversation. The oldest is dropped first.
pub const MAX_KEPT: usize = 20;
/// Most bytes kept per conversation, across all drafts.
pub const MAX_KEPT_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct Kept {
    pub sha: String,
    pub bytes: Vec<u8>,
    pub number: u32,
    pub at: i64,
    /// The file the conversation started from (an app taken from the library), not written by
    /// the agent.
    pub loaded: bool,
    pub name: String,
}

#[derive(Debug, Default)]
pub struct History {
    kept: Vec<Kept>,
    next: u32,
}

/// One draft, as the interface lists it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub sha: String,
    pub number: u32,
    pub size: u64,
    /// Unix seconds.
    pub at: i64,
    pub loaded: bool,
    /// The file in the work folder is this one right now.
    pub current: bool,
    pub name: String,
}

impl History {
    /// Keeps `bytes` unless this exact file is already kept. Returns the draft's number when it
    /// is new.
    pub fn record(&mut self, bytes: Vec<u8>, loaded: bool, at: i64) -> Option<u32> {
        let sha = hash_bytes_hex(&bytes);
        if self.kept.iter().any(|k| k.sha == sha) {
            return None;
        }
        self.next += 1;
        let name = std::str::from_utf8(&bytes)
            .map(extract_name)
            .unwrap_or_default();
        self.kept.push(Kept {
            sha,
            bytes,
            number: self.next,
            at,
            loaded,
            name,
        });
        // Never drops the newest, so a single huge file is still kept.
        while self.kept.len() > 1
            && (self.kept.len() > MAX_KEPT
                || self.kept.iter().map(|k| k.bytes.len()).sum::<usize>() > MAX_KEPT_BYTES)
        {
            self.kept.remove(0);
        }
        Some(self.next)
    }

    pub fn get(&self, sha: &str) -> Option<&Kept> {
        self.kept.iter().find(|k| k.sha == sha)
    }

    /// Newest first. `current` is the SHA-256 of the file in the work folder now, if any.
    pub fn list(&self, current: Option<&str>) -> Vec<Entry> {
        self.kept
            .iter()
            .rev()
            .map(|k| Entry {
                sha: k.sha.clone(),
                number: k.number,
                size: k.bytes.len() as u64,
                at: k.at,
                loaded: k.loaded,
                current: current == Some(k.sha.as_str()),
                name: k.name.clone(),
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(n: usize) -> Vec<u8> {
        format!("<title>Page {n}</title>").into_bytes()
    }

    #[test]
    fn each_distinct_file_is_kept_once_and_numbered_in_order() {
        let mut h = History::default();
        assert_eq!(h.record(page(1), false, 10), Some(1));
        assert_eq!(h.record(page(2), false, 20), Some(2));
        // The same file again (after going back, or an unchanged turn) is not a new draft.
        assert_eq!(h.record(page(1), false, 30), None);
        assert_eq!(h.record(page(3), false, 40), Some(3));
        let l = h.list(None);
        assert_eq!(l.iter().map(|e| e.number).collect::<Vec<_>>(), [3, 2, 1]);
        assert_eq!(l[0].name, "Page 3");
    }

    #[test]
    fn the_current_file_is_marked_and_a_started_from_file_is_labelled() {
        let mut h = History::default();
        h.record(page(1), true, 1);
        h.record(page(2), false, 2);
        let sha1 = hash_bytes_hex(&page(1));
        let l = h.list(Some(&sha1));
        assert!(l[1].current && l[1].loaded);
        assert!(!l[0].current && !l[0].loaded);
        assert!(h.list(None).iter().all(|e| !e.current));
        assert!(h.get(&sha1).is_some());
        assert!(h.get("nope").is_none());
    }

    #[test]
    fn the_oldest_goes_first_and_a_lone_huge_file_is_still_kept() {
        let mut h = History::default();
        for n in 0..(MAX_KEPT + 5) {
            h.record(page(n), false, n as i64);
        }
        let l = h.list(None);
        assert_eq!(l.len(), MAX_KEPT);
        assert_eq!(l[0].number as usize, MAX_KEPT + 5);
        assert!(h.get(&hash_bytes_hex(&page(0))).is_none());

        let mut big = History::default();
        let huge = vec![b'a'; MAX_KEPT_BYTES + 1];
        assert_eq!(big.record(huge.clone(), false, 0), Some(1));
        assert_eq!(big.list(None).len(), 1);
        big.record(page(1), false, 1);
        // The huge one is over the byte budget, so it makes way for the newer file.
        assert_eq!(big.list(None).len(), 1);
        assert_eq!(big.list(None)[0].number, 2);
    }

    #[test]
    fn a_file_that_is_not_text_still_gets_an_entry() {
        let mut h = History::default();
        h.record(vec![0xff, 0xfe, 0x00], false, 0);
        assert_eq!(h.list(None)[0].name, "");
    }
}
