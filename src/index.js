const path = require('node:path')
const { Readable } = require('node:stream')
const { createGunzip } = require('node:zlib')
const yauzl = require('yauzl')

async function open (filePath, options = {}) {
  const archive = new Archive(filePath, options)
  await archive._init()
  return archive
}

class Archive {
  constructor (filePath, options) {
    this.filePath = filePath
    this.options = options
    this._zipfile = null
    this._files = []
    this._fileMap = new Map()
    this._cdxIndex = null
    this._warcCache = new Map()
  }

  async _init () {
    this._zipfile = await openZip(this.filePath)
    await this._collectEntries()
  }

  async _collectEntries () {
    const zip = this._zipfile
    await new Promise((resolve, reject) => {
      zip.on('error', reject)
      zip.on('end', resolve)
      zip.on('entry', entry => {
        if (/\/$/.test(entry.fileName)) {
          zip.readEntry()
          return
        }
        const info = {
          path: entry.fileName,
          size: entry.uncompressedSize
        }
        this._files.push(info)
        this._fileMap.set(entry.fileName, entry)
        zip.readEntry()
      })
      zip.readEntry()
    })
  }

  async listFiles () {
    return this._files.slice()
  }

  async searchFiles (pattern) {
    if (typeof pattern === 'function') {
      return this._files.filter(pattern)
    }
    if (pattern instanceof RegExp) {
      return this._files.filter(f => pattern.test(f.path))
    }
    return this._files.filter(f => f.path.includes(String(pattern)))
  }

  async hasFile (pathOrPattern) {
    if (pathOrPattern instanceof RegExp) {
      return this._files.some(f => pathOrPattern.test(f.path))
    }
    return this._fileMap.has(pathOrPattern)
  }

  async getFile (filePath) {
    const entry = this._fileMap.get(filePath)
    if (!entry) throw new Error(`File not found in archive: ${filePath}`)
    return new ArchiveFile(this, entry)
  }

  async streamFile (filePath) {
    const file = await this.getFile(filePath)
    return file.stream()
  }

  async getText (filePath, encoding = 'utf8') {
    const file = await this.getFile(filePath)
    return file.text(encoding)
  }

  async getJSON (filePath, encoding = 'utf8') {
    const file = await this.getFile(filePath)
    return file.json(encoding)
  }

  async findCaptures (urlOrPattern, opts = {}) {
    const captures = await this._loadCdxIndex()
    const matcher = buildUrlMatcher(urlOrPattern)
    const filtered = captures.filter(cap => matcher(cap.url))
    return filterCapturesByOptions(filtered, opts)
  }

  async getCapture (url, opts) {
    if (!opts || !opts.at) throw new Error('getCapture requires { at } option')
    const captures = await this.findCaptures(url, { from: null, to: null })
    if (!captures.length) return null
    const targetTs = normalizeDate(opts.at)
    const strategy = opts.strategy || 'closest'
    let best = null
    let bestDelta = Infinity
    for (const cap of captures) {
      const capTs = new Date(cap.ts).getTime()
      const delta = capTs - targetTs
      if (strategy === 'before' && delta > 0) continue
      if (strategy === 'after' && delta < 0) continue
      const abs = Math.abs(delta)
      if (abs < bestDelta) {
        bestDelta = abs
        best = cap
      }
    }
    return best || null
  }

  async * iterateCaptures (urlOrPattern, opts = {}) {
    const captures = await this.findCaptures(urlOrPattern, opts)
    for (const cap of captures) {
      yield cap
    }
  }

  async openCapture (capture) {
    return new Capture(this, capture)
  }

  async close () {
    if (this._zipfile) {
      this._zipfile.close()
    }
  }

  async _openEntryStream (entry) {
    const zip = this._zipfile
    return new Promise((resolve, reject) => {
      zip.openReadStream(entry, (err, stream) => {
        if (err || !stream) return reject(err || new Error('missing stream'))
        resolve(stream)
      })
    })
  }

