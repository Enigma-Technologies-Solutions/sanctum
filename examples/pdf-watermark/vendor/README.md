# Vendored code

`pdf-lib.min.js` is pdf-lib 1.17.1 (MIT, Andrew Dillon), the browser build from the npm package
`pdf-lib@1.17.1`, unmodified. Its licence is in `pdf-lib.LICENSE.md`.

SHA-256 of the file: `0f9a5cad07941f0826586c94e089d89b918c46e5c17cf2d5a3c6f666e3bc694f`

It is inlined into `index.html` by `build.mjs`, so the tool stays one file with no network.
The build and `test/vendor.test.mjs` check the hash above, and that the file contains no
`</script`, no `eval(` and no `new Function`.

To update: install the new version with `npm i pdf-lib@<version> --ignore-scripts` somewhere
outside the repository, copy `dist/pdf-lib.min.js` and `LICENSE.md` here, update the version and
hash in this file and in `build.mjs`, run the tests, and review the change like code.
