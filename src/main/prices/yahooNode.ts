/** Clientul Yahoo de pe desktop: pachetul yahoo-finance2 (nu intră în varianta web). */
import YahooFinance from 'yahoo-finance2';

export function createNodeYahooClient(): unknown {
  const Ctor = ((YahooFinance as unknown as { default?: unknown }).default ?? YahooFinance) as new (opts: object) => unknown;
  return new Ctor({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });
}