  async _loadCdxIndex () {
    if (this._cdxIndex) return this._cdxIndex
    const preferIndex = this.options.preferIndex || 'cdxj'
    const candidatePaths = []
    if (preferIndex === 'cdx') candidatePaths.push('indexes/index.cdx')
    else if (preferIndex === 'cdxj') candidatePaths.push('indexes/index.cdxj', 'indexes/index.cdx')
    else candidatePaths.push('indexes/index.cdx')

    let indexEntry = null
    for (const p of candidatePaths) {
      if (this._fileMap.has(p)) {
        indexEntry = p
        break
      }
    }
    if (!indexEntry) throw new Error('No index file found in archive')
    const text = await this.getText(indexEntry)
    const captures = parseCdx(text)
    this._cdxIndex = captures
    return captures
  }

  async _loadWarcRecords (warcPath) {
    if (this._warcCache.has(warcPath)) return this._warcCache.get(warcPath)
    const warcFilePath = warcPath.startsWith('archive/') ? warcPath : path.posix.join('archive', warcPath)
    const file = await this.getFile(warcFilePath)
    let stream = await file.stream()
    if (warcFilePath.endsWith('.gz')) {
      stream = stream.pipe(createGunzip())
    }
    const buffer = await streamToBuffer(stream)
    const records = parseWarc(buffer)
    const byKey = new Map()
    for (const rec of records) {
      const key = `${rec.headers['WARC-Target-URI'] || ''}|${rec.headers['WARC-Date'] || ''}`
      byKey.set(key, rec)
    }
    const data = { records, byKey }
    this._warcCache.set(warcPath, data)
    return data
  }
}

class ArchiveFile {
  constructor (archive, entry) {
    this.archive = archive
    this.entry = entry
    this.path = entry.fileName
    this.size = entry.uncompressedSize
  }

  async stream () {
    return this.archive._openEntryStream(this.entry)
  }

  async buffer () {
    const stream = await this.stream()
    return streamToBuffer(stream)
  }

  async text (encoding = 'utf8') {
    const buf = await this.buffer()
    return buf.toString(encoding)
  }

  async json (encoding = 'utf8') {
    const txt = await this.text(encoding)
    return JSON.parse(txt)
  }
}

class Capture {
  constructor (archive, info) {
    this.archive = archive
    this.info = info
  }

  async openResponse () {
    const warcPath = this.info.warcPath || this.info.filename || this.info.file || 'archive/data.warc.gz'
    const { byKey } = await this.archive._loadWarcRecords(warcPath)
    const key = `${this.info.url}|${toISODate(this.info.ts)}`
    const record = byKey.get(key) || null
    if (!record) throw new Error('Capture not found in WARC')
    const http = parseHttpResponse(record.payload)
    return new ArchivedResponse(http)
  }
}

class ArchivedResponse {
  constructor (http) {
    this.status = http.status
    this.headers = http.headers
    this._body = http.body
  }

  stream () {
    return Readable.from(this._body)
  }

  async buffer () {
    return Buffer.from(this._body)
  }

  async text () {
    return this._body.toString('utf8')
  }

  async json () {
    return JSON.parse(await this.text())
  }
}

function openZip (filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: false }, (err, zipfile) => {
      if (err || !zipfile) return reject(err)
      resolve(zipfile)
    })
  })
}

