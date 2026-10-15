// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

//! A small JSON Schema validator for the registry schemas in `spec/registry/schema`.
//!
//! The schemas are the source of truth for what a registry file may contain, and the Node
//! reference reads the same files. Embedding and interpreting them here, instead of
//! re-writing their rules as Rust, means the two implementations cannot drift apart.
//!
//! It supports exactly the keywords those schemas use: `type`, `const`, `enum`, `pattern`,
//! `minLength`, `maxLength`, `minimum`, `maximum`, `minItems`, `maxItems`, `required`,
//! `properties`, `items` and `$ref`. Unknown properties are allowed. A new keyword in a
//! schema file fails `unsupported_keywords_are_refused` rather than being ignored.

use regex::Regex;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SchemaFile {
    Common,
    Index,
    App,
    Revocations,
    Sigfile,
}

impl SchemaFile {
    fn name(self) -> &'static str {
        match self {
            SchemaFile::Common => "common.schema.json",
            SchemaFile::Index => "index.schema.json",
            SchemaFile::App => "app.schema.json",
            SchemaFile::Revocations => "revocations.schema.json",
            SchemaFile::Sigfile => "sigfile.schema.json",
        }
    }

    fn from_name(name: &str) -> Option<SchemaFile> {
        [
            SchemaFile::Common,
            SchemaFile::Index,
            SchemaFile::App,
            SchemaFile::Revocations,
            SchemaFile::Sigfile,
        ]
        .into_iter()
        .find(|f| f.name() == name)
    }

    fn source(self) -> &'static str {
        match self {
            SchemaFile::Common => {
                include_str!("../../../../../spec/registry/schema/common.schema.json")
            }
            SchemaFile::Index => {
                include_str!("../../../../../spec/registry/schema/index.schema.json")
            }
            SchemaFile::App => include_str!("../../../../../spec/registry/schema/app.schema.json"),
            SchemaFile::Revocations => {
                include_str!("../../../../../spec/registry/schema/revocations.schema.json")
            }
            SchemaFile::Sigfile => {
                include_str!("../../../../../spec/registry/schema/sigfile.schema.json")
            }
        }
    }
}

fn document(file: SchemaFile) -> &'static Value {
    static DOCS: OnceLock<HashMap<&'static str, Value>> = OnceLock::new();
    let docs = DOCS.get_or_init(|| {
        [
            SchemaFile::Common,
            SchemaFile::Index,
            SchemaFile::App,
            SchemaFile::Revocations,
            SchemaFile::Sigfile,
        ]
        .into_iter()
        .map(|f| {
            let v: Value = serde_json::from_str(f.source())
                .unwrap_or_else(|e| panic!("embedded schema {} is not JSON: {e}", f.name()));
            (f.name(), v)
        })
        .collect()
    });
    &docs[file.name()]
}

fn regex(pattern: &str) -> Regex {
    static CACHE: OnceLock<Mutex<HashMap<String, Regex>>> = OnceLock::new();
    let mut cache = CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    cache
        .entry(pattern.to_string())
        .or_insert_with(|| {
            Regex::new(pattern).unwrap_or_else(|e| panic!("schema pattern {pattern}: {e}"))
        })
        .clone()
}

#[cfg(test)]
const KEYWORDS: &[&str] = &[
    "$schema",
    "$id",
    "$comment",
    "$defs",
    "$ref",
    "type",
    "const",
    "enum",
    "pattern",
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "minItems",
    "maxItems",
    "required",
    "properties",
    "items",
];

fn resolve(reference: &str, current: SchemaFile) -> (&'static Value, SchemaFile) {
    let (file, pointer) = reference.split_once('#').unwrap_or((reference, ""));
    let file = if file.is_empty() {
        current
    } else {
        SchemaFile::from_name(file).unwrap_or_else(|| panic!("unknown schema file {file}"))
    };
    let mut node = document(file);
    for part in pointer.split('/').filter(|p| !p.is_empty()) {
        node = node
            .get(part)
            .unwrap_or_else(|| panic!("unresolved reference {reference}"));
    }
    (node, file)
}

/// JSON has no integer type. A number is an integer if it has no fractional part, which is
/// what JavaScript's `Number.isInteger` says after `JSON.parse`, so `7.0` is accepted.
fn is_integer(v: &Value) -> bool {
    match v {
        Value::Number(n) => {
            n.is_i64()
                || n.is_u64()
                || n.as_f64()
                    .is_some_and(|f| f.is_finite() && f.fract() == 0.0)
        }
        _ => false,
    }
}

