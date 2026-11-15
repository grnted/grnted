// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Language of parts (3.1.2) in real Chromium: a passage in another language than the one it is marked as
// (H58 not applied), and the look-alikes WCAG exempts or the test must not judge. Every page here is
// written for this test.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LANGUAGE_PARTS_LIMITS, LANGUAGE_SCRIPTS, LANGUAGE_SCRIPT_PROOF, LANGUAGE_SENTENCE_FORMS, LANGUAGE_SENTENCE_WEAK, LANGUAGE_SENTENCE_WORDS, LANGUAGE_WORDS, languagePartFindings, languagePartsProbe, readLanguageParts, type LanguagePartsRead } from '../../src/probes/languageParts.js';
import { PROBES } from '../../src/probes/registry.js';

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
});

const ARG = {
  limits: { ...LANGUAGE_PARTS_LIMITS }, words: { ...LANGUAGE_WORDS }, sentence: { ...LANGUAGE_SENTENCE_WORDS }, weak: { ...LANGUAGE_SENTENCE_WEAK }, forms: { ...LANGUAGE_SENTENCE_FORMS },
  scripts: LANGUAGE_SCRIPTS.map((s) => ({ ...s })), proof: Object.fromEntries(Object.entries(LANGUAGE_SCRIPT_PROOF).map(([k, v]) => [k, { ...v }])),
};

async function readOn(body: string, lang = 'en'): Promise<LanguagePartsRead> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.setContent(`<!doctype html><html${lang === 'none' ? '' : ` lang="${lang}"`}><head><title>T</title></head><body>${body}</body></html>`);
    return await page.evaluate(readLanguageParts, ARG);
  } finally {
    await page.close();
  }
}
const statuses = async (body: string, lang?: string) => languagePartFindings(await readOn(body, lang)).map((f) => f.status);

const ENGLISH = '<h1>Winter parking rules</h1><p>When snow is forecast, move your car off the marked routes before the plows arrive so that crews can clear the whole street.</p><p>You will find the list of routes on the map, and you can sign up for a text message when a snow emergency is declared.</p>';
const SPANISH = 'Cuando se anuncie nieve, mueva su vehículo de las rutas marcadas antes de que lleguen las máquinas, para que los equipos puedan limpiar toda la calle.';
const FRENCH = 'Lorsque la neige est annoncée, déplacez votre voiture des rues indiquées avant le passage des équipes, pour que toute la rue soit dégagée.';
const VIETNAMESE = 'Khi có dự báo tuyết, xin dời xe của bạn khỏi các tuyến đường đã được đánh dấu để các đội có thể dọn sạch đường phố cho mọi người.';

