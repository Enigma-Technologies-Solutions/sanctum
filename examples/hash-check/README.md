# Hash Check (example tool)

Checks a file against the checksum its publisher gave you, written as a single HTML file for
Sanctum. The file is read in this window, in 4 MB pieces, and hashed on your computer. Nothing is
stored, uploaded or sent.

## What it asks Sanctum for

Nothing. The approval screen is empty: no storage, no network host, no smart card, no device
access. The file picker and the copy button are not capabilities.

## What it does

- **SHA-256, SHA-384 and SHA-512** (FIPS 180-4), for files of any size. A progress bar and a Stop
  button appear while a large file is read.
- **Reads what people paste.** A bare hash, `sha256:` followed by a hash, GNU lines
  (`hash  name`, as `sha256sum` writes them), BSD lines (`SHA256 (name) = hash`), and a hash
  grouped with spaces or colons. A whole `SHA256SUMS` file works: the line whose name matches
  the chosen file is used.
- **Sets the algorithm from the checksum.** A pasted hash is 64, 96 or 128 characters, and that
  length says which algorithm it is. A tag that disagrees with the length is not guessed.
- **Refuses MD5 and SHA-1.** They are recognised so the tool can say why it is not comparing,
  and they never produce a "Match".
- **Says what a match means.** A match shows the file is the one the checksum was made from. It
  does not show the checksum came from the publisher. Get the checksum from a channel you trust,
  and prefer a signed checksum file when the publisher offers one.

## How the hashing is built

The core (`src/hash-core.js`) has no DOM, no imports and no network. It derives the SHA-2
constants at load from the square and cube roots of the first primes, as the standard defines
them, instead of carrying tables that could hold a typo. SHA-512 and SHA-384 work on pairs of
32-bit words because 64-bit integers are slow in a browser.

The tests (`node --test test/*.test.mjs`) check:

- the NIST known answers, including one million `a`;
- every message length from 0 to 300 bytes, which covers each padding boundary, against Node's own
  `crypto` module;
- random messages up to 300 KB, and the same input cut into pieces of many sizes;
- a 600 MiB input, where the length in bits passes 2^32;
- the parser for every pasted form listed above, and the choice of line for a file.

## Files

- `src/app.template.html` is the interface. It has a placeholder where the core is inlined.
- `src/hash-core.js` is the hashing and parsing core.
- `index.html` is the built single file that you add to Sanctum.

## Rebuild

```bash
node build.mjs
```

The build needs only Node. It fails if the core or the placeholder is missing, or if the core
contains `</script`. `--mock <file>` inlines a different core, and `--out <path>` writes
somewhere else.

## Licence

Part of Sanctum, AGPL-3.0. Icons are from Lucide (ISC).