fn type_name(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn check(schema: &Value, value: &Value, path: &str, file: SchemaFile, errors: &mut Vec<String>) {
    if let Some(r) = schema.get("$ref").and_then(Value::as_str) {
        let (target, target_file) = resolve(r, file);
        return check(target, value, path, target_file, errors);
    }
    if let Some(t) = schema.get("type").and_then(Value::as_str) {
        let ok = match t {
            "integer" => is_integer(value),
            "number" => value.is_number(),
            other => type_name(value) == other,
        };
        if !ok {
            errors.push(format!("{path}: expected {t}"));
            return;
        }
    }
    if let Some(c) = schema.get("const") {
        if c != value {
            errors.push(format!("{path}: must be {c}"));
        }
    }
    if let Some(options) = schema.get("enum").and_then(Value::as_array) {
        if !options.contains(value) {
            errors.push(format!("{path}: not an allowed value"));
        }
    }
    match value {
        Value::String(s) => {
            let len = s.chars().count() as u64;
            if schema
                .get("minLength")
                .and_then(Value::as_u64)
                .is_some_and(|m| len < m)
            {
                errors.push(format!("{path}: too short"));
            }
            if schema
                .get("maxLength")
                .and_then(Value::as_u64)
                .is_some_and(|m| len > m)
            {
                errors.push(format!("{path}: too long"));
            }
            if let Some(p) = schema.get("pattern").and_then(Value::as_str) {
                if !regex(p).is_match(s) {
                    errors.push(format!("{path}: bad format"));
                }
            }
        }
        Value::Number(n) => {
            let f = n.as_f64().unwrap_or(f64::NAN);
            if schema
                .get("minimum")
                .and_then(Value::as_f64)
                .is_some_and(|m| f < m)
            {
                errors.push(format!("{path}: below minimum"));
            }
            if schema
                .get("maximum")
                .and_then(Value::as_f64)
                .is_some_and(|m| f > m)
            {
                errors.push(format!("{path}: above maximum"));
            }
        }
        Value::Array(items) => {
            let len = items.len() as u64;
            if schema
                .get("minItems")
                .and_then(Value::as_u64)
                .is_some_and(|m| len < m)
            {
                errors.push(format!("{path}: too few items"));
            }
            if schema
                .get("maxItems")
                .and_then(Value::as_u64)
                .is_some_and(|m| len > m)
            {
                errors.push(format!("{path}: too many items"));
            }
            if let Some(item_schema) = schema.get("items") {
                for (i, item) in items.iter().enumerate() {
                    check(item_schema, item, &format!("{path}[{i}]"), file, errors);
                }
            }
        }
        Value::Object(map) => {
            if let Some(required) = schema.get("required").and_then(Value::as_array) {
                for key in required.iter().filter_map(Value::as_str) {
                    if !map.contains_key(key) {
                        errors.push(format!("{path}.{key}: missing"));
                    }
                }
            }
            if let Some(props) = schema.get("properties").and_then(Value::as_object) {
                for (key, sub) in props {
                    if let Some(v) = map.get(key) {
                        check(sub, v, &format!("{path}.{key}"), file, errors);
                    }
                }
            }
        }
        _ => {}
    }
}

/// Problems with `value` against `file`'s schema. Empty means valid.
pub fn validate(file: SchemaFile, value: &Value) -> Vec<String> {
    let mut errors = Vec::new();
    check(document(file), value, "$", file, &mut errors);
    errors
}

/// Rewrite numbers with no fractional part as integers, so typed deserialisation accepts
/// `7.0` exactly as the schema check does. Applied only after validation.
pub fn normalize_integers(v: &mut Value) {
    match v {
        Value::Number(n) => {
            if !(n.is_i64() || n.is_u64()) {
                if let Some(f) = n.as_f64() {
                    if f.is_finite() && f.fract() == 0.0 {
                        if f >= 0.0 && f <= u64::MAX as f64 {
                            *v = Value::from(f as u64);
                        } else if f < 0.0 && f >= i64::MIN as f64 {
                            *v = Value::from(f as i64);
                        }
                    }
                }
            }
        }
        Value::Array(a) => a.iter_mut().for_each(normalize_integers),
        Value::Object(o) => o.values_mut().for_each(normalize_integers),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn all_keys(v: &Value, out: &mut Vec<String>) {
        match v {
            Value::Object(m) => {
                for (k, sub) in m {
                    out.push(k.clone());
                    // Property names under "properties" and "$defs" are data, not keywords.
                    if k == "properties" || k == "$defs" {
                        if let Value::Object(inner) = sub {
                            inner.values().for_each(|s| all_keys(s, out));
                        }
                    } else {
                        all_keys(sub, out);
                    }
                }
            }
            Value::Array(a) => a.iter().for_each(|s| all_keys(s, out)),
            _ => {}
        }
    }

    #[test]
    fn unsupported_keywords_are_refused() {
        for f in [
            SchemaFile::Common,
            SchemaFile::Index,
            SchemaFile::App,
            SchemaFile::Revocations,
            SchemaFile::Sigfile,
        ] {
            let mut keys = Vec::new();
            all_keys(document(f), &mut keys);
            for k in keys {
                assert!(
                    KEYWORDS.contains(&k.as_str()),
                    "{} uses keyword {k}, which this validator does not implement",
                    f.name()
                );
            }
        }
    }

    #[test]
    fn integers_follow_javascript_rules() {
        assert!(is_integer(&json!(7)));
        assert!(is_integer(&serde_json::from_str::<Value>("7.0").unwrap()));
        assert!(!is_integer(&json!(7.5)));
        assert!(!is_integer(&json!("7")));
        let mut v = serde_json::from_str::<Value>(r#"{"a": 7.0, "b": [1.0, 2.5]}"#).unwrap();
        normalize_integers(&mut v);
        assert_eq!(v["a"].as_u64(), Some(7));
        assert_eq!(v["b"][0].as_u64(), Some(1));
        assert_eq!(v["b"][1].as_f64(), Some(2.5));
    }

    #[test]
    fn a_minimal_revocations_file_validates_and_a_broken_one_does_not() {
        let good = json!({
            "format": "sanctum-registry-revocations/1",
            "registry": "registry:sh.enigma.public",
            "serial": 1, "issued_at": 1, "expires": 2, "entries": []
        });
        assert!(validate(SchemaFile::Revocations, &good).is_empty());
        let mut bad = good.clone();
        bad["registry"] = json!("sh.enigma.public");
        bad["serial"] = json!(0);
        let problems = validate(SchemaFile::Revocations, &bad);
        assert_eq!(problems.len(), 2, "{problems:?}");
    }

    #[test]
    fn missing_required_fields_and_oversize_arrays_are_reported() {
        let mut doc = json!({
            "format": "sanctum-registry-revocations/1",
            "registry": "registry:sh.enigma.public",
            "serial": 1, "issued_at": 1, "expires": 2, "entries": []
        });
        assert!(validate(SchemaFile::Revocations, &doc).is_empty());
        doc.as_object_mut().unwrap().remove("expires");
        let problems = validate(SchemaFile::Revocations, &doc);
        assert_eq!(problems, vec!["$.expires: missing".to_string()]);

        // maxItems: an index may list at most 4 mirrors.
        let mut index = json!({
            "format": "sanctum-registry/1", "id": "registry:a.b", "name": "n", "kind": "public",
            "serial": 1, "issued_at": 1, "expires": 2, "apps": [],
            "mirrors": ["https://a.test/", "https://b.test/", "https://c.test/", "https://d.test/"]
        });
        assert!(validate(SchemaFile::Index, &index).is_empty());
        index["mirrors"]
            .as_array_mut()
            .unwrap()
            .push(json!("https://e.test/"));
        assert_eq!(
            validate(SchemaFile::Index, &index),
            vec!["$.mirrors: too many items".to_string()]
        );
        // minItems: an app must list at least one version.
        let hash = format!("sha256:{}", "0".repeat(64));
        index["mirrors"] = json!([]);
        index["apps"] = json!([{
            "app_id": "a.b", "name": "n", "summary": "s", "access": "free", "latest": "1",
            "publisher": { "keyid": format!("ed25519:{}", "A".repeat(43)), "name": "p" },
            "detail": { "path": "apps/a.b.json", "sha256": hash, "size": 5 },
            "versions": []
        }]);
        assert_eq!(
            validate(SchemaFile::Index, &index),
            vec!["$.apps[0].versions: too few items".to_string()]
        );
    }
}
