/** A DNS host name usable as the platform's email domain: lowercase labels, at least one dot, <= 253 chars. */
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const DOMAIN_PATTERN = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`);

export function isValidEmailDomain(value: string): boolean {
  return value.length <= 253 && DOMAIN_PATTERN.test(value);
}
