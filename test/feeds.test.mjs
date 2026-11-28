import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ambiguousName,
  classify,
  discoverFeeds,
  looksLikeFeed,
  parseFeed,
  parseGdelt,
  parseSteamNews,
  plainText,
  pressMatcher,
  safeUrl
} from '../src/feeds.mjs';

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel><title>3DJuegos</title>
<item>
  <title><![CDATA[Hollow Knight: Silksong recibe su primer parche &amp; más]]></title>
  <link>https://www.3djuegos.com/noticias/silksong-parche</link>
  <guid isPermaLink="false">abc-1</guid>
  <pubDate>Sat, 28 Nov 2026 10:30:31 +0100</pubDate>
  <description><![CDATA[<p><img src="https://img.3djuegos.com/silksong.jpg" alt=""></p><p>Team Cherry corrige errores.</p><script>alert(1)</script>]]></description>
</item>
<item>
  <title>Sin fecha</title>
  <link>https://www.3djuegos.com/sin-fecha</link>
</item>
<item>
  <title>Enlace peligroso</title>
  <link>javascript:alert(1)</link>
  <pubDate>Sat, 28 Nov 2026 10:30:31 +0100</pubDate>
</item>
</channel></rss>`;

const ATOM_YOUTUBE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
 <entry>
  <id>yt:video:XYZ</id>
  <title>Trailer de la temporada 3</title>
  <link rel="alternate" href="https://www.youtube.com/watch?v=XYZ"/>
  <published>2026-11-20T15:00:00+00:00</published>
  <media:group>
   <media:thumbnail url="https://i2.ytimg.com/vi/XYZ/hqdefault.jpg" width="480" height="360"/>
   <media:description>La temporada nueva llega el 4 de diciembre.</media:description>
  </media:group>
 </entry>
</feed>`;