describe('language of parts (3.1.2): a passage in another language with no lang of its own (H58)', () => {
  it('fails a full passage in Spanish, French or Vietnamese inside content marked English', async () => {
    for (const [text, name] of [[SPANISH, 'Spanish'], [FRENCH, 'French'], [VIETNAMESE, 'Vietnamese']] as const) {
      const f = languagePartFindings(await readOn(`${ENGLISH}<p id="other">${text}</p>`));
      expect(f.map((x) => [x.criterion, x.status, x.target]), name).toEqual([['3.1.2', 'failed', '#other']]);
      expect(f[0]!.detail, name).toContain(`A passage in ${name} is inside content marked as English (lang="en")`);
    }
  });

  it('fails a passage in another script: Chinese, Arabic or Russian text in content marked English', async () => {
    const zh = '下雪时，请在铲雪车到达之前把您的车辆从标明的路线上移开，以便工作人员清理整条街道。';
    const ar = 'عند توقع تساقط الثلوج، يرجى نقل سيارتك من الطرق المحددة قبل وصول الجرافات حتى تتمكن الفرق من تنظيف الشارع.';
    const ru = 'Когда ожидается снег, уберите машину с отмеченных улиц до прихода техники, чтобы бригады могли расчистить всю улицу.';
    for (const [text, name] of [[zh, 'Chinese characters'], [ar, 'Arabic script'], [ru, 'Cyrillic script']] as const) {
      const f = languagePartFindings(await readOn(`${ENGLISH}<p id="other">${text}</p>`));
      expect(f.map((x) => [x.status, x.target]), name).toEqual([['failed', '#other']]);
      expect(f[0]!.detail, name).toContain(`A passage in ${name} is inside content marked as English`);
    }
  });

  it('fails an English passage in content marked Spanish, and inside a part marked Spanish on an English page', async () => {
    const english = 'When snow is forecast, move your car off the marked routes before the plows arrive so that crews can clear the whole street.';
    expect(await statuses(`<p>${SPANISH}</p><p>${SPANISH.replace('nieve', 'hielo')}</p><p id="other">${english}</p>`, 'es')).toEqual(['failed']);
    const f = languagePartFindings(await readOn(`${ENGLISH}<section lang="es"><p>${SPANISH}</p><p id="wrong">${english}</p></section>`));
    expect(f.map((x) => [x.status, x.target])).toEqual([['failed', '#wrong']]);
    expect(f[0]!.detail).toContain('marked as Spanish (lang="es")');
  });

  it('reads text in open shadow roots, and counts a repeated passage once', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<!doctype html><html lang="en"><body>${ENGLISH}<div id="host"></div><p>${SPANISH}</p><p>${SPANISH}</p></body></html>`);
      await page.evaluate((t) => { document.getElementById('host')!.attachShadow({ mode: 'open' }).innerHTML = `<p>${t}</p>`; }, FRENCH);
      const read = await page.evaluate(readLanguageParts, ARG);
      expect(read.passages.map((p) => p.reads).sort()).toEqual(['es', 'fr']);
      expect(read.passages.find((p) => p.reads === 'fr')!.target).toBe('#host >>> p');
    } finally {
      await page.close();
    }
  });
});

describe('language of parts (3.1.2): what must stay clean', () => {
  it('a passage marked with its own language, on itself or on a wrapper', async () => {
    expect(await statuses(`${ENGLISH}<p lang="es">${SPANISH}</p>`)).toEqual([]);
    expect(await statuses(`${ENGLISH}<div lang="es-MX"><p>${SPANISH}</p></div>`)).toEqual([]);
    // Marked inline: the Spanish words are a passage of their own, in Spanish.
    expect(await statuses(`${ENGLISH}<p>The notice reads: <span lang="es">${SPANISH}</span></p>`)).toEqual([]);
  });

  it('proper names, short phrases and borrowed words (the exceptions of 3.1.2)', async () => {
    // A run of names in another language.
    expect(await statuses(`${ENGLISH}<p>Our partners this year: Casa de la Raza, Centro de la Familia, El Pueblo de Los Angeles, La Clínica del Pueblo and Amigos de los Ríos.</p>`)).toEqual([]);
    // A short phrase, and a borrowed expression inside an English sentence.
    expect(await statuses(`${ENGLISH}<p>Se habla español.</p><p>The committee met ad hoc and agreed, pro bono, to review the per diem rates for the vis-à-vis meetings.</p>`)).toEqual([]);
    // A list of language names, each in its own language (a language menu).
    expect(await statuses(`${ENGLISH}<ul><li>English</li><li>Español</li><li>Français</li><li>Tiếng Việt</li><li>中文</li><li>한국어</li><li>Русский</li><li>العربية</li></ul>`)).toEqual([]);
    // One line with both languages' labels.
    expect(await statuses(`${ENGLISH}<p>Office hours / Horario de oficina: Monday to Friday, 8 a.m. to 5 p.m. / lunes a viernes, de 8 a 5.</p>`)).toEqual([]);
  });

  it('English sentences that quote the other language, and a mixed sentence', async () => {
    expect(await statuses(`${ENGLISH}<p>The sign at the gate says “no se permite la entrada” and we ask that you respect it when the yard is closed to the public.</p>`)).toEqual([]);
  });

  it('a page in a language the test has no word list for is never judged by words', async () => {
    // Italian shares many short words with Spanish: it must not be read as Spanish on a page marked Italian…
    const italian = 'Quando è prevista la neve, spostate la vostra auto dalle strade indicate prima che arrivino i mezzi, in modo che le squadre possano liberare tutta la via.';
    expect(await statuses(`<h1>Regole</h1><p>${italian}</p>`, 'it')).toEqual([]);
    // …and a Dutch page (no word list) says it cannot be tested, never that it failed.
    const dutch = 'Als er sneeuw wordt verwacht, verplaats dan uw auto van de aangegeven routes voordat de ploegen komen, zodat de hele straat kan worden schoongemaakt.';
    expect(await statuses(`<p>${dutch}</p><p>${dutch.replace('sneeuw', 'ijzel')}</p>`, 'nl')).toEqual(['not_testable']);
  });

  it('code, hidden text, form controls and placeholder filler are no passages', async () => {
    expect(await statuses(`${ENGLISH}
      <pre>${SPANISH}</pre><code>${SPANISH}</code>
      <p style="display:none">${SPANISH}</p><div hidden><p>${FRENCH}</p></div><div aria-hidden="true"><p>${FRENCH}</p></div>
      <textarea>${SPANISH}</textarea><select><option>${SPANISH}</option></select>
      <p>Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.</p>`)).toEqual([]);
  });

  it('a page with no language at all, or lang="", is the page-language rules\' subject', async () => {
    expect(await statuses(`<p>${SPANISH}</p>`, 'none')).toEqual(['not_applicable']);
    expect(await statuses(`${ENGLISH}<p lang="">${SPANISH}</p>`)).toEqual([]);
  });

  it('a page that is in another language throughout has the wrong page language (3.1.1), not unmarked parts (3.1.2)', async () => {
    const page = `<nav><a href="/">Inicio</a> <a href="/s">Servicios</a> <a href="/c">Contacto</a></nav><h1>Reglas de estacionamiento</h1><p>${SPANISH}</p><p>${SPANISH.replace('nieve', 'hielo')}</p><p>Los equipos trabajan de noche para que las calles estén listas por la mañana y usted pueda salir sin problemas.</p>`;
    const f = languagePartFindings(await readOn(page));
    expect(f.map((x) => [x.criterion, x.status])).toEqual([['3.1.1', 'failed']]);
    expect(f[0]!.detail).toContain('The page\'s language is set to English (lang="en"), but its text reads as Spanish');
    // The same page marked Spanish is right, on both criteria.
    expect(await statuses(page, 'es')).toEqual([]);
    // A page in two languages, half and half, has a part that is not marked: that is 3.1.2, and the page language stands.
    const half = languagePartFindings(await readOn(`${ENGLISH}<p>${SPANISH}</p><p>Los equipos trabajan de noche para que las calles estén listas por la mañana y usted pueda salir sin problemas.</p>`));
    expect(half.map((x) => [x.criterion, x.status])).toEqual([['3.1.2', 'failed'], ['3.1.2', 'failed']]);
  });

  it('one passage in another language on a page whose own text is short pieces is still a part (3.1.2), not the page', async () => {
    // Menus, headings and one-line notes in English (none long enough to judge alone), and one Spanish notice.
    const f = languagePartFindings(await readOn(`<nav><a href="/">Home</a> <a href="/s">Services and permits</a> <a href="/c">Contact the office</a></nav>
      <h1>Winter parking</h1><h2>What to do when it snows</h2><p>Move your car before the plows come.</p><p>See the map of the routes.</p><ul><li>Call the office for help</li><li>Sign up for alerts by text</li></ul>
      <p id="other">${SPANISH}</p>`));
    expect(f.map((x) => [x.criterion, x.status, x.target])).toEqual([['3.1.2', 'failed', '#other']]);
  });

  it('page language (3.1.1): another script throughout, and what must stay clean', async () => {
    const zh = '下雪时，请在铲雪车到达之前把您的车辆从标明的路线上移开，以便工作人员清理整条街道。';
    expect((await languagePartFindings(await readOn(`<h1>冬季停车规定</h1><p>${zh}</p><p>${zh}请注意安全。</p>`))).map((x) => [x.criterion, x.status])).toEqual([['3.1.1', 'failed']]);
    // A page with too little text to tell, a page of names, and an English page are not judged or clean.
    expect(await statuses('<h1>Hola</h1><p>Bienvenidos a la ciudad.</p>')).toEqual(['not_applicable']);
    expect((await languagePartFindings(await readOn(ENGLISH))).filter((x) => x.criterion === '3.1.1')).toEqual([]);
  });
});

describe('review round 1: names are never running text, and a script alone proves nothing (3.1.2)', () => {
  it('an all-caps or title-case sequence of names in another language is not a failure', async () => {
    // An English directory with a Spanish organisation's name in capitals, and one in title case.
    const f = languagePartFindings(await readOn(`${ENGLISH}<ul><li>CASA DE LA FAMILIA Y CENTRO PARA LOS DERECHOS DE TODOS</li><li>Centro de la Familia y de los Derechos de Todos los Niños del Condado</li></ul>`));
    expect(f.filter((x) => x.status === 'failed')).toEqual([]);
  });

  it('a paragraph that lists names in another script is not a failure', async () => {
    const names = '北京市人民政府办公厅、上海市教育委员会、广州市公安局交通管理支队、深圳市卫生健康委员会、成都市交通运输局';
    const f = languagePartFindings(await readOn(`${ENGLISH}<p>Sister agencies:</p><p id="names">${names}</p>`));
    expect(f.filter((x) => x.status === 'failed')).toEqual([]);
    // Cyrillic and Arabic names, the same.
    const more = languagePartFindings(await readOn(`${ENGLISH}<p>Московский государственный университет, Российская государственная библиотека, Государственный Эрмитаж</p><p>وزارة الصحة، هيئة الطرق والمواصلات، بلدية المدينة المنورة، جامعة الملك سعود</p>`));
    expect(more.filter((x) => x.status === 'failed')).toEqual([]);
  });

  it('a list of titles with no sentence in it, and product names, are not failures', async () => {
    const f = languagePartFindings(await readOn(`${ENGLISH}<p>Cien Años de Soledad, El Amor en los Tiempos del Cólera, La Casa de los Espíritus, Como Agua para Chocolate</p>`));
    expect(f.filter((x) => x.status === 'failed')).toEqual([]);
  });

  it('a name written like a sentence (lower case, a full stop) with no sentence word in it is undecided, never failed', async () => {
    const f = languagePartFindings(await readOn(`${ENGLISH}<p id="name">Centro de la familia y de los derechos de todos los niños del condado.</p>`));
    expect(f.map((x) => [x.criterion, x.status])).toEqual([['3.1.2', 'not_testable']]);
  });

  it('two plain sentences with none of the language\'s sentence words are undecided (two names in sentence case read the same); with one they fail', async () => {
    const f = languagePartFindings(await readOn(`${ENGLISH}<p id="two">La prueba anual protege el agua de la ciudad. La visita del técnico dura menos de una hora en cada casa.</p>`));
    expect(f.map((x) => [x.criterion, x.status])).toEqual([['3.1.2', 'not_testable']]);
    const g = languagePartFindings(await readOn(`${ENGLISH}<p id="two">La prueba anual protege el agua de la ciudad. Usted debe programar la visita antes de la fecha indicada en el aviso.</p>`));
    expect(g.map((x) => [x.criterion, x.status, x.target])).toEqual([['3.1.2', 'failed', '#two']]);
  });

  // Batch 17 (structure lane): the polite commands of a public notice are verb forms a name does not have.
  it('a notice written in polite commands is running text: "Programe…", "Mantenga… y llame…", "Comuníquese…"', async () => {
    for (const [id, text] of [
      ['plan', 'La prueba anual ayuda a proteger el agua potable. Programe la inspección antes de la fecha indicada en su aviso.'],
      ['keep', 'No toque el agua residual. Mantenga a los niños y a las mascotas lejos del área y llame al número de emergencia del distrito.'],
      ['reach', 'Para pedir una copia de la factura en papel, comuníquese con la oficina de servicio al cliente antes del viernes.'],
    ] as const) {
      const g = languagePartFindings(await readOn(`${ENGLISH}<p id="${id}">${text}</p>`));
      expect(g.map((x) => [x.criterion, x.status, x.target]), id).toEqual([['3.1.2', 'failed', `#${id}`]]);
    }
  });

  it('look-alikes of the commands: names and titles that hold no verb, a noun spelled like a command, and commands in capitals or in a list of names', async () => {
    // "Cierre", "informe", "toque" and "presente" are nouns and adjectives too: they prove no sentence.
    for (const text of [
      'Cierre de la calle Mayor por obras del puente. Informe anual de la calidad del agua del distrito del valle.',
      'Toque de queda en la zona del puerto. Lista de los vecinos del barrio presente en la sala.',
    ]) {
      const f = languagePartFindings(await readOn(`${ENGLISH}<p id="n">${text}</p>`));
      expect(f.filter((x) => x.status === 'failed'), text).toEqual([]);
    }
    // Names of campaigns in title case, and short items of a list: never running text.
    for (const text of ['Llame Ya, Visite Nuestra Casa, Mantenga Limpio el Valle, Guarde el Agua', 'Sopa de la casa, llame, visite, pague, la carne en su jugo, el arroz de la abuela']) {
      const f = languagePartFindings(await readOn(`${ENGLISH}<p id="n">${text}</p>`));
      expect(f.filter((x) => x.status === 'failed'), text).toEqual([]);
    }
    // A Spanish word that ends "-se" with no accent before it is no command ("clase", "fase", "base").
    const g = languagePartFindings(await readOn(`${ENGLISH}<p id="n">La clase de la tarde en la base del valle. La fase de la obra del puente de la ciudad.</p>`));
    expect(g.filter((x) => x.status === 'failed')).toEqual([]);
  });

  it('text in capitals that has a sentence\'s own words is undecided, never failed', async () => {
    const f = languagePartFindings(await readOn(`${ENGLISH}<p id="caps">AVISO: LA OFICINA ESTARÁ CERRADA EL LUNES Y NO SE ATENDERÁ AL PÚBLICO HASTA QUE SE TERMINE LA OBRA.</p>`));
    expect(f.map((x) => [x.criterion, x.status])).toEqual([['3.1.2', 'not_testable']]);
    expect(f[0]!.detail).toContain('may be');
  });

  it('look-alikes that still fail: running text with its sentence words and punctuation, in words and in another script', async () => {
    const zh = '下雪时，请在铲雪车到达之前把您的车辆从标明的路线上移开，以便工作人员清理整条街道。';
    const ja = '雪が予想されるときは、除雪車が到着する前に、指定された道路から車を移動してください。';
    const ko = '눈이 예보되면 제설차가 도착하기 전에 표시된 도로에서 차량을 옮겨 주시기 바랍니다. 감사합니다.';
    for (const [text, name] of [[SPANISH, 'Spanish'], [zh, 'Chinese characters'], [ja, 'Japanese'], [ko, 'Korean']] as const) {
      const f = languagePartFindings(await readOn(`${ENGLISH}<p id="other">${text}</p>`));
      expect(f.map((x) => [x.status, x.target]), name).toEqual([['failed', '#other']]);
    }
  });
});

