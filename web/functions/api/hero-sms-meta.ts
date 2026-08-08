import { friendlyError, json } from '../_shared/types';

const HERO_SMS_BASE = 'https://hero-sms.com/stubs/handler_api.php';

interface MetaBody {
  api_key?: string;
  country?: number | string;
}

type CountryRow = { id: number; name: string };
type ServiceRow = { code: string; name: string };

function parseCountries(payload: unknown): CountryRow[] {
  if (!payload || typeof payload !== 'object') return [];
  const rows: CountryRow[] = [];
  for (const value of Object.values(payload as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const row = value as Record<string, unknown>;
    const id = Number(row.id ?? row.country);
    const name = String(row.eng || row.rus || row.name || '').trim();
    if (!Number.isInteger(id) || id < 0 || !name) continue;
    rows.push({ id, name });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  return rows;
}

function parseServices(payload: unknown): ServiceRow[] {
  if (!payload || typeof payload !== 'object') return [];
  const root = payload as Record<string, unknown>;
  const list = Array.isArray(root.services)
    ? root.services
    : Array.isArray(payload)
      ? payload
      : [];
  const rows: ServiceRow[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const code = String(row.code || row.service || '').trim();
    const name = String(row.name || row.title || code).trim();
    if (!code) continue;
    rows.push({ code, name });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  return rows;
}

async function heroRequest(
  apiKey: string,
  action: string,
  params: Record<string, string | number> = {},
): Promise<string> {
  const url = new URL(HERO_SMS_BASE);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('action', action);
  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(name, String(value));
  }
  const response = await fetch(url.toString(), { signal: AbortSignal.timeout(30_000) });
  const text = (await response.text()).trim();
  if (!response.ok) throw new Error(`Hero SMS HTTP ${response.status}`);
  if (text === 'BAD_KEY' || text === 'NO_KEY') throw new Error('Hero SMS API Key 无效');
  return text;
}

export const onRequestPost: PagesFunction = async (context) => {
  let body: MetaBody;
  try {
    body = (await context.request.json()) as MetaBody;
  } catch {
    return friendlyError(400, '请求格式无效');
  }

  const apiKey = (body.api_key || '').trim();
  if (!apiKey) return friendlyError(400, '请填写 Hero SMS API Key');

  const countryRaw = body.country;
  const country = countryRaw === undefined || countryRaw === ''
    ? undefined
    : Number(countryRaw);

  try {
    const [countriesText, servicesText] = await Promise.all([
      heroRequest(apiKey, 'getCountries'),
      heroRequest(apiKey, 'getServicesList', {
        lang: 'en',
        ...(Number.isInteger(country) ? { country: country as number } : {}),
      }),
    ]);
    const countries = parseCountries(JSON.parse(countriesText));
    const services = parseServices(JSON.parse(servicesText));
    return json({ ok: true, countries, services });
  } catch (error) {
    const message = error instanceof Error ? error.message : '加载失败';
    return friendlyError(502, message);
  }
};
