/**
 * Jurnalul de investiții: compararea planului (preț țintă, stop-loss, orizont) cu vânzarea reală.
 *
 * Se uită și la prețurile de închidere dintre decizie și vânzare: dacă ținta sau stop-loss-ul au
 * fost atinse înainte de vânzare, utilizatorul vede dacă a acționat cum și-a propus.
 */
import { daysBetween } from '../dates';

export interface PlanInput {
  /** Data deciziei (a intrării din jurnal). */
  date: string;
  targetPrice: number | null;
  stopLoss: number | null;
  horizonMonths: number | null;
}

export interface SaleInput {
  date: string;
  /** Prețul de vânzare pe unitate, în moneda activului. */
  price: number;
}

export type PlanCheckTone = 'ok' | 'warn' | 'info';

export interface PlanCheck {
  tone: PlanCheckTone;
  text: string;
}

export interface PlanComparison {
  checks: PlanCheck[];
  /** True dacă nimic din plan nu a fost încălcat (nicio verificare „warn”). */
  respected: boolean;
  heldDays: number;
  /** Prima zi în care prețul de închidere a atins ținta / a coborât sub stop-loss, înainte de vânzare. */
  targetHitDate: string | null;
  stopHitDate: string | null;
}

const num = (v: number): string => v.toLocaleString('ro-RO', { maximumFractionDigits: 4 });
const day = (iso: string): string => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
const pct = (v: number): string => `${Math.abs(v * 100).toLocaleString('ro-RO', { maximumFractionDigits: 1 })}%`;
const months = (days: number): number => Math.max(0, Math.round(days / 30.44));
const monthsText = (n: number): string => (n === 1 ? '1 lună' : `${n} luni`);

/** Compară planul cu vânzarea, pe baza prețurilor de închidere dintre cele două date. */
export function comparePlan(plan: PlanInput, sale: SaleInput, closes: { date: string; close: number }[], currency = ''): PlanComparison {
  const unit = currency ? ` ${currency}` : '';
  const between = closes.filter((c) => c.date > plan.date && c.date < sale.date).sort((a, b) => (a.date < b.date ? -1 : 1));
  const targetHitDate = plan.targetPrice !== null ? (between.find((c) => c.close >= (plan.targetPrice as number))?.date ?? null) : null;
  const stopHitDate = plan.stopLoss !== null ? (between.find((c) => c.close <= (plan.stopLoss as number))?.date ?? null) : null;
  const heldDays = Math.max(0, daysBetween(plan.date, sale.date));
  const checks: PlanCheck[] = [];

  if (plan.targetPrice !== null) {
    const t = plan.targetPrice;
    if (sale.price >= t) checks.push({ tone: 'ok', text: `Ai vândut la ținta de ${num(t)}${unit} sau peste ea.` });
    else if (targetHitDate) {
      checks.push({ tone: 'warn', text: `Prețul a atins ținta de ${num(t)}${unit} pe ${day(targetHitDate)}, dar ai vândut mai târziu, la ${num(sale.price)}${unit}.` });
    } else checks.push({ tone: 'info', text: `Ai vândut înainte de țintă: la ${num(sale.price)}${unit}, cu ${pct(sale.price / t - 1)} sub ținta de ${num(t)}${unit}.` });
  }

  if (plan.stopLoss !== null) {
    const s = plan.stopLoss;
    if (stopHitDate) {
      checks.push({ tone: 'warn', text: `Prețul a coborât sub stop-loss-ul de ${num(s)}${unit} pe ${day(stopHitDate)}, dar ai vândut abia pe ${day(sale.date)}, la ${num(sale.price)}${unit}.` });
    } else if (sale.price <= s) checks.push({ tone: 'ok', text: `Ai vândut la stop-loss (${num(s)}${unit}), cum ți-ai propus.` });
    else checks.push({ tone: 'ok', text: `Stop-loss-ul de ${num(s)}${unit} nu a fost atins.` });
  }

  if (plan.horizonMonths !== null) {
    const held = months(heldDays);
    if (held >= plan.horizonMonths) checks.push({ tone: 'ok', text: `Ai păstrat poziția ${monthsText(held)}; orizontul planificat era de ${monthsText(plan.horizonMonths)}.` });
    else checks.push({ tone: 'info', text: `Ai vândut după ${monthsText(held)}, înainte de orizontul planificat de ${monthsText(plan.horizonMonths)}.` });
  }

  return { checks, respected: !checks.some((c) => c.tone === 'warn'), heldDays, targetHitDate, stopHitDate };
}

/** Etichetele unei intrări: fără „#”, spații normalizate, unice (fără să conteze literele mari), cel mult 10. */
export function normalizeTags(tags: unknown): string[] {
  const list = Array.isArray(tags) ? tags : typeof tags === 'string' ? tags.split(/[,;]/) : [];
  const out: string[] = [];
  for (const raw of list) {
    const tag = String(raw ?? '')
      .replace(/^#+/, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 30);
    if (tag && !out.some((t) => t.toLowerCase() === tag.toLowerCase())) out.push(tag);
    if (out.length === 10) break;
  }
  return out;
}
