/** Etichetele și regulile simple ale raportului fiscal (fără calculul impozitului de plată). */
import type { BrokerResidence, FxSource } from './types';

export const TAX_DISCLAIMER = 'Raport informativ pentru Declarația Unică. Verifică regulile fiscale în vigoare sau consultă un contabil.';

export const RESIDENCE_LABEL: Record<BrokerResidence, string> = {
  ro: 'Broker din România',
  foreign: 'Broker străin'
};

export const RESIDENCE_SECTION_LABEL: Record<BrokerResidence, string> = {
  ro: 'Brokeri din România',
  foreign: 'Brokeri străini'
};

export const RESIDENCE_HINT: Record<BrokerResidence, string> = {
  ro: 'De obicei brokerul reține impozitul la sursă.',
  foreign: 'Veniturile se declară de obicei în Declarația Unică.'
};

export const FX_SOURCE_LABEL: Record<FxSource, string> = {
  ron: 'în lei',
  bnr: 'curs BNR',
  app: 'curs din aplicație',
  current: 'curs de azi (aproximativ)'
};

/** Brokerii cunoscuți cu sediul în România (după nume); restul se consideră străini. Se poate schimba din pagina Brokeri. */
const RO_BROKERS = /tradeville|bt capital|bt trade|\bbcr\b|goldring|investimental|prime transaction|swiss capital|estinvest|intercapital|\bssif\b|fidelis/i;

export function guessResidence(name: string): BrokerResidence {
  return RO_BROKERS.test(name) ? 'ro' : 'foreign';
}
