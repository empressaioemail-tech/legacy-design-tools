export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c = (CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function writeUint32LE(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value, true);
}

function writeUint16LE(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}

/** STORE-method ZIP (no compression) for browser download. */
export function zipStore(files: ReadonlyArray<ZipEntry>): Uint8Array {
  const DOS_TIME = 0;
  const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

  const chunks: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = new TextEncoder().encode(file.name);
    const checksum = crc32(file.data);
    const size = file.data.length;

    const local = new Uint8Array(30);
    const localView = new DataView(local.buffer);
    writeUint32LE(localView, 0, 0x04034b50);
    writeUint16LE(localView, 4, 20);
    writeUint16LE(localView, 6, 0);
    writeUint16LE(localView, 8, 0);
    writeUint16LE(localView, 10, DOS_TIME);
    writeUint16LE(localView, 12, DOS_DATE);
    writeUint32LE(localView, 14, checksum);
    writeUint32LE(localView, 18, size);
    writeUint32LE(localView, 22, size);
    writeUint16LE(localView, 26, nameBytes.length);
    writeUint16LE(localView, 28, 0);
    chunks.push(local, nameBytes, file.data);

    const central = new Uint8Array(46);
    const centralView = new DataView(central.buffer);
    writeUint32LE(centralView, 0, 0x02014b50);
    writeUint16LE(centralView, 4, 20);
    writeUint16LE(centralView, 6, 20);
    writeUint16LE(centralView, 8, 0);
    writeUint16LE(centralView, 10, 0);
    writeUint16LE(centralView, 12, DOS_TIME);
    writeUint16LE(centralView, 14, DOS_DATE);
    writeUint32LE(centralView, 16, checksum);
    writeUint32LE(centralView, 20, size);
    writeUint32LE(centralView, 24, size);
    writeUint16LE(centralView, 28, nameBytes.length);
    writeUint16LE(centralView, 30, 0);
    writeUint16LE(centralView, 32, 0);
    writeUint16LE(centralView, 34, 0);
    writeUint16LE(centralView, 36, 0);
    writeUint32LE(centralView, 38, 0);
    writeUint32LE(centralView, 42, offset);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + file.data.length;
  }

  const centralSize = centrals.reduce((sum, c) => sum + c.length, 0);
  const centralBuf = concatUint8(centrals);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  writeUint32LE(eocdView, 0, 0x06054b50);
  writeUint16LE(eocdView, 4, 0);
  writeUint16LE(eocdView, 6, 0);
  writeUint16LE(eocdView, 8, files.length);
  writeUint16LE(eocdView, 10, files.length);
  writeUint32LE(eocdView, 12, centralSize);
  writeUint32LE(eocdView, 16, offset);
  writeUint16LE(eocdView, 20, 0);

  return concatUint8([...chunks, centralBuf, eocd]);
}

function concatUint8(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function downloadZipBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
