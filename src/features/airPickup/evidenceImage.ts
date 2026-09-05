export type NormalizedEvidenceImage = {
  file: File;
  width: number;
  height: number;
  warnings: string[];
};

function canvasBlob(canvas: HTMLCanvasElement, type: 'image/jpeg' | 'image/png'): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('图片转换失败')), type, type === 'image/jpeg' ? 0.9 : undefined);
  });
}

function cleanFilename(name: string, type: 'image/jpeg' | 'image/png'): string {
  const base = name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9._-]+/g, '-') || 'evidence';
  return `${base}.${type === 'image/png' ? 'png' : 'jpg'}`;
}

export async function normalizeEvidenceImage(file: File): Promise<NormalizedEvidenceImage> {
  if (file.size > 10 * 1024 * 1024) throw new Error(`${file.name} 超过 10MB`);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(`${file.name} 不是浏览器可识别的 JPG、PNG 或 HEIC 图片`);
  }
  try {
    if (bitmap.width < 800 || bitmap.height < 600) throw new Error(`${file.name} 分辨率低于 800×600`);
    const maximumEdge = 4096;
    const scale = Math.min(1, maximumEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('浏览器无法处理图片');
    context.drawImage(bitmap, 0, 0, width, height);

    const sampleWidth = Math.min(width, 320);
    const sampleHeight = Math.min(height, 240);
    const sample = document.createElement('canvas');
    sample.width = sampleWidth;
    sample.height = sampleHeight;
    const sampleContext = sample.getContext('2d', { willReadFrequently: true });
    if (!sampleContext) throw new Error('浏览器无法检查图片清晰度');
    sampleContext.drawImage(canvas, 0, 0, sampleWidth, sampleHeight);
    const pixels = sampleContext.getImageData(0, 0, sampleWidth, sampleHeight).data;
    let sum = 0;
    let sumSquares = 0;
    let edge = 0;
    let previous = 0;
    const count = sampleWidth * sampleHeight;
    for (let index = 0; index < pixels.length; index += 4) {
      const luminance = pixels[index] * 0.2126 + pixels[index + 1] * 0.7152 + pixels[index + 2] * 0.0722;
      sum += luminance;
      sumSquares += luminance * luminance;
      if (index > 0) edge += Math.abs(luminance - previous);
      previous = luminance;
    }
    const average = sum / count;
    const variance = Math.max(0, sumSquares / count - average * average);
    const averageEdge = edge / Math.max(1, count - 1);
    if (average < 4 || variance < 1.5) throw new Error(`${file.name} 疑似全黑或空白图片，不能上传`);
    const warnings: string[] = [];
    if (average < 42) warnings.push('图片整体偏暗');
    if (average > 218) warnings.push('图片整体偏亮');
    if (averageEdge < 5.2) warnings.push('图片可能模糊');

    const outputType: 'image/jpeg' | 'image/png' = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    const blob = await canvasBlob(canvas, outputType);
    if (blob.size > 10 * 1024 * 1024) throw new Error(`${file.name} 转换后仍超过 10MB`);
    return {
      file: new File([blob], cleanFilename(file.name, outputType), { type: outputType, lastModified: Date.now() }),
      width,
      height,
      warnings,
    };
  } finally {
    bitmap.close();
  }
}
