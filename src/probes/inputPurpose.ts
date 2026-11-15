// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 1.3.5 (Identify input purpose): a conservative matcher from a field's label, placeholder,
// name and id to the input purposes WCAG lists (HTML autofill tokens), English and Spanish. A field
// it cannot decide is "ambiguous" and goes to the AI forms review. Engine core: no Node-only imports.

/** The input purposes of WCAG 2.2 section 7 (HTML autofill field names). */
export const INPUT_PURPOSES = [
  'name', 'honorific-prefix', 'given-name', 'additional-name', 'family-name', 'honorific-suffix', 'nickname',
  'organization-title', 'username', 'new-password', 'current-password', 'organization',
  'street-address', 'address-line1', 'address-line2', 'address-line3', 'address-level4', 'address-level3', 'address-level2', 'address-level1',
  'country', 'country-name', 'postal-code',
  'cc-name', 'cc-given-name', 'cc-additional-name', 'cc-family-name', 'cc-number', 'cc-exp', 'cc-exp-month', 'cc-exp-year', 'cc-csc', 'cc-type',
  'transaction-currency', 'transaction-amount', 'language', 'bday', 'bday-day', 'bday-month', 'bday-year', 'sex', 'url', 'photo',
  'tel', 'tel-country-code', 'tel-national', 'tel-area-code', 'tel-local', 'tel-local-prefix', 'tel-local-suffix', 'tel-extension',
  'email', 'impp',
] as const;
export type InputPurpose = (typeof INPUT_PURPOSES)[number];

/** Every autofill field name HTML defines (the WCAG list plus the few it leaves out). */
const AUTOFILL_FIELDS = new Set<string>([...INPUT_PURPOSES, 'one-time-code']);

/** Tokens that identify the same kind of information: any of them satisfies the purpose. */
const FAMILIES: readonly (readonly InputPurpose[])[] = [
  ['name', 'honorific-prefix', 'given-name', 'additional-name', 'family-name', 'honorific-suffix', 'nickname'],
  ['current-password', 'new-password'],
  ['street-address', 'address-line1', 'address-line2', 'address-line3'],
  ['tel', 'tel-country-code', 'tel-national', 'tel-area-code', 'tel-local', 'tel-local-prefix', 'tel-local-suffix', 'tel-extension'],
  ['bday', 'bday-day', 'bday-month', 'bday-year'],
  ['cc-exp', 'cc-exp-month', 'cc-exp-year'],
  ['cc-name', 'cc-given-name', 'cc-additional-name', 'cc-family-name'],
  ['country', 'country-name'],
];

/** The tokens that satisfy a purpose (its family; email and username also accept each other). */
export function acceptedTokens(purpose: InputPurpose): InputPurpose[] {
  if (purpose === 'email' || purpose === 'username') return ['email', 'username'];
  return [...(FAMILIES.find((f) => f.includes(purpose)) ?? [purpose])];
}

export interface AutocompleteValue {
  /** The autofill field name (the last token, without `webauthn`), when it is a valid one. */
  token?: string;
  /** `off`, `on`, empty or missing: no purpose given. */
  none: boolean;
  /** The attribute is present but names no autofill field. */
  invalid: boolean;
}

/** Reads an `autocomplete` attribute (`"section-a shipping email"`, `"billing tel webauthn"`, `"off"`). */
export function parseAutocomplete(attr: string | null | undefined): AutocompleteValue {
  const tokens = (attr ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens[tokens.length - 1] === 'webauthn') tokens.pop();
  const last = tokens[tokens.length - 1];
  if (!last || ((last === 'off' || last === 'on') && tokens.length === 1)) return { none: true, invalid: false };
  if (!AUTOFILL_FIELDS.has(last)) return { none: false, invalid: true };
  // HTML's autofill grammar, in order: [section-*] [shipping | billing] [home | work | mobile | fax | pager,
  // only before a contact field (tel…, email, impp)] field [webauthn] (ACT 73f2c2: "work shipping email" fails).
  let i = 0;
  if (tokens[i]?.startsWith('section-')) i++;
  if (tokens[i] === 'shipping' || tokens[i] === 'billing') i++;
  if (CONTACT_KINDS.has(tokens[i] ?? '') && i < tokens.length - 1) {
    if (!CONTACT_FIELDS.has(last)) return { none: false, invalid: true };
    i++;
  }
  if (i !== tokens.length - 1) return { none: false, invalid: true };
  return { token: last, none: false, invalid: false };
}

