export function rootDomainSuffixes(domains = []) {
  const normalized = [...new Set(domains.map(domain => domain.trim().replace(/^@/, '').toLowerCase()).filter(Boolean))];
  return normalized
    .filter(domain => !normalized.some(root => root !== domain && domain.endsWith(`.${root}`)))
    .map(domain => `@${domain}`);
}

export function completeEmail(email, suffix = '') {
  const value = email.trim();
  return value.includes('@') ? value : value + suffix;
}

export function completeLoginEmail(email, suffix = '', subdomain = '') {
  const value = email.trim();
  if (value.includes('@') || !subdomain) return completeEmail(value, suffix);
  return `${value}@${normalizeSubdomain(subdomain.trim())}.${suffix.replace(/^@/, '')}`;
}

export function normalizeSubdomain(value) {
  return value.toLowerCase();
}

export function subdomainRequest(mode, subdomain) {
  return {subdomainMode: mode === 'normal' ? 'normal' : 'manual', subdomain: normalizeSubdomain(subdomain)};
}

export function validSubdomain(value) {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(normalizeSubdomain(value));
}