async function streamToBuffer (stream) {
  const chunks = []
  for await (const chunk of stream) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function buildUrlMatcher (urlOrPattern) {
  if (urlOrPattern instanceof RegExp) {
    return (url) => urlOrPattern.test(url)
  }
  return (url) => url === urlOrPattern
}

function filterCapturesByOptions (captures, opts) {
  const out = []
  const { from, to, limit, status, mime } = opts
  const fromTs = from ? normalizeDate(from) : null
  const toTs = to ? normalizeDate(to) : null
  for (const cap of captures) {
    const ts = new Date(cap.ts).getTime()
    if (fromTs && ts < fromTs) continue
    if (toTs && ts > toTs) continue
    if (status != null) {
      if (Array.isArray(status)) {
        if (!status.includes(cap.status)) continue
      } else if (cap.status !== status) continue
    }
    if (mime) {
      if (mime instanceof RegExp) {
        if (!mime.test(cap.mime || '')) continue
      } else if (cap.mime !== mime) continue
    }
    out.push(cap)
    if (limit && out.length >= limit) break
  }
  return out
}

function parseCdx (text) {
  const lines = text.split(/\r?\n/).filter(Boolean)
  const captures = []
  for (const line of lines) {
    const parts = line.split(' ')
    if (parts.length < 3) continue
    const timestamp = parts[1]
    let jsonPart
    try {
      jsonPart = JSON.parse(parts.slice(2).join(' '))
    } catch (e) {
      continue
    }
    const tsIso = toISODate(timestamp)
    captures.push({
      url: jsonPart.url,
      ts: tsIso,
      status: jsonPart.status,
      mime: jsonPart.mime,
      digest: jsonPart.digest,
      warcPath: jsonPart.filename ? `archive/${jsonPart.filename}` : undefined,
      offset: jsonPart.offset,
      length: jsonPart.length
    })
  }
  return captures
}

function toISODate (timestamp) {
  if (!timestamp) return ''
  const ts = String(timestamp)
  if (/^\d{17}$/.test(ts)) {
    const year = ts.slice(0, 4)
    const month = ts.slice(4, 6)
    const day = ts.slice(6, 8)
    const hour = ts.slice(8, 10)
    const minute = ts.slice(10, 12)
    const second = ts.slice(12, 14)
    const milli = ts.slice(14, 17)
    return `${year}-${month}-${day}T${hour}:${minute}:${second}.${milli}Z`
  }
  return ts
}

function normalizeDate (input) {
  if (input instanceof Date) return input.getTime()
  return new Date(input).getTime()
}

function parseWarc (buffer) {
  const records = []
  let pos = 0
  while (pos < buffer.length) {
    const headerStart = buffer.indexOf(Buffer.from('WARC/'), pos)
    if (headerStart === -1) break
    const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), headerStart)
    if (headerEnd === -1) break
    const headerText = buffer.slice(headerStart, headerEnd).toString('utf8')
    const headerLines = headerText.split('\r\n')
    const headers = {}
    for (const line of headerLines.slice(1)) {
      const idx = line.indexOf(':')
      if (idx === -1) continue
      const key = line.slice(0, idx).trim()
      const value = line.slice(idx + 1).trim()
      headers[key] = value
    }
    const contentLength = parseInt(headers['Content-Length'] || '0', 10)
    const payloadStart = headerEnd + 4
    const payloadEnd = payloadStart + contentLength
    const payload = buffer.slice(payloadStart, payloadEnd)
    records.push({ headers, payload })
    pos = payloadEnd
    while (buffer[pos] === 0x0d || buffer[pos] === 0x0a) pos++
  }
  return records
}

function parseHttpResponse (payload) {
  const delimiter = payload.indexOf(Buffer.from('\r\n\r\n'))
  if (delimiter === -1) {
    return { status: 0, headers: {}, body: payload }
  }
  const headerText = payload.slice(0, delimiter).toString('utf8')
  const lines = headerText.split('\r\n')
  const statusLine = lines.shift() || ''
  const statusMatch = statusLine.match(/HTTP\/\d\.\d\s+(\d+)/)
  const status = statusMatch ? parseInt(statusMatch[1], 10) : 0
  const headers = {}
  for (const line of lines) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim().toLowerCase()
    const value = line.slice(idx + 1).trim()
    headers[key] = value
  }
  const body = payload.slice(delimiter + 4)
  return { status, headers, body }
}

module.exports = {
  open,
  Archive,
  ArchiveFile,
  Capture,
  ArchivedResponse
}
