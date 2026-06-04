# SBOM — Software Bill of Materials (v1)

## Purpose
Each tool ingested into Sanctum should ship with an SBOM so operators know exactly
what dependencies the tool bundles. For single-file HTML tools, the SBOM typically
covers:
- Inlined JavaScript libraries (identified by name/version embedded in bundle comments)
- Fonts, stylesheets, or binary assets embedded as data URIs
- Any third-party scripts loaded from CDNs (detected by the capability scanner's net
  host extraction)

## Format
CycloneDX JSON (spec version 1.6) — machine-readable, widely supported by SBOM
tooling (Dependency-Track, Grype, Trivy).

## Generation plan (v1)
1. During ingest, parse the HTML for known library fingerprints (header comments like
   `/* jquery-3.7.1.min.js */`, `/* react@18.3.1 */`).
2. Cross-reference against the OSV vulnerability database for known CVEs.
3. Attach the SBOM JSON to the tool version record in the manifest.
4. The registry (v3) can augment the SBOM with server-side analysis.

## Operator integration
SBOM files are exported to this directory during `sanctum sbom export --tool-id <id>`.
They can be imported into Dependency-Track or similar tools for continuous vulnerability
monitoring.
