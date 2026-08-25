import * as XLSX from 'xlsx';

interface MappingWorkerRequest {
  type: 'parse';
  buffer: ArrayBuffer;
}

interface MappingWorkerSuccess {
  type: 'success';
  mapping: Record<string, string>;
  count: number;
}

interface MappingWorkerFailure {
  type: 'error';
  message: string;
}

self.onmessage = (event: MessageEvent<MappingWorkerRequest>) => {
  if (event.data.type !== 'parse') return;

  try {
    const workbook = XLSX.read(new Uint8Array(event.data.buffer), { type: 'array' });
    const firstSheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[firstSheetName];
    if (!worksheet) throw new Error('文件中没有找到工作表。');

    const rows = XLSX.utils.sheet_to_json(worksheet) as Record<string, unknown>[];
    const mapping: Record<string, string> = {};
    let count = 0;

    for (const row of rows) {
      const firstLeg = String(row['头程单号'] || '').trim();
      const exchange = String(row['快递单号'] || '').trim();
      if (!firstLeg || !exchange) continue;

      mapping[firstLeg] = exchange;
      count += 1;
    }

    if (count === 0) {
      throw new Error('无法从文件中解析出有效的单号映射关系。');
    }

    const result: MappingWorkerSuccess = { type: 'success', mapping, count };
    self.postMessage(result);
  } catch (error) {
    const result: MappingWorkerFailure = {
      type: 'error',
      message: error instanceof Error ? error.message : 'Excel 解析失败。'
    };
    self.postMessage(result);
  }
};
