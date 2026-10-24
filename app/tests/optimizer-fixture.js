import JSZip from 'jszip'

// Use actual browser image decoding, Canvas resizing, and JPEG encoding.
export async function fixture({ corruptImage = false, multipleOpfs = false, collision = false } = {}) {
  const canvas = document.createElement('canvas')
  canvas.width = 1200
  canvas.height = 1800
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#f03060'
  ctx.fillRect(0, 0, 1200, 900)
  // Keep the bottom half transparent to exercise white compositing.
  const png = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
  zip.file('OPS/content.opf', `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="book-id" version="3.0">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Test book</dc:title><dc:creator>Test author</dc:creator><dc:identifier id="book-id">urn:test:book</dc:identifier><meta name="cover" content="cover"/></metadata>
<manifest><item id="cover" href="images/cover.png" media-type="image/png" properties="cover-image"/>
<item id="cover-page" href="text/cover.xhtml" media-type="application/xhtml+xml" properties="svg"/>
<item id="page" href="text/page.xhtml" media-type="application/xhtml+xml" properties="svg"/>
<item id="font" href="fonts/body.ttf" media-type="font/ttf"/>
<item id="css" href="styles/book.css" media-type="text/css"/>
<item id="toc" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest>
<spine toc="toc"><itemref idref="cover-page"/><itemref idref="page"/></spine></package>`)
  zip.file('OPS/images/cover.png', corruptImage ? 'not an image' : png)
  if (collision) zip.file('OPS/images/cover.jpg', png)
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1200 1800"><image width="1200" height="1800" xlink:href="../images/cover.png"/></svg>'
  zip.file('OPS/text/cover.xhtml', `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Cover</title></head><body>${svg}</body></html>`)
  zip.file('OPS/text/page.xhtml', `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter</title><style>@font-face{font-family:Book;src:url('../fonts/body.ttf')}p{color:black}</style></head><body><!-- discard this comment -->${svg}<p>Readable text stays here.</p></body></html>`)
  zip.file('OPS/styles/book.css', "@font-face{font-family:Book;src:url('../fonts/body.ttf')}p{margin:1em}body{background:url('../images/cover.png')}")
  zip.file('OPS/fonts/body.ttf', new Uint8Array([0, 1, 2, 3]))
  zip.file('META-INF/encryption.xml', '<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#"><CipherData><CipherReference URI="OPS/fonts/body.ttf"/></CipherData></EncryptedData></encryption>')
  zip.file('OPS/toc.ncx', '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><head><meta name="dtb:uid" content="wrong-id"/></head><navMap/></ncx>')
  if (multipleOpfs) zip.file('other/content.opf', '<package/>')
  return new File([await zip.generateAsync({ type: 'blob' })], 'Original name.epub', { type: 'application/epub+zip', lastModified: 123456 })
}

export async function inspect(file) {
  const bytes = await file.arrayBuffer()
  const view = new DataView(bytes)
  const firstLength = view.getUint16(26, true)
  const firstEntry = new TextDecoder().decode(new Uint8Array(bytes, 30, firstLength))
  const firstCompression = view.getUint16(8, true)
  const zip = await JSZip.loadAsync(bytes)
  const contents = {}
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue
    contents[path] = path.endsWith('.jpg') ? await entry.async('base64') : await entry.async('string')
  }
  const blob = new Blob([await zip.file('OPS/images/cover.jpg').async('uint8array')], { type: 'image/jpeg' })
  const url = URL.createObjectURL(blob)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = img.width
    canvas.height = img.height
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const color = [...ctx.getImageData(10, 10, 1, 1).data]
    const white = [...ctx.getImageData(10, img.height - 10, 1, 1).data]
    return { contents, width: img.width, height: img.height, color, white, firstEntry, firstCompression }
  } finally {
    URL.revokeObjectURL(url)
  }
}
