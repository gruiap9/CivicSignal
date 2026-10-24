import type { CityScenario } from '../scenario';
import { KENDALL } from './kendall';
import { PORTLAND } from './portland';

export const CITIES: CityScenario[] = [KENDALL, PORTLAND];
export const DEFAULT_CITY = KENDALL.id;

export function cityById(id: string): CityScenario {
  return CITIES.find((c) => c.id === id) ?? KENDALL;
}