describe('lists of names and borrowed words are never running text, however long (3.1.2)', () => {
  const failed = async (body: string) => languagePartFindings(await readOn(`${ENGLISH}${body}`)).filter((x) => x.status === 'failed');

  it('a menu of dish names, as links in one block, in lower case, with the particles every dish name has', async () => {
    const dishes = ['sopa de fideo', 'mole con arroz', 'enchiladas de la casa', 'pescado a la plancha', 'flan de la abuela', 'tostadas de tinga', 'pollo en su salsa', 'tamales de elote', 'agua de la huerta', 'nieve de limón'];
    expect(await failed(`<div id="menu">${dishes.map((d) => `<a href="#">${d}</a>`).join(' ')}</div>`)).toEqual([]);
    // The same as one line with commas and a full stop, and as lines that each end in a full stop.
    expect(await failed(`<p>${dishes.join(', ')}.</p>`)).toEqual([]);
    expect(await failed(`<p>${dishes.map((d) => d[0]!.toUpperCase() + d.slice(1)).join('. ')}.</p>`)).toEqual([]);
  });

  it('a lower-case list of borrowed French words and phrases', async () => {
    expect(await failed('<p>crème de la crème, pot au feu, coq au vin, tarte aux pommes, soupe du jour, pain au chocolat, vol au vent, café au lait, pâté de campagne, salade de chèvre.</p>')).toEqual([]);
  });

  it('agency names in Chinese characters between semicolons, with characters that are also particles; shop names in Japanese with の', async () => {
    const zh = '南京市不动产登记中心；杭州市就业服务中心；对外经济贸易学院；武汉市为民服务大厅；在线教育发展中心。';
    const ja = '森のパン屋、海の見える丘の公園、木のおもちゃの店、花の広場、星の図書館。';
    for (const [text, name] of [[zh, 'Chinese'], [ja, 'Japanese']] as const) expect(await failed(`<p>Partners:</p><p id="names">${text}</p>`), name).toEqual([]);
  });

  it('titles of works in sentence case, written out between commas, are a list of names even when one has a verb in it', async () => {
    expect(await failed('<p>El coronel no tiene quien le escriba, La casa de los espíritus, Crónica de una muerte anunciada.</p>')).toEqual([]);
    expect(await failed('<p>Il était une fois dans le Midi, La vie est un long fleuve tranquille, Les quatre cents coups du quartier.</p>')).toEqual([]);
  });

  it('titles that are links one after another, or lines of one paragraph, are a list whatever punctuation they lack', async () => {
    const titles = ['Cien años de soledad', 'El coronel no tiene quien le escriba', 'Lo que el viento se llevó', 'Donde viven los monstruos', 'La casa de los espíritus'];
    expect(await failed(`<div id="shelf">${titles.map((t) => `<a href="#">${t}</a>`).join('')}</div>`)).toEqual([]);
    expect(await failed(`<p id="lines">${titles.join('<br>')}</p>`)).toEqual([]);
    expect(await failed(`<div id="spans">${titles.map((t) => `<span>${t}</span>`).join(' ')}</div>`)).toEqual([]);
    // A title broken over two lines, or split by an element inside it, is still one title of a comma list.
    expect(await failed('<p>Como agua para<br>chocolate, El coronel no tiene quien le escriba, La casa de los espíritus.</p>')).toEqual([]);
    expect(await failed('<p><i>Como agua</i> <b>para chocolate</b>, El coronel no tiene quien le escriba, La casa de los espíritus.</p>')).toEqual([]);
    // Look-alike that still fails: a sentence with words set apart inside it (a link, emphasis) is one sentence.
    expect((await failed('<p id="s">Si no puede <a href="#">asistir a la reunión</a>, usted puede <em>enviar sus comentarios</em> por correo antes del viernes, porque el concejo los leerá en voz alta.</p>')).map((x) => x.target)).toEqual(['#s']);
  });

  it('review round 2, finding 4: text marked as the title of a work (cite, a q with a title, a name in structured data) is never a definite failure, however much it reads like a sentence', async () => {
    const title = 'La casa que está al final de la calle de los recuerdos.';
    for (const html of [`<p id="t"><cite>${title}</cite></p>`, `<p id="t"><q title="A novel">${title}</q></p>`, `<p id="t"><span itemprop="name">${title}</span></p>`, `<p id="t">Reading this month: <cite>${title}</cite></p>`]) {
      const f = languagePartFindings(await readOn(`${ENGLISH}${html}`));
      expect(f.filter((x) => x.status === 'failed'), html).toEqual([]);
      expect(f.map((x) => [x.criterion, x.status]), html).toEqual([['3.1.2', 'not_testable']]);
    }
    // Look-alike that still fails: the same sentence as plain text of a paragraph.
    expect((await failed(`<p id="s">${title}</p>`)).map((x) => x.target)).toEqual(['#s']);
  });

  it('a word that is also English ("on request", "car", "he", "son") proves no sentence in the other language; neither does an abbreviation in capitals', async () => {
    expect(await failed('<p>Moules à la crème et frites, salade du jour et plat du jour on request, tarte aux pommes de la maison.</p>')).toEqual([]);
    expect(await failed('<p>Arroz con pollo de la casa para mi son and daughter, the van del taller en la esquina de la plaza.</p>')).toEqual([]);
    expect(await failed('<p>Salade de chèvre du pays et pain de la ferme IL 60601 près de la gare du nord de la ville.</p>')).toEqual([]);
  });

  it('Japanese sentences that end in a plain verb form are running text too, never passed over', async () => {
    const f = languagePartFindings(await readOn(`${ENGLISH}<p id="ja">東京都は新しい条例を発表した。市民は来月から窓口で申請できる。</p>`));
    expect(f.map((x) => [x.status, x.target])).toEqual([['failed', '#ja']]);
    // Particles and a full stop with an ending the test has no word for: undecided, not names.
    const g = languagePartFindings(await readOn(`${ENGLISH}<p id="ja">東京都は新しい条例を来月から窓口で受け付ける見込み。</p>`));
    expect(g.map((x) => x.status)).toEqual(['not_testable']);
  });

  it('names in Korean, Russian and Arabic with a full stop at the end', async () => {
    const ko = '경기도 교육청, 서울특별시 종로구 주민센터, 세종로 문화회관, 부산광역시 해운대구 보건소.';
    const ru = 'Дом для всех, Центр помощи семье и детям, Школа искусств на набережной, Музей истории города и края.';
    const ar = 'مركز خدمة المواطنين في المدينة، مكتبة الملك فهد الوطنية، هيئة الطرق والنقل في المنطقة.';
    for (const [text, name] of [[ko, 'Korean'], [ru, 'Russian'], [ar, 'Arabic']] as const) expect(await failed(`<p id="names">${text}</p>`), name).toEqual([]);
  });

  it('a verb in the future tense is a sentence word (Spanish); a name or a dish that ends the same way is not', async () => {
    // "estará" is a verb form no word list can hold; a notice is written with it.
    expect((await failed('<p id="notice">La oficina de la calle Mayor estará cerrada el lunes por la mañana. Llame al número de la factura para pedir una cita.</p>')).map((x) => x.target)).toEqual(['#notice']);
    // A time or a number in a sentence is no list ("9:30", "1,200").
    expect((await failed('<p id="time">La reunión del concejo es a las 9:30 de la mañana en la sala principal del edificio.</p>')).map((x) => x.target)).toEqual(['#time']);
    // A capitalised word that ends in "-ará" is a name, and "alacrán" is no verb.
    expect(await failed('<p>Sopa de frijol con carne del Ceará. Tacos de alacrán con salsa de la casa y arroz. Mole de la abuela con pollo.</p>')).toEqual([]);
  });

  it('look-alikes that still fail: sentences with a sentence\'s own words, in each kind of proof', async () => {
    const es = 'Si no puede asistir a la reunión, usted puede enviar sus comentarios por correo antes del viernes, porque el concejo los leerá en voz alta.';
    const zh = '如果您不能参加会议，请在星期五之前把您的意见寄给我们，我们会在会议上宣读这些意见。';
    const ja = '会議に出席できない場合は、金曜日までにご意見を郵送してください。会議で読み上げます。';
    const ko = '회의에 참석할 수 없는 경우에는 금요일까지 의견을 우편으로 보내 주시기 바랍니다. 회의에서 낭독합니다.';
    const ru = 'Если вы не можете прийти на собрание, отправьте свои замечания по почте до пятницы, чтобы совет мог их зачитать.';
    const ar = 'إذا لم تتمكن من حضور الاجتماع، يمكن إرسال تعليقاتك بالبريد قبل يوم الجمعة لأن المجلس سيقرأ هذه التعليقات.';
    for (const [text, name] of [[es, 'Spanish'], [zh, 'Chinese'], [ja, 'Japanese'], [ko, 'Korean'], [ru, 'Russian'], [ar, 'Arabic']] as const) {
      expect((await failed(`<p id="other">${text}</p>`)).map((x) => x.target), name).toEqual(['#other']);
    }
  });
});

