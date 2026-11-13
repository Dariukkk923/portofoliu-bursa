/**
 * Importul de extrase .xlsx în browser: cititorul din src/main/xlsx.ts rulat cu Buffer-ul și DEFLATE-ul
 * pentru browser (în loc de cele din Node).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('node:zlib', async (orig) => ({ ...(await orig<typeof import('node:zlib')>()), inflateRawSync: (await import('../src/web/shims/node-zlib')).inflateRawSync }));

import { readXlsx } from '@main/xlsx';
import { WebBuffer } from '../src/web/shims/buffer';
import { buildXlsx } from './xlsxWriter';

describe('xlsx cu piesele pentru browser', () => {
  it('citește foile, textele (cu diacritice și &) și numerele', () => {
    const file = buildXlsx([
      { name: 'Tranzacții', rows: [['Data', 'Simbol', 'Cantitate', 'Preț'], ['2024-03-04', 'TLV.RO', 10, 28.5], [null, 'A&B ț', 'text', 45384.5]] },
      { name: 'Altă foaie', rows: [['x']] }
    ]);
    const sheets = readXlsx(WebBuffer.from(file) as unknown as Buffer);
    expect(sheets.map((s) => s.name)).toEqual(['Tranzacții', 'Altă foaie']);
    expect(sheets[0].rows[1]).toEqual(['2024-03-04', 'TLV.RO', 10, 28.5]);
    expect(sheets[0].rows[2]).toEqual([null, 'A&B ț', 'text', 45384.5]);
  });
});