/** Contact kinds and the fields they may come before (HTML autofill). */
const CONTACT_KINDS = new Set(['home', 'work', 'mobile', 'fax', 'pager']);
const CONTACT_FIELDS = new Set(['tel', 'tel-country-code', 'tel-national', 'tel-area-code', 'tel-local', 'tel-local-prefix', 'tel-local-suffix', 'tel-extension', 'email', 'impp']);

/** What a field is for, as far as the field's own text tells. */
export type PurposeMatch =
  | { kind: 'purpose'; purpose: InputPurpose; source: 'label' | 'placeholder' | 'name' | 'type' | 'legend' }
  | { kind: 'ambiguous'; reason: string }
  | { kind: 'none' };

export interface FieldText {
  /** The field's label (accessible name without the placeholder); '' when it has none. */
  label: string;
  placeholder?: string;
  name?: string;
  id?: string;
  /** Input type ('text', 'email', 'tel', 'password', 'select', 'textarea'…). */
  type: string;
  /** The form takes card details (card number field), so expiry and security code mean the card's. */
  payment?: boolean;
  /** The form has more than one password field, or says "new password": a sign-up or change form. */
  newPassword?: boolean;
  /** Batch 18: the legend or name of the group around the field ("Date of birth" over Month, Day and Year). */
  legend?: string;
}

/** Lower case, no accents, no "(required)", "*", ":" or "your", spaces collapsed. */
export function normalizeLabel(s: string): string {
  return s
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/[*:?!]+/g, ' ')
    .replace(/\b(required|optional|obligatorio|opcional)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(please )?((enter|type|provide)( your)?|your|tu|su) /, '')
    .replace(/^(ingrese|ingresa|escriba|escribe|introduzca|introduce) (su |tu )?/, '')
    .replace(/[.,;-]+$/, '')
    .trim();
}

/** Words in a name or id: `billingFirstName` → `billing first name`, `user_email` → `user email`. */
export function nameWords(s: string): string {
  return s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\d+/g, (d) => ` ${d} `)
    .replace(/\s+/g, ' ')
    .trim();
}