describe('review round 1: the page language counts all the text that takes it (3.1.1)', () => {
  const ENGLISH_MARKED = '<p lang="en">When snow is forecast, move your car off the marked routes before the plows arrive so that crews can clear the whole street. You will find the list of routes on the map, and you can sign up for a text message when your street is next.</p><p lang="en">Cars that are left on a marked route are towed to the city yard, and their owners must pay the towing fee before they can take them back. If you have nowhere to park, the library and the pool keep their car parks open all night when it snows.</p>';

  it('text marked with the page\'s own language counts: an English page with two shorter Spanish paragraphs is not a Spanish page', async () => {
    const f = languagePartFindings(await readOn(`<h1>Winter parking</h1>${ENGLISH_MARKED}<p id="a">${SPANISH}</p><p id="b">Los equipos trabajan de noche para que las calles estén listas por la mañana y usted pueda salir sin problemas.</p>`));
    expect(f.filter((x) => x.criterion === '3.1.1')).toEqual([]);
    expect(f.map((x) => [x.criterion, x.status, x.target])).toEqual([['3.1.2', 'failed', '#a'], ['3.1.2', 'failed', '#b']]);
  });

  it('a page whose only text is a name in another language, repeated, does not have the wrong page language', async () => {
    const name = '<p>Centro de la Familia y de los Derechos de Todos los Niños del Condado</p>';
    const f = languagePartFindings(await readOn(`${name}${name}${name}${name}`));
    expect(f.filter((x) => x.status === 'failed')).toEqual([]);
  });

  it('look-alike that still fails: running text in another language throughout, with a few names', async () => {
    const page = `<h1>Reglas de estacionamiento</h1><p>${SPANISH}</p><p>${SPANISH.replace('nieve', 'hielo')}</p><p>Los equipos trabajan de noche para que las calles estén listas por la mañana y usted pueda salir sin problemas.</p><p>Centro de la Familia</p>`;
    expect(languagePartFindings(await readOn(page)).map((x) => [x.criterion, x.status])).toEqual([['3.1.1', 'failed']]);
  });
});

