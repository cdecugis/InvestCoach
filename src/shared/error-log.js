const sensitive = /authorization|token|api[_-]?key|secret|password|credential|cookie|headers|request|config|environment/i;

/** Nettoyage commun aux logs : jamais de requête, headers ou credentials bruts. */
export function redactLogText(value) {
  let text = String(value);
  for (const [name, secret] of Object.entries(process.env)) {
    if (sensitive.test(name) && secret && secret.length >= 4) text = text.split(secret).join('[REDACTED]');
  }
  return text
    .replace(/\bsb_(?:secret|publishable)_[\w-]+/gi, '[REDACTED]')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[REDACTED]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;"']+/gi, '[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/(["']?(?:authorization|[\w-]*(?:token|secret|password|credential|api[_-]?key|cookie)[\w-]*)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&}]+)/gi, '$1[REDACTED]')
    .slice(0, 16000);
}

export function safeLogValue(value, seen = new WeakSet(), depth = 0) {
  if (typeof value === 'string') return redactLogText(value);
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value !== 'object') return redactLogText(String(value));
  if (seen.has(value)) return '[Circular]';
  if (depth >= 6) return '[Truncated]';
  seen.add(value);
  const output = Array.isArray(value) ? [] : {};
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (value instanceof Error) output.name = redactLogText(value.name);
  for (const [key, descriptor] of Object.entries(descriptors).slice(0, 100)) {
    if (sensitive.test(key)) continue;
    // Ne pas exécuter les getters d'un objet d'erreur externe.
    if ('value' in descriptor) output[redactLogText(key)] = safeLogValue(descriptor.value, seen, depth + 1);
  }
  return output;
}

export function errorLogEntry(event, error) {
  try {
    const entry = { event };
    for (const key of ['name', 'message', 'stack', 'cause', 'code', 'details', 'hint']) {
      entry[key] = safeLogValue(error?.[key]);
    }
    if (!(error instanceof Error)) entry.value = safeLogValue(error);
    return entry;
  } catch {
    return { event, message: 'Exception non sérialisable ; détails indisponibles.' };
  }
}