/** Whole-label patterns (normalized, anchored), in priority order. */
const LABEL_RULES: readonly (readonly [InputPurpose, RegExp, 'payment'?])[] = [
  ['username', /^(user ?name|user ?id|login|login (name|id)|(user ?name|email|e-?mail) or (user ?name|e-?mail)|usuario|nombre de usuario)$/],
  ['email', /^((confirm|re-?enter|repeat|verify|confirmar|repetir) )?(e-?mail|e-?mail address|correo|correo electronico|direccion de correo( electronico)?)$/],
  ['tel-extension', /^(ext|extension|phone extension)$/],
  ['tel', /^((mobile|cell|home|work|daytime|day time|evening|contact|primary) )?(phone|telephone|tel)( number| no| #)?$|^(mobile|cell)( phone)?( number| no)?$|^(numero de )?(telefono|celular|movil)( (movil|celular|fijo))?$/],
  ['cc-name', /^(name on (the )?card|card ?holder( name)?|nombre (en|del titular de) la tarjeta|titular de la tarjeta)$/],
  ['cc-number', /^((credit |debit )?card number|card no|card #|credit card|numero de (la )?tarjeta)$/],
  ['cc-exp', /^(expiration( date)?|expiry( date)?|exp( date)?|expires|mm ?\/ ?yy(yy)?|fecha de (vencimiento|caducidad|expiracion)|vencimiento)$/, 'payment'],
  ['cc-csc', /^(cvv2?|cvc2?|csc|cid|security code|card security code|card verification( code| number)?|codigo de seguridad)$/, 'payment'],
  ['transaction-amount', /^((donation |payment )?amount|monto|importe)$/, 'payment'],
  ['given-name', /^(first name|given name|forename|first names|primer nombre|nombre de pila)$/],
  ['additional-name', /^(middle name|middle initial|segundo nombre)$/],
  ['family-name', /^(last name|surname|family name|apellidos?|primer apellido)$/],
  ['name', /^((full|complete|first and last) name|name|nombre( completo)?|nombre y apellidos?)$/],
  ['nickname', /^(nickname|preferred name|apodo)$/],
  ['honorific-prefix', /^(salutation|honorific|name prefix)$/],
  ['organization-title', /^(job title|cargo|puesto( de trabajo)?)$/],
  ['organization', /^(company( name)?|organi[sz]ation( name)?|employer|business name|empresa|nombre de la empresa|organizacion)$/],
  ['address-line2', /^(address( line)? ?2|address line two|apt|apartment|suite|unit|apt \/ suite|apartment, suite, etc)$/],
  ['street-address', /^((street|home|mailing|postal|billing|shipping|residential) )?address( line)?( ?1)?$|^(street|street address|address line one|direccion|domicilio|calle( y numero)?)$/],
  ['address-level2', /^(city|town|city \/ town|city\/town|ciudad|localidad|municipio|poblacion)$/],
  ['address-level1', /^(state|province|region|state \/ province|state\/province|estado|provincia)$/],
  ['postal-code', /^(zip|zip code|zipcode|postal code|postcode|post code|zip \/ postal code|zip\/postal code|postal\/zip code|codigo postal)$/],
  ['country', /^(country|country \/ region|country\/region|pais)$/],
  ['bday', /^(date of birth|birth ?date|birthday|dob|d\.o\.b|fecha de nacimiento)$/],
  ['sex', /^(sex|gender|sexo|genero)$/],
  ['url', /^(website|web site|homepage|home page|url|website url|web address|sitio web|pagina web)$/],
];

/** Patterns for the words of a name or id (used only when the field has no label or placeholder). */
const NAME_RULES: readonly (readonly [InputPurpose, RegExp, 'payment'?])[] = [
  ['username', /\b(user ?name|login|user ?id|usuario)\b/],
  ['email', /\b(e ?mail|correo)\b/],
  ['tel', /\b(phone|telephone|tel|mobile|cell|telefono|celular)\b/],
  ['cc-number', /\b(cc ?number|card ?number|cardnumber)\b/],
  ['cc-csc', /\b(cvv|cvc|csc)\b/, 'payment'],
  ['given-name', /\b(first ?name|fname|given ?name|forename)\b/],
  ['family-name', /\b(last ?name|lname|surname|family ?name|apellidos?)\b/],
  ['name', /^(your )?(full ?)?name$|^nombre$/],
  ['organization', /\b(company|organi[sz]ation|empresa)\b/],
  ['address-line2', /\b(address ?2|addr ?2|address line ?2)\b/],
  ['street-address', /\b(address ?1?|addr ?1|street|direccion)\b/],
  ['address-level2', /\b(city|town|ciudad)\b/],
  ['address-level1', /\b(state|province|provincia)\b/],
  ['postal-code', /\b(zip ?(code)?|postal ?code|post ?code|postcode|codigo postal)\b/],
  ['country', /\b(country|pais)\b/],
  ['bday', /\b(dob|birthday|birth ?date|date of birth)\b/],
  ['url', /\b(website|homepage)\b/],
];

/** The field is about another person (a student, a child, a friend…), so it may not be about the user. */
const OTHER_PERSON = /\b(friends?|recipients?|students?|child(ren)?|kids?|sons?|daughters?|parents?|guardians?|spouses?|partners?|emergency|references?|referees?|beneficiar(y|ies)|employees?|patients?|someone|their|his|her|supervisors?|managers?|landlords?|owners?|contractors?|agents?|representatives?|witness(es)?|physicians?|doctors?|attorneys?|lawyers?|callers?|customers?|clients?|co-?applicants?|second|secondary|alternate|additional|other|another|caretakers?|teachers?|alumnos?|estudiantes?|hijos?|hijas?|ninos?|ninas?|padres?|madres?|tutor(es)?|conyuges?|destinatarios?|amigos?|amigas?|emergencia|referencias?|arrendador|propietari[oa]|clientes?|testigos?|medic[oa]|supervisora?)\b/;
/** Words that say the field is the person's own, put before a purpose ("Applicant first name", "Your daytime phone"). */
const OWNER = /^(applicant'?s?|primary|personal|preferred|contact|best|current|main|daytime|day time|evening|home|mobile|cell)\s+/;
/** What a purpose is for, after it ("Email for receipts", "Phone where we can reach you"): said of the same value. */
const FOR_TAIL = /\s+(for|where|so|to|we|that|which|at which)\b.*$/;
/** Parts of a value a group's legend names ("Date of birth": Month, Day, Year). */
const PARTS: readonly (readonly [RegExp, RegExp, InputPurpose])[] = [
  [/\b(date of birth|birth ?date|birthday|dob)\b/, /^(month|mm)$/, 'bday-month'],
  [/\b(date of birth|birth ?date|birthday|dob)\b/, /^(day|dd)$/, 'bday-day'],
  [/\b(date of birth|birth ?date|birthday|dob)\b/, /^(year|yyyy|yy)$/, 'bday-year'],
  [/\bname\b/, /^(first|given|first name)$/, 'given-name'],
  [/\bname\b/, /^(last|family|surname|last name)$/, 'family-name'],
  [/\bname\b/, /^(middle|mi|middle initial)$/, 'additional-name'],
  [/\b(phone|telephone)\b/, /^(area code|area)$/, 'tel-area-code'],
  [/\b(phone|telephone)\b/, /^(ext|extension)$/, 'tel-extension'],
  [/\b(address|mailing address|home address)\b/, /^(street|street address|address line 1|line 1)$/, 'address-line1'],
  [/\b(address|mailing address|home address)\b/, /^(city|town)$/, 'address-level2'],
  [/\b(address|mailing address|home address)\b/, /^(state|province)$/, 'address-level1'],
  [/\b(address|mailing address|home address)\b/, /^(zip|zip code|postal code|postcode)$/, 'postal-code'],
];

/** Words that hint at personal information when no rule decides: those fields go to the AI. */
const PERSONAL_HINT = /\b(e ?mail|mail|phone|telephone|tel|mobile|cell|name|names|address|street|zip|postal|postcode|city|town|state|province|country|birth|dob|company|organi[sz]ation|employer|user|login|password|card|cvv|website|gender|sex|correo|telefono|celular|nombre|apellidos?|direccion|domicilio|ciudad|pais|nacimiento|empresa|usuario|contrasena|tarjeta)\b/;

const ruleMatch = (rules: typeof LABEL_RULES, text: string, payment: boolean): InputPurpose | undefined =>
  rules.find(([, re, needs]) => (!needs || payment) && re.test(text))?.[0];

/**
 * The input purpose a field's own text clearly names, or `ambiguous` when it hints at personal
 * information but no rule decides (or it may be about someone else), or `none`.
 * - Password fields are always the user's password: `new-password` in sign-up and change forms,
 *   else `current-password`.
 * - The label decides; without a label, the placeholder; without either, the name or id.
 * - A label and a name that disagree, an email or tel field whose text names no purpose, and
 *   anything mentioning another person are ambiguous.
 */
export function matchInputPurpose(f: FieldText): PurposeMatch {
  const type = f.type.toLowerCase();
  if (['search', 'hidden', 'submit', 'button', 'reset', 'image', 'file', 'checkbox', 'radio', 'range', 'color'].includes(type)) return { kind: 'none' };
  const label = normalizeLabel(f.label);
  const placeholder = normalizeLabel(f.placeholder ?? '');
  const words = [f.name, f.id].filter(Boolean).map((s) => nameWords(s!)).join(' ');
  const payment = !!f.payment;
  if (type === 'password') {
    const text = `${label} ${placeholder} ${words}`;
    if (/\b(captcha|otp|one time|verification|pin)\b/.test(text)) return { kind: 'none' };
    const fresh = f.newPassword || /\b(new|create|choose|confirm|re-?enter|repeat|again|nueva|crear|confirmar|repetir)\b/.test(text);
    return { kind: 'purpose', purpose: fresh ? 'new-password' : 'current-password', source: label ? 'label' : placeholder ? 'placeholder' : 'name' };
  }
  const text = label || placeholder;
  const legend = normalizeLabel(f.legend ?? '');
  const all = `${label} ${placeholder} ${words}`;
  if (OTHER_PERSON.test(all) || OTHER_PERSON.test(legend)) {
    return PERSONAL_HINT.test(all) ? { kind: 'ambiguous', reason: 'it may ask about someone other than the person filling in the form' } : { kind: 'none' };
  }
  if (text) {
    // Batch 18 (V-IP-09): an owner word before the purpose, or what it is for after it, says the same value.
    const bare = text.replace(OWNER, '').replace(FOR_TAIL, '').trim();
    const hit = ruleMatch(LABEL_RULES, text, payment) ?? (bare && bare !== text ? ruleMatch(LABEL_RULES, bare, payment) : undefined);
    if (hit) {
      // A name or id that names a different kind of information makes the field ambiguous.
      const byName = words ? ruleMatch(NAME_RULES, words, payment) : undefined;
      if (byName && !acceptedTokens(hit).includes(byName) && !acceptedTokens(byName).includes(hit)) {
        return { kind: 'ambiguous', reason: `its label suggests ${hit} but its name suggests ${byName}` };
      }
      return { kind: 'purpose', purpose: hit, source: label ? 'label' : 'placeholder' };
    }
    // Batch 18 (V-IP-10): a part of a value the group's legend names ("Date of birth" over "Month").
    const part = PARTS.find(([lg, pt]) => lg.test(legend) && pt.test(text));
    if (part) return { kind: 'purpose', purpose: part[2], source: 'legend' };
    // Fix round (Sol S3, lead's ruling): an email or phone field whose words name no purpose ("Where can notices be
    // sent?") may be anyone's: whose it is is the AI check's to judge from the whole form, never the type's.
    if (PERSONAL_HINT.test(all) || type === 'email' || type === 'tel') return { kind: 'ambiguous', reason: 'its label hints at personal information that no rule decides' };
    return { kind: 'none' };
  }
  if (words) {
    const hit = ruleMatch(NAME_RULES, words, payment);
    if (hit) return { kind: 'purpose', purpose: hit, source: 'name' };
  }
  if (PERSONAL_HINT.test(all) || type === 'email' || type === 'tel') return { kind: 'ambiguous', reason: 'it has no label, and its name or type hints at personal information' };
  return { kind: 'none' };
}

export type AutocompleteVerdict = 'ok' | 'missing' | 'off' | 'invalid' | 'different';

/** Whether the field's `autocomplete` identifies the purpose (any token of the purpose's family). */
export function judgeAutocomplete(purpose: InputPurpose, attr: string | null | undefined): AutocompleteVerdict {
  if (attr === null || attr === undefined || !attr.trim()) return 'missing';
  const v = parseAutocomplete(attr);
  if (v.none) return /\boff\b/i.test(attr) ? 'off' : 'missing';
  if (v.invalid) return 'invalid';
  // Within the name family one pair contradicts: a first-name token on a last-name field, and the reverse (F107).
  if (OPPOSITE[purpose]?.includes(v.token as InputPurpose)) return 'different';
  return (acceptedTokens(purpose) as string[]).includes(v.token!) ? 'ok' : 'different';
}

/** Tokens of a purpose's own family that name the opposite part: filling one into the other puts the wrong value in. */
const OPPOSITE: Partial<Record<InputPurpose, readonly InputPurpose[]>> = {
  'given-name': ['family-name'], 'family-name': ['given-name'],
  'cc-given-name': ['cc-family-name'], 'cc-family-name': ['cc-given-name'],
};

/** Plain words for a purpose in report text. */
export const PURPOSE_WORDS: Readonly<Partial<Record<InputPurpose, string>>> = {
  name: 'the person’s full name', 'given-name': 'the person’s first name', 'family-name': 'the person’s last name',
  'additional-name': 'the person’s middle name', nickname: 'the person’s nickname', 'honorific-prefix': 'a title such as Mr or Dr',
  'organization-title': 'the person’s job title', organization: 'the person’s company or organization', username: 'the person’s user name',
  'new-password': 'a new password', 'current-password': 'the person’s password', 'street-address': 'the person’s street address',
  'address-line1': 'the first line of the address', 'address-line2': 'the second line of the address', 'address-level2': 'the city or town',
  'address-level1': 'the state or province', 'postal-code': 'the postal code', country: 'the country', 'country-name': 'the country',
  'cc-name': 'the name on the card', 'cc-number': 'the card number', 'cc-exp': 'the card’s expiry date', 'cc-csc': 'the card’s security code',
  'transaction-amount': 'the amount to pay', bday: 'the person’s date of birth', sex: 'the person’s gender', url: 'the person’s website',
  tel: 'the person’s phone number', 'tel-extension': 'the phone extension', email: 'the person’s email address',
};
