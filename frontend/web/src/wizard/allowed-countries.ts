/**
 * §8 W6 "Allowed caller countries", default "workspace country (+US/CA)" (§17 fraud:
 * "allowed inbound country default = workspace country (+US/CA)"). The workspace's own
 * country first, then the two launch countries, each once.
 */
export function defaultAllowedCountries(workspaceCountry: string | null | undefined): string[] {
  const own = workspaceCountry?.trim().toUpperCase();
  const list = own && /^[A-Z]{2}$/.test(own) ? [own, 'US', 'CA'] : ['US', 'CA'];
  return [...new Set(list)];
}
