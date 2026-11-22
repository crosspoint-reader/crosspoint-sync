import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { epubSpineTexts, epubTextOffset, epubXPathAt } from '../src/connectors/bookfusion-epub.js';

function archive(files: Record<string, string>): Buffer {
  const local: Buffer[] = [], directory: Buffer[] = [];
  let offset = 0;
  for (const [path, source] of Object.entries(files)) {
    const name = Buffer.from(path), data = Buffer.from(source);
    const header = Buffer.alloc(30), central = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    local.push(header, name, data); directory.push(central, name);
    offset += header.length + name.length + data.length;
  }
  const end = Buffer.alloc(22), entries = Object.keys(files).length;
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries, 8); end.writeUInt16LE(entries, 10);
  end.writeUInt32LE(Buffer.concat(directory).length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...directory, end]);
}

function epub(): Buffer {
  return archive({
    'META-INF/container.xml': '<container><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    'EPUB/package.opf': '<package><metadata/><manifest><item id="a" href="../Text/ch1.xhtml"/><item id="b" href="../Text/ch2.xhtml"/></manifest><guide/><spine><itemref idref="a"/><itemref idref="b"/></spine></package>',
    'Text/ch1.xhtml': '<html><head><title>ignored</title></head><body><p>First</p></body></html>',
    'Text/ch2.xhtml': '<html xmlns="http://www.w3.org/1999/xhtml"><head/><extra/><body><h1>Title</h1><p>Pre😀<em>bold</em> tail&amp;end</p></body></html>',
  });
}

describe('epubTextOffset', () => {
  it('maps an element with no text of its own to the next text in the chapter', async () => {
    const book = archive({
      'META-INF/container.xml': '<container><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      'EPUB/package.opf': '<package><metadata/><manifest><item id="a" href="../Text/ch1.xhtml"/></manifest><guide/><spine><itemref idref="a"/></spine></package>',
      'Text/ch1.xhtml': '<html><head/><body><p>First</p><div class="sep"/><p>Second</p></body></html>',
    });
    // "First Second": the separator sits at offset 5, the text after it at 6.
    expect(await epubTextOffset(book, '/body/DocFragment[1]/body/div')).toEqual({ spine: 0, offset: 6 });
  });
});

describe('epubSpineTexts', () => {
  it('concatenates visible text per spine item, skipping head content', async () => {
    expect(await epubSpineTexts(epub())).toEqual(['First', 'Title Pre😀 bold tail&end']);
  });
});

describe('epub text offsets', () => {
  it('counts codepoints into the spine text for a device XPath', async () => {
    // text() index counts text-node children only, skipping the nested <em>.
    // 'Title Pre😀 bold' is 15 codepoints, then 5 into ' tail&end'.
    expect(await epubTextOffset(epub(), '/body/DocFragment[2]/body/p[1]/text()[2].5'))
      .toEqual({ spine: 1, offset: 20 });
  });

  it('round-trips every offset in a spine through an XPath', async () => {
    const texts = await epubSpineTexts(epub());
    for (const [spine, text] of texts.entries()) {
      const length = Array.from(text).length;
      for (let offset = 0; offset < length; offset++) {
        const back = (await epubTextOffset(epub(), await epubXPathAt(epub(), spine, offset))).offset;
        // A word-separating space this module inserts has no text node of its own,
        // so it resolves to the next real character.
        expect(back - offset).toBeGreaterThanOrEqual(0);
        expect(back - offset).toBeLessThanOrEqual(1);
      }
    }
  });

  it('clamps an offset past the end of the chapter to its last text', async () => {
    const [, second] = await epubSpineTexts(epub());
    const xpath = await epubXPathAt(epub(), 1, 1_000);
    expect(xpath).toBe('/body/DocFragment[2]/body/p[1]/text()[2].9');
    expect((await epubTextOffset(epub(), xpath)).offset).toBe(Array.from(second).length);
  });
});
