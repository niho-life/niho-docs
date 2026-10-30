# @niho/editor-publish-contract

Machine-readable contract v1 for the editor's read-only publish API: the three endpoints NIHO Experience, NIHO and owners' sites use to render published pages. Behavior and server obligations: [`docs/security/editor-publish-api-v1.md`](../../docs/security/editor-publish-api-v1.md). Consumers pin the exact commit SHA and never copy edits by hand.

- types, constants, endpoint and error tables: [`src/v1.ts`](src/v1.ts)
- runtime validation for what a destination receives: [`src/validate.ts`](src/validate.ts)
- AST → safe Markdown projection and subset checker: [`src/markdown.ts`](src/markdown.ts)
- canonical JSON, strong ETag, `If-None-Match`: [`src/etag.ts`](src/etag.ts)
- key / token shapes, masking, `Authorization` parsing: [`src/keys.ts`](src/keys.ts)
- synthetic scenarios and expected results: [`v1/cases.json`](v1/cases.json), inputs in [`fixtures/`](fixtures/)
- test-only reference model: [`test-support/reference-server.ts`](test-support/reference-server.ts)

Validate every response before rendering it, and render the AST (`blocks`) rather than trusting anything else. The reference model is **not** a production authorization implementation; it runs the public scenarios so that destinations and the private server can check themselves against the same negative cases. Passing them does not prove the private API enforces authorization.

Keys (`ek_…`), service tokens and preview tokens (`pv_…`) are secrets: never log, persist or report them, and display keys only through `maskKey`. The package depends on the ES library, WHATWG URL, TextEncoder and Web Crypto only (Node 24, browsers, workers).

```sh
npm ci
npm run check   # typecheck + tests
```