const RSS_BLUESKY = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>@teamcherry.bsky.social</title>
<item><link>https://bsky.app/profile/teamcherry.bsky.social/post/3abc</link>
<description>Patch 1.0.2 is now live on all platforms! Thanks for the reports.</description>
<pubDate>27 Nov 2026 18:00 +0000</pubDate><guid isPermaLink="false">at://did:plc:x/app.bsky.feed.post/3abc</guid></item>
</channel></rss>`;

test('parseFeed lee RSS: título, enlace, fecha, texto limpio e imagen; descarta lo incompleto o inseguro', () => {
  const items = parseFeed(RSS, 'https://www.3djuegos.com/');
  assert.equal(items.length, 1);
  assert.deepEqual(items[0], {
    id: 'abc-1',
    title: 'Hollow Knight: Silksong recibe su primer parche & más',
    url: 'https://www.3djuegos.com/noticias/silksong-parche',
    date: '2026-11-28T09:30:31.000Z',
    text: 'Team Cherry corrige errores.',
    image: 'https://img.3djuegos.com/silksong.jpg'
  });
});

test('parseFeed lee Atom de YouTube y RSS de Bluesky (sin título: usa el comienzo del texto)', () => {
  const [video] = parseFeed(ATOM_YOUTUBE);
  assert.equal(video.title, 'Trailer de la temporada 3');
  assert.equal(video.url, 'https://www.youtube.com/watch?v=XYZ');
  assert.equal(video.image, 'https://i2.ytimg.com/vi/XYZ/hqdefault.jpg');
  assert.equal(video.text, 'La temporada nueva llega el 4 de diciembre.');
  const [post] = parseFeed(RSS_BLUESKY);
  assert.equal(post.title, 'Patch 1.0.2 is now live on all platforms! Thanks for the reports.');
  assert.equal(post.date, '2026-11-27T18:00:00.000Z');
});

test('plainText quita etiquetas, BBCode de Steam y enlaces, y no deja pasar HTML escapado', () => {
  assert.equal(
    plainText('[h1]Notas[/h1][img]{STEAM_CLAN_IMAGE}/1/a.png[/img][list][*]Arreglos[/list]'),
    'Notas Arreglos'
  );
  assert.equal(plainText('&lt;b&gt;hola&lt;/b&gt; mundo'), 'hola mundo');
  assert.equal(plainText('a '.repeat(400), 20).endsWith('…'), true);
});

test('safeUrl acepta sólo http y https', () => {
  assert.equal(safeUrl('/noticia', 'https://vandal.elespanol.com/'), 'https://vandal.elespanol.com/noticia');
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl('file:///C:/Windows'), null);
});

test('discoverFeeds encuentra el feed que declara una página, sin los de comentarios', () => {
  const html = `<head>
    <link rel="alternate" type="application/rss+xml" title="Comentarios" href="/comments/feed/">
    <link rel="alternate" type="application/rss+xml" href="/feed/">
    <link rel="alternate" type="application/atom+xml" href="https://otro.example/atom.xml">
    <link rel="stylesheet" href="/estilo.css"></head>`;
  assert.deepEqual(discoverFeeds(html, 'https://estudio.example/'), [
    'https://estudio.example/feed/',
    'https://otro.example/atom.xml'
  ]);
  assert.equal(looksLikeFeed(RSS), true);
  assert.equal(looksLikeFeed('<!doctype html><html>'), false);
});

test('parseSteamNews se queda con los anuncios del juego y arma la imagen de Steam', () => {
  const items = parseSteamNews({
    appnews: {
      newsitems: [
        {
          gid: '111',
          title: 'Update 1.4 is live',
          url: 'https://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/111',
          contents: '[img]{STEAM_CLAN_IMAGE}/3381/abc.png[/img] Fixes and [b]improvements[/b].',
          feedname: 'steam_community_announcements',
          feed_type: 1,
          date: 1764000000,
          tags: ['patchnotes']
        },
        { gid: '222', title: 'PC Gamer review', url: 'https://pcgamer.com/x', feed_type: 0, date: 1764000000 }
      ]
    }
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'steam:111');
  assert.equal(items[0].image, 'https://clan.akamai.steamstatic.com/images/3381/abc.png');
  assert.equal(items[0].text, 'Fixes and improvements .');
  assert.deepEqual(items[0].tags, ['patchnotes']);
});

test('classify reconoce actualizaciones, contenido, eventos, ofertas y anuncios', () => {
  assert.equal(classify({ title: 'Hotfix 1.0.3' }), 'update');
  assert.equal(classify({ title: 'Notes', tags: ['patchnotes'] }), 'update');
  assert.equal(classify({ title: 'Ya disponible la actualización de invierno' }), 'update');
  assert.equal(classify({ title: 'Nueva expansión: Las Mareas' }), 'content');
  assert.equal(classify({ title: 'Free weekend starts now' }), 'event');
  assert.equal(classify({ title: '50% off during the Autumn Sale, patch included' }), 'offer');
  assert.equal(classify({ title: 'Release date revealed' }), 'announcement');
  assert.equal(classify({ title: 'Lo que sea' }, 'press'), 'press');
  assert.equal(classify({ title: 'Lo que sea' }, 'local'), 'update');
  assert.equal(classify({ title: 'Patch 1.2 is out' }, 'community'), 'community');
});

test('pressMatcher pide el nombre del juego y, si es ambiguo, también el estudio', () => {
  assert.equal(ambiguousName('Control'), true);
  assert.equal(ambiguousName('Hollow Knight'), false);
  const silksong = pressMatcher({ names: ['Hollow Knight: Silksong', 'Silksong'], studios: ['Team Cherry'] });
  assert.equal(silksong({ title: 'Hollow Knight Silksong recibe un parche' }), true);
  assert.equal(silksong({ title: 'Silksong ya tiene fecha', text: 'El juego de Team Cherry…' }), true);
  assert.equal(silksong({ title: 'Silksong ya tiene fecha', text: 'Un juego esperado' }), false);
  const control = pressMatcher({ names: ['Control'], studios: ['Remedy Entertainment', 'Remedy'] });
  assert.equal(control({ title: 'Cómo tomar el control de tu PC' }), false);
  assert.equal(control({ title: 'Control 2 se deja ver', text: 'Remedy mostró el primer avance' }), true);
  // Sin estudio conocido, un nombre ambiguo nunca coincide.
  assert.equal(pressMatcher({ names: ['Prey'] })({ title: 'Prey vuelve' }), false);
  // Palabras completas: «Anno 1800» no coincide con «Anno 18000».
  assert.equal(pressMatcher({ names: ['Anno 1800'] })({ title: 'Anno 18000 es mentira' }), false);
});

test('parseGdelt lee los artículos del buscador abierto con su fecha, imagen y medio', () => {
  const items = parseGdelt({
    articles: [
      {
        url: 'https://www.diario.example/nota',
        title: 'Hollow Knight &amp; Silksong',
        seendate: '20261128T153000Z',
        domain: 'www.diario.example',
        socialimage: 'http://inseguro.example/x.jpg'
      },
      { url: 'javascript:alert(1)', title: 'Mala', seendate: '20261128T153000Z' },
      { url: 'https://sin-fecha.example', title: 'Sin fecha' }
    ]
  });
  assert.deepEqual(items, [
    {
      id: 'https://www.diario.example/nota',
      title: 'Hollow Knight & Silksong',
      url: 'https://www.diario.example/nota',
      date: '2026-11-28T15:30:00.000Z',
      text: '',
      image: null,
      source: 'diario.example'
    }
  ]);
  assert.deepEqual(parseGdelt({}), []);
});
