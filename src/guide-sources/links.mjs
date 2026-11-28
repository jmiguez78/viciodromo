// Enlaces directos a sitios de guías para cada juego (Fase 1): Viciódromo no copia contenido con derechos
// reservados; arma los enlaces por nombre o identificador de Steam para abrirlos en el visor auxiliar o navegador.

export function safeGuideUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.href : null;
  } catch {
    return null;
  }
}

export function steamAppIdFor(game) {
  if (!game) return null;
  if (game.platform === 'Steam' && /^\d+$/.test(String(game.id ?? ''))) return String(game.id);
  for (const site of game.meta?.websites ?? []) {
    const url = safeGuideUrl(site?.url);
    if (!url) continue;
    const parsed = new URL(url);
    const match = /(^|\.)steampowered\.com$/.test(parsed.hostname) && /^\/app\/(\d+)/.exec(parsed.pathname);
    if (match) return match[1];
  }
  return null;
}

export function guideLinksFor(game) {
  const name = String(game?.name ?? '').trim();
  if (!name) return [];
  const encoded = encodeURIComponent(name);
  const appid = steamAppIdFor(game);
  const links = [
    {
      id: 'gamefaqs',
      label: 'GameFAQs',
      description: 'El catálogo más grande de guías y preguntas frecuentes.',
      url: `https://gamefaqs.gamespot.com/search?game=${encoded}`,
      kind: 'link'
    }
  ];
  if (appid) {
    links.push({
      id: 'steam',
      label: 'Guías de Steam',
      description: 'Guías escritas por la comunidad de Steam para este juego.',
      url: `https://steamcommunity.com/app/${appid}/guides/`,
      kind: 'link'
    });
  }
  links.push(
    {
      id: 'strategywiki',
      label: 'StrategyWiki',
      description: 'Guías colaborativas con licencia libre (CC BY-SA).',
      url: `https://strategywiki.org/w/index.php?search=${encoded}`,
      kind: 'link'
    },
    {
      id: 'youtube',
      label: 'YouTube',
      description: 'Videos y recorridos paso a paso para puzzles visuales.',
      url: `https://www.youtube.com/results?search_query=${encodeURIComponent(`${name} walkthrough guia`)}`,
      kind: 'link'
    },
    {
      id: 'ign',
      label: 'IGN',
      description: 'Guías paso a paso, jefes y coleccionables.',
      url: `https://www.ign.com/search?q=${encodeURIComponent(`${name} guide`)}`,
      kind: 'link'
    }
  );
  return links;
}
