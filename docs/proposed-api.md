Yep — I’d model it around **three layers**:

1. **Archive** (the `.wacz` container + indexes)
2. **Entries** (files inside ZIP: indexes, warcs, pages, metadata)
3. **Captured responses** (URL + timestamp → payload + headers)

Here’s a clean API shape that stays simple, but scales when you add indexing/streaming later.

## Proposed top-level API

```js
const wacz = require("wacz-parser");

async function main () {
  const archive = await wacz.open("path/to/archive.wacz");

  // 1) ZIP/file-level introspection
  const files = await archive.listFiles();                 // [{ path, size, sha256?, mime? }, ...]
  const warcs = await archive.searchFiles(/\.warc(\.gz)?$/);

  const hasIndex = await archive.hasFile("indexes/cdxj");  // string or regex
  const meta = await archive.getJSON("datapackage.json");  // convenience

  // 2) URL capture querying (the “main point”)
  const captures = await archive.findCaptures("https://example.com/", {
    from: "2023-01-01",
    to: "2023-12-31",
    limit: 50
  }); // [{ url, ts, status, mime, digest, offset, length, warcPath }, ...]

  const closest = await archive.getCapture("https://example.com/", {
    at: "2023-06-01T12:00:00Z",
    strategy: "closest" // "before" | "after" | "closest"
  });

  if (closest) {
    const res = await closest.openResponse(); // stream-based
    console.log(res.status, res.headers["content-type"]);
    console.log(await res.text()); // or res.json(), res.buffer(), res.stream()
  }

  // 3) Direct file access (when you know the literal ZIP path)
  const file = await archive.getFile("pages/index.html");
  console.log(await file.text());

  await archive.close();
}

main();
```

---

## The objects and methods

### `wacz.open(pathOrReadable, options?) -> Archive`

**Options you’ll want from day 1**

* `preferIndex: "cdxj" | "cdx" | "none"` (default `"cdxj"`)
* `lazy: true` (don’t parse everything up front)
* `cache: { maxEntries, maxBytes }` (small in-memory cache)
* `signal` (AbortSignal) for cancellation

### `Archive`

**File/ZIP-level**

* `listFiles(): Promise<ArchiveFileInfo[]>`
* `searchFiles(pattern: RegExp | ((info)=>boolean)): Promise<ArchiveFileInfo[]>`
* `hasFile(pathOrPattern: string | RegExp): Promise<boolean>`
* `getFile(path: string): Promise<ArchiveFile>` (throws if not found)
* `getText(path: string, opts?): Promise<string>`
* `getJSON(path: string, opts?): Promise<any>`
* `streamFile(path: string): Promise<NodeJS.ReadableStream>`
* `close(): Promise<void>`

**Capture-level**

* `findCaptures(urlOrPattern: string | RegExp, opts?): Promise<CaptureInfo[]>`
* `getCapture(url: string, opts: { at: string|Date, strategy?: "closest"|"before"|"after" }): Promise<CaptureInfo|null>`
* `iterateCaptures(urlOrPattern, opts?): AsyncGenerator<CaptureInfo>` (for huge archives)
* `openCapture(capture: CaptureInfo): Promise<Capture>` (or `capture.openResponse()` shortcut)

### `ArchiveFile`

* `path: string`
* `size?: number`
* `stream(): Promise<Readable>`
* `buffer(): Promise<Buffer>`
* `text(encoding="utf8"): Promise<string>`
* `json(): Promise<any>`

### `CaptureInfo`

A *lightweight* record (good for lists/search results):

* `url: string`
* `ts: string` (ISO or WARC timestamp)
* `status?: number`
* `mime?: string`
* `digest?: string`
* `warcPath?: string`
* `offset?: number`
* `length?: number`

### `Capture`

A heavier object that actually opens bytes:

* `openResponse(): Promise<ArchivedResponse>`

### `ArchivedResponse`

* `status: number`
* `headers: Record<string,string>`
* `stream(): Readable`
* `buffer(): Promise<Buffer>`
* `text(): Promise<string>`
* `json(): Promise<any>`

---

## A couple of “nice” extras (still simple)

### Regex URL search, but index-friendly

Instead of “regex scan the whole WARC” as your main feature (slow), make this the primary:

```js
const caps = await archive.findCaptures(/example\.com\/(docs|blog)\//, { limit: 1000 });
```

Behind the scenes you can:

* use CDX/CDXJ index if present (fast)
* fall back to streaming WARC scan if not (slow, but works)

### Existence checks for URLs (very common)

```js
await archive.hasCapture("https://example.com/a"); // boolean
```

### Time travel convenience

```js
await archive.getTextAt("https://example.com/", { at: "2023-06-01" });
await archive.getJSONAt("https://example.com/api", { at: new Date(), strategy: "before" });
```

---

## TypeScript-friendly shape (optional, but worth it)

If you ship TS types, usage becomes self-documenting:

```ts
export interface FindCapturesOptions {
  from?: string | Date;
  to?: string | Date;
  limit?: number;
  status?: number | number[];
  mime?: string | RegExp;
}

export interface GetCaptureOptions {
  at: string | Date;
  strategy?: "closest" | "before" | "after";
}
```

---

If you want, I can also sketch:

* a tiny internal module layout (`zip.ts`, `index/cdxj.ts`, `warc/read.ts`, `capture.ts`)
* and the “fast path” for **open zip entry → stream gunzip (optional) → parse WARC record headers** without extracting anything to disk.
