import * as XLSX from 'xlsx';

interface MappingWorkerRequest {
  type: 'parse';
  files: Array<{
    name: string;
    buffer: ArrayBuffer;
  }>;
}

interface MappingWorkerSuccess {
  type: 'success';
  mapping: Record<string, string>;
  count: number;
  sourceCount: number;
  skippedFileNames: string[];
}

interface MappingWorkerFailure {
  type: 'error';
  message: string;
}

self.onmessage = (event: MessageEvent<MappingWorkerRequest>) => {
  if (event.data.type !== 'parse') return;

  try {
    const mapping: Record<string, string> = {};
    const skippedFileNames: string[] = [];
    let sourceCount = 0;

    for (const file of event.data.files) {
      try {
        const workbook = XLSX.read(new Uint8Array(file.buffer), { type: 'array' });
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        if (!worksheet) throw new Error('文件中没有找到工作表。');

        const fileMapping: Record<string, string> = {};
        for (const row of XLSX.utils.sheet_to_json(worksheet) as Record<string, unknown>[]) {
          const firstLeg = String(row['头程单号'] || '').trim();
          const exchange = String(row['快递单号'] || '').trim();
          if (!firstLeg || !exchange) continue;
          fileMapping[firstLeg] = exchange;
        }

        if (Object.keys(fileMapping).length === 0) throw new Error('未找到有效的单号映射关系。');
        Object.assign(mapping, fileMapping);
        sourceCount += 1;
      } catch {
        skippedFileNames.push(file.name);
      }
    }

    const count = Object.keys(mapping).length;
    if (count === 0) {
      throw new Error('无法从文件中解析出有效的单号映射关系。');
    }

    const result: MappingWorkerSuccess = { type: 'success', mapping, count, sourceCount, skippedFileNames };
    self.postMessage(result);
  } catch (error) {
    const result: MappingWorkerFailure = {
      type: 'error',
      message: error instanceof Error ? error.message : 'Excel 解析失败。'
    };
    self.postMessage(result);
  }
};
