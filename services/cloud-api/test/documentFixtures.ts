// Minimal real PDF with a catalog, page tree, page, empty content stream and classic xref.
export function documentPdf(comment = '', targetBytes?: number): Buffer {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R >>', '<< /Length 0 >>\nstream\n\nendstream'];
  let text = `%PDF-1.7\n% ${comment}\n`; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(text)); text += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(text);
  text += `xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const buffer = Buffer.from(text);
  if (targetBytes === undefined) return buffer;
  if (targetBytes < buffer.length) throw new Error('PDF target too small');
  // Legal trailing whitespace; byte-for-byte fixture size is intentional for quota tests.
  return Buffer.concat([buffer, Buffer.alloc(targetBytes - buffer.length, 32)]);
}