describe('review round 1: the read is bounded before it allocates, and never silently clean', () => {
  it('a page with megabytes of text in one paragraph and a hundred thousand empty elements is sampled, and says so', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await page.setContent(`<!doctype html><html lang="en"><head><title>T</title></head><body>${ENGLISH}<p id="big"></p><div id="many"></div></body></html>`);
      await page.evaluate(() => {
        // Built in the page: three megabytes of words in one text node, and many empty elements.
        document.getElementById('big')!.textContent = 'the quick brown fox jumps over the lazy dog and runs away. '.repeat(52_000);
        const frag = document.createDocumentFragment();
        for (let i = 0; i < 200_000; i++) frag.appendChild(document.createElement('span'));
        document.getElementById('many')!.appendChild(frag);
      });
      const t0 = Date.now();
      const read = await page.evaluate(readLanguageParts, ARG);
      expect(Date.now() - t0).toBeLessThan(5_000);
      expect(read.truncated).toBe(true);
      expect(read.coverage.chars).toBeLessThanOrEqual(LANGUAGE_PARTS_LIMITS.chars);
      expect(read.coverage.nodes).toBeLessThanOrEqual(LANGUAGE_PARTS_LIMITS.nodes + 1);
      const f = languagePartFindings(read);
      // Neither criterion is clean on a page read in part: the page's language (3.1.1) is undecided too.
      expect(f.map((x) => [x.criterion, x.status]).sort()).toEqual([['3.1.1', 'not_testable'], ['3.1.2', 'not_testable']]);
      for (const x of f) expect(x.detail).toMatch(/characters/);
    } finally {
      await page.close();
    }
  }, 60_000);
});

