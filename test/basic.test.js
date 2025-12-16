/* eslint-env mocha */
const assert = require('assert')
const path = require('path')
const wacz = require('..')

describe('wacz parser', function () {
  this.timeout(15000)
  const fixture = path.join(__dirname, '..', 'examples', 'iana.wacz')
  let archive

  before(async () => {
    archive = await wacz.open(fixture)
  })

  after(async () => {
    await archive.close()
  })

  it('lists files in the archive', async () => {
    const files = await archive.listFiles()
    const names = files.map(f => f.path)
    assert.ok(names.includes('datapackage.json'), 'datapackage.json missing')
    assert.ok(names.includes('indexes/index.cdx'), 'index.cdx missing')
    assert.ok(names.includes('archive/data.warc.gz'), 'data.warc.gz missing')
    assert.strictEqual(files.length, 5)
  })

  it('reads datapackage.json', async () => {
    const meta = await archive.getJSON('datapackage.json')
    assert.ok(meta.resources, 'expected resources in datapackage.json')
    assert.ok(meta.created, 'expected created timestamp in datapackage.json')
  })

  it('finds captures for iana.org', async () => {
    const captures = await archive.findCaptures('https://www.iana.org/')
    assert.ok(captures.length > 0, 'no captures returned')
    const first = captures[0]
    assert.strictEqual(first.status, 200)
    assert.ok(first.warcPath.endsWith('data.warc.gz'))
  })

  it('opens closest capture and reads response', async () => {
    const cap = await archive.getCapture('https://www.iana.org/', { at: '2025-12-16T08:54:25Z' })
    assert.ok(cap, 'expected capture')
    const resp = await cap.openResponse()
    assert.strictEqual(resp.status, 200)
    const html = await resp.text()
    assert.ok(html.includes('IANA') || html.length > 0, 'expected body content')
  })
})
