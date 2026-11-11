/** Instrumentele propuse în simulator (formatul Yahoo). ETF-urile plătesc dividende, deci se pot reinvesti. */
import type { AssetType } from './types';

export interface SimPreset {
  symbol: string;
  name: string;
  type: AssetType;
}

export const SIM_PRESETS: SimPreset[] = [
  { symbol: 'SPY', name: 'S&P 500 (ETF SPY)', type: 'etf' },
  { symbol: 'QQQ', name: 'Nasdaq 100 (ETF QQQ)', type: 'etf' },
  { symbol: 'VWCE.DE', name: 'Acțiuni din toată lumea (ETF VWCE)', type: 'etf' },
  { symbol: 'URTH', name: 'MSCI World (ETF URTH)', type: 'etf' },
  { symbol: 'TVBETETF.RO', name: 'BET – Bursa de Valori București (ETF TVBETETF)', type: 'etf' },
  { symbol: '^GSPC', name: 'Indicele S&P 500 (fără dividende)', type: 'etf' }
];

export const simPresetName = (symbol: string): string | null => SIM_PRESETS.find((p) => p.symbol === symbol.toUpperCase())?.name ?? null;

/** Tipul folosit la cererea datelor: presetul, altfel acțiune (indicii încep cu „^”). */
export const simInstrumentType = (symbol: string): AssetType => SIM_PRESETS.find((p) => p.symbol === symbol.toUpperCase())?.type ?? (symbol.startsWith('^') ? 'etf' : 'stock');