describe('review round 2, finding 6: more shadow roots than the test reads is a page read in part', () => {
  it('fifty shadow hosts with running text in another language in the last one: the page is sampled and says so for both criteria, never clean', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await page.setContent(`<!doctype html><html lang="en"><head><title>T</title></head><body>${ENGLISH}<div id="hosts"></div></body></html>`);
      await page.evaluate((spanish) => {
        const hosts = document.getElementById('hosts')!;
        for (let i = 0; i < 50; i++) {
          const host = document.createElement('div');
          hosts.appendChild(host);
          host.attachShadow({ mode: 'open' }).innerHTML = i === 49 ? `<p>${spanish}</p>` : '<p>Open on weekdays from nine to five.</p>';
        }
      }, SPANISH);
      const read = await page.evaluate(readLanguageParts, ARG);
      expect(read.truncated).toBe(true);
      expect(read.coverage.roots).toBe(50);
      const f = languagePartFindings(read);
      expect(f.filter((x) => x.status === 'failed')).toEqual([]);
      expect(f.map((x) => [x.criterion, x.status]).sort()).toEqual([['3.1.1', 'not_testable'], ['3.1.2', 'not_testable']]);
      for (const x of f) expect(x.detail).toMatch(/shadow/);
      // Look-alike: forty-nine shadow hosts are all read, and the passage in the last one is found.
      await page.evaluate(() => { document.getElementById('hosts')!.firstElementChild!.remove(); });
      const whole = await page.evaluate(readLanguageParts, ARG);
      expect(whole.truncated).toBe(false);
      expect(languagePartFindings(whole).map((x) => [x.criterion, x.status])).toEqual([['3.1.2', 'failed']]);
    } finally {
      await page.close();
    }
  }, 60_000);
});

