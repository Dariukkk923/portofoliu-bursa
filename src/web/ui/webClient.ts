/** Clientul web, la îndemâna componentelor (setat o dată la pornire). */
import type { WebClient } from '../client';

let current: WebClient | null = null;
export const setWebClient = (c: WebClient): void => {
  current = c;
};
export const webClient = (): WebClient => {
  if (!current) throw new Error('Clientul web nu este pornit.');
  return current;
};