describe('a long paragraph is read to its end, and a long page in its own language says nothing about its language', () => {
  it('one paragraph of several thousand characters is read whole: the page is not called too large, and a passage at its end is found', async () => {
    const long = 'When snow is forecast, move your car off the marked routes before the plows arrive so that crews can clear the whole street. '.repeat(60);
    expect(long.length).toBeGreaterThan(7_000);
    const f = languagePartFindings(await readOn(`<h1>Winter parking rules</h1><p>${long}</p><p id="more">${long}${long}</p>`));
    expect(f).toEqual([]);
    // A block of more than a passage's length (12,000 characters) is read to its end, and the block after it too.
    const read = await readOn(`<h1>Winter parking rules</h1><div id="one">${long}${long}</div><p id="tail">${SPANISH}</p>`);
    expect(read.truncated).toBe(false);
    expect(read.coverage.chars).toBeGreaterThan(2 * long.length);
    expect(languagePartFindings(read).map((x) => [x.criterion, x.status, x.target])).toEqual([['3.1.2', 'failed', '#tail']]);
  });
});

describe('the language-parts probe', () => {
  it('is a core, every-page, render test for 3.1.1 and 3.1.2 that is listed and not scored', () => {
    expect(languagePartsProbe).toMatchObject({ id: 'language-parts', criteria: ['3.1.1', '3.1.2'], kind: 'render', tier: 'core', everyPage: true, scored: false });
    expect(PROBES).toContain(languagePartsProbe);
  });

  it('lists five passages and counts the rest', () => {
    const passages = Array.from({ length: 8 }, (_, i) => ({ target: `#p${i}`, declared: 'en', reads: 'es', by: 'words' as const, text: `texto ${i}`, words: 12, root: true }));
    const f = languagePartFindings({ passages: passages.map((x) => ({ ...x, page: true })), unsure: [], judged: 40, unknown: [], truncated: false, coverage: { nodes: 900, textNodes: 300, chars: 20_000, roots: 1 } });
    expect(f).toHaveLength(5);
    expect(f[4]!.detail).toMatch(/\(3 more like this on this page\)$/);
  });
});
