import type { Gender, Lang, ToneLabel } from '@/format/types';

export interface VerbInfo {
  thought?: boolean;
  tone?: ToneLabel;
  /** A first-person singular form ("dije", "respondí"): its subject is whoever tells the story. */
  firstPerson?: true;
  /** "added", "añadió": with no subject, the last speaker goes on. */
  continues?: true;
  /** "replied", "respondió": not said by the person who just spoke. */
  reply?: true;
  /** An English base form ("ask", "reply"): a tag only right after "I" (see verbAt). */
  bare?: true;
  /** A Spanish imperfect ("decía", "preguntaba"): the same form in the first and third person. */
  anyPerson?: true;
}

const v = (tone?: ToneLabel): VerbInfo => (tone ? { tone } : {});
const THOUGHT: VerbInfo = { thought: true };
const REPLY: VerbInfo = { reply: true };
const CONTINUES: VerbInfo = { continues: true };
const firstPerson = (tone?: ToneLabel): VerbInfo => ({ ...v(tone), firstPerson: true });
const bare = (tone?: ToneLabel): VerbInfo => ({ ...v(tone), bare: true });
const anyPerson = (info: VerbInfo): VerbInfo => ({ ...info, anyPerson: true });
const each = (words: string[], info: VerbInfo) => Object.fromEntries(words.map((w) => [w, info]));

/** Speech and thought verbs that introduce or tag dialogue, with the tone they imply. */
export const VERBS: Record<Lang, Record<string, VerbInfo>> = {
  en: {
    ...each(
      [
        'said',
        'says',
        'say',
        'asked',
        'asks',
        'observed',
        'remarked',
        'called',
        'inquired',
        'enquired',
        'interrupted',
        'began',
        'repeated',
        'insisted',
        'agreed',
        'declared',
        'protested',
        'explained',
        'told',
        'urged',
        'warned',
        'admitted',
        'suggested',
        'announced',
        'spoke',
        'ventured',
        'conceded',
        'persisted',
      ],
      v(),
    ),
    ...each(
      ['replied', 'replies', 'answered', 'answers', 'returned', 'rejoined', 'responded'],
      REPLY,
    ),
    ...each(['added', 'adds', 'continued', 'resumed', 'went'], CONTINUES),
    retorted: { tone: 'angry', reply: true },
    cried: v('excited'),
    exclaimed: v('excited'),
    shouted: v('shout'),
    shouts: v('shout'),
    yelled: v('shout'),
    screamed: v('shout'),
    roared: v('shout'),
    whispered: v('whisper'),
    whispers: v('whisper'),
    murmured: v('whisper'),
    murmurs: v('whisper'),
    muttered: v('whisper'),
    mutters: v('whisper'),
    sobbed: v('sad'),
    sighed: v('tired'),
    laughed: v('happy'),
    chuckled: v('happy'),
    snapped: v('angry'),
    growled: v('angry'),
    snarled: v('angry'),
    hissed: v('angry'),
    pleaded: v('pleading'),
    begged: v('pleading'),
    teased: v('mocking'),
    sneered: v('mocking'),
    mocked: v('mocking'),
    gasped: v('fearful'),
    stammered: v('fearful'),
    demanded: v('urgent'),
    thought: THOUGHT,
    wondered: THOUGHT,
    mused: THOUGHT,
    reflected: THOUGHT,
    // Present tense, third person, like "says" and "asks": "“Ha!” Jonah laughs." Every -s form
    // but those two is a verb only with a subject; "between sobs" is a noun (see isVerb).
    ...each(
      [
        'calls',
        'tells',
        'observes',
        'remarks',
        'inquires',
        'interrupts',
        'repeats',
        'insists',
        'agrees',
        'declares',
        'protests',
        'explains',
        'urges',
        'warns',
        'admits',
        'suggests',
        'announces',
      ],
      v(),
    ),
    responds: REPLY,
    ...each(['continues', 'resumes'], CONTINUES),
    retorts: { tone: 'angry', reply: true },
    cries: v('excited'),
    exclaims: v('excited'),
    yells: v('shout'),
    screams: v('shout'),
    roars: v('shout'),
    sobs: v('sad'),
    sighs: v('tired'),
    laughs: v('happy'),
    chuckles: v('happy'),
    snaps: v('angry'),
    growls: v('angry'),
    snarls: v('angry'),
    hisses: v('angry'),
    pleads: v('pleading'),
    begs: v('pleading'),
    teases: v('mocking'),
    sneers: v('mocking'),
    mocks: v('mocking'),
    gasps: v('fearful'),
    stammers: v('fearful'),
    demands: v('urgent'),
    // Present-tense first person: "“Where?” I ask." (see verbAt).
    ...each(
      [
        'ask',
        'reply',
        'answer',
        'tell',
        'add',
        'continue',
        'insist',
        'explain',
        'agree',
        'repeat',
        'protest',
        'call',
      ],
      bare(),
    ),
    ...each(['whisper', 'murmur', 'mutter'], bare('whisper')),
    ...each(['shout', 'yell', 'scream'], bare('shout')),
    cry: bare('excited'),
    sigh: bare('tired'),
    laugh: bare('happy'),
    snap: bare('angry'),
    beg: bare('pleading'),
    plead: bare('pleading'),
    gasp: bare('fearful'),
    demand: bare('urgent'),
    think: { thought: true, bare: true },
    wonder: { thought: true, bare: true },
  },
  es: {
    ...each(
      [
        'dijo',
        'dice',
        'preguntó',
        'pregunta',
        'observó',
        'manifestó',
        'insistió',
        'afirmó',
        'declaró',
        'explicó',
        'contó',
        'llamó',
        'interrumpió',
        'concluyó',
        'advirtió',
        'indicó',
        'aseguró',
        'protestó',
        'objetó',
        'señaló',
        'repitió',
        'pidió',
        'inquirió',
        'comentó',
        'intervino',
        'terció',
        'ordenó',
        'sugirió',
      ],
      v(),
    ),
    ...each(
      ['respondió', 'responde', 'contestó', 'contesta', 'replicó', 'replica', 'repuso'],
      REPLY,
    ),
    ...each(['añadió', 'añade', 'agregó', 'continuó', 'prosiguió', 'siguió'], CONTINUES),
    exclamó: v('excited'),
    exclama: v('excited'),
    gritó: v('shout'),
    grita: v('shout'),
    chilló: v('shout'),
    vociferó: v('shout'),
    murmuró: v('whisper'),
    murmura: v('whisper'),
    susurró: v('whisper'),
    susurra: v('whisper'),
    musitó: v('whisper'),
    masculló: v('whisper'),
    sollozó: v('sad'),
    suspiró: v('tired'),
    rió: v('happy'),
    gruñó: v('angry'),
    espetó: v('angry'),
    suplicó: v('pleading'),
    rogó: v('pleading'),
    balbuceó: v('fearful'),
    tartamudeó: v('fearful'),
    pensó: THOUGHT,
    piensa: THOUGHT,
    reflexionó: THOUGHT,
    // Imperfects, which may be the teller's own ("yo decía").
    decía: anyPerson(v()),
    preguntaba: anyPerson(v()),
    respondía: anyPerson(REPLY),
    contestaba: anyPerson(REPLY),
    pensaba: anyPerson(THOUGHT),
    // First person, so pro-drop tags ("—Hola —dije.") name the teller. Never "grito" or
    // "susurro", which are also nouns ("se oyó un grito").
    ...each(
      [
        'dije',
        'pregunté',
        'respondí',
        'contesté',
        'repliqué',
        'repuse',
        'añadí',
        'continué',
        'proseguí',
        'expliqué',
        'insistí',
        'afirmé',
        'declaré',
        'conté',
        'llamé',
        'interrumpí',
        'agregué',
        'concluí',
        'advertí',
        'aseguré',
        'protesté',
        'objeté',
        'señalé',
        'comenté',
        'admití',
        'confesé',
        'ordené',
        'propuse',
        'sugerí',
        'corregí',
        'mentí',
        'observé',
        // present-tense narration
        'digo',
        'pregunto',
        'respondo',
        'contesto',
        'replico',
        'añado',
        'continúo',
        'explico',
        'insisto',
      ],
      firstPerson(),
    ),
    exclamé: firstPerson('excited'),
    exclamo: firstPerson('excited'),
    grité: firstPerson('shout'),
    chillé: firstPerson('shout'),
    murmuré: firstPerson('whisper'),
    murmuro: firstPerson('whisper'),
    susurré: firstPerson('whisper'),
    musité: firstPerson('whisper'),
    sollocé: firstPerson('sad'),
    suspiré: firstPerson('tired'),
    supliqué: firstPerson('pleading'),
    rogué: firstPerson('pleading'),
    balbuceé: firstPerson('fearful'),
    gruñí: firstPerson('angry'),
    reí: firstPerson('happy'),
    pensé: { thought: true, firstPerson: true },
    pienso: { thought: true, firstPerson: true },
  },
};

/** Adverbs that colour the tone of a tagged line. */
export const ADVERB_TONES: Record<Lang, Record<string, ToneLabel>> = {
  en: {
    angrily: 'angry',
    sadly: 'sad',
    softly: 'whisper',
    quietly: 'whisper',
    loudly: 'shout',
    impatiently: 'urgent',
    eagerly: 'excited',
    tenderly: 'tender',
    gently: 'tender',
    sarcastically: 'sarcastic',
    wearily: 'tired',
    fearfully: 'fearful',
    happily: 'happy',
  },
  es: {
    riendo: 'happy',
    sonriendo: 'happy',
    llorando: 'sad',
    enfadado: 'angry',
    enojado: 'angry',
    tristemente: 'sad',
    impaciente: 'urgent',
    impacientemente: 'urgent',
    suavemente: 'tender',
    irónicamente: 'sarcastic',
  },
};

export const TITLES: Record<Lang, Record<string, Gender | undefined>> = {
  en: {
    'Mr.': 'male',
    Mr: 'male',
    'Mrs.': 'female',
    Mrs: 'female',
    Miss: 'female',
    'Ms.': 'female',
    Ms: 'female',
    Lady: 'female',
    Lord: 'male',
    Sir: 'male',
    Master: 'male',
    Mister: 'male',
    'Dr.': undefined,
    Dr: undefined,
    Captain: undefined,
    Colonel: undefined,
    Madam: 'female',
    Madame: 'female',
    Aunt: 'female',
    Uncle: 'male',
    'St.': undefined,
    'Col.': undefined,
    'Capt.': undefined,
    'Gen.': undefined,
    'Lt.': undefined,
    'Sgt.': undefined,
    'Rev.': undefined,
    'Prof.': undefined,
    'Mme.': 'female',
    Mme: 'female',
    'Mlle.': 'female',
    Mlle: 'female',
  },
  es: {
    Don: 'male',
    don: 'male',
    Doña: 'female',
    doña: 'female',
    'Sr.': 'male',
    'Sra.': 'female',
    'Srta.': 'female',
    Señor: 'male',
    Señora: 'female',
    Señorita: 'female',
    'D.': 'male',
    'Dña.': 'female',
    Tía: 'female',
    Tío: 'male',
    'Dr.': 'male',
    Dr: 'male',
    'Dra.': 'female',
    Dra: 'female',
  },
};

export const DETERMINERS: Record<Lang, Record<string, Gender | undefined>> = {
  en: {
    the: undefined,
    his: undefined,
    her: undefined,
    their: undefined,
    my: undefined,
    a: undefined,
    an: undefined,
    our: undefined,
    your: undefined,
    this: undefined,
    that: undefined,
  },
  es: {
    el: 'male',
    la: 'female',
    un: 'male',
    una: 'female',
    al: 'male',
    del: 'male',
    su: undefined,
    aquel: 'male',
    aquella: 'female',
    este: 'male',
    esta: 'female',
    ese: 'male',
    esa: 'female',
    mi: undefined,
  },
};

/** Nouns that can name a speaker ("his wife", "el viajero"), with their gender when fixed. */
export const SPEAKER_NOUNS: Record<Lang, Record<string, Gender | undefined>> = {
  en: {
    man: 'male',
    woman: 'female',
    lady: 'female',
    wife: 'female',
    husband: 'male',
    girl: 'female',
    boy: 'male',
    gentleman: 'male',
    father: 'male',
    mother: 'female',
    son: 'male',
    daughter: 'female',
    brother: 'male',
    sister: 'female',
    aunt: 'female',
    uncle: 'male',
    king: 'male',
    queen: 'female',
    prince: 'male',
    princess: 'female',
    captain: undefined,
    doctor: undefined,
    friend: undefined,
    stranger: undefined,
    servant: undefined,
    child: undefined,
    officer: undefined,
    soldier: undefined,
    driver: undefined,
    host: undefined,
    hostess: 'female',
    guest: undefined,
    master: 'male',
    mistress: 'female',
    maid: 'female',
    voice: undefined,
    visitor: undefined,
    girlfriend: 'female',
    boyfriend: 'male',
    mom: 'female',
    dad: 'male',
    grandmother: 'female',
    grandfather: 'male',
    landlord: 'male',
    landlady: 'female',
    nurse: undefined,
    priest: 'male',
    nun: 'female',
    vicar: 'male',
    curate: 'male',
    housekeeper: 'female',
    innkeeper: undefined,
    butler: 'male',
    coachman: 'male',
    clerk: undefined,
    constable: undefined,
    inspector: undefined,
    sergeant: undefined,
    waiter: 'male',
    waitress: 'female',
    porter: undefined,
    attendant: undefined,
    mate: undefined,
    sailor: undefined,
    farmer: undefined,
    gardener: undefined,
    keeper: undefined,
    guard: undefined,
    boatman: 'male',
    ferryman: 'male',
    shopkeeper: undefined,
    governess: 'female',
    footman: 'male',
    niece: 'female',
    nephew: 'male',
    cousin: undefined,
    grandson: 'male',
    granddaughter: 'female',
  },
  es: {
    hombre: 'male',
    mujer: 'female',
    señor: 'male',
    señora: 'female',
    señorita: 'female',
    joven: undefined,
    viajero: 'male',
    viajera: 'female',
    doctor: 'male',
    doctora: 'female',
    médico: 'male',
    médica: 'female',
    ciego: 'male',
    ciega: 'female',
    niño: 'male',
    niña: 'female',
    muchacho: 'male',
    muchacha: 'female',
    padre: 'male',
    madre: 'female',
    hijo: 'male',
    hija: 'female',
    hermano: 'male',
    hermana: 'female',
    tío: 'male',
    tía: 'female',
    amigo: 'male',
    amiga: 'female',
    desconocido: 'male',
    desconocida: 'female',
    criado: 'male',
    criada: 'female',
    cocinero: 'male',
    cocinera: 'female',
    capitán: 'male',
    rey: 'male',
    reina: 'female',
    voz: undefined,
    anciano: 'male',
    anciana: 'female',
    chico: 'male',
    chica: 'female',
    viejo: 'male',
    vieja: 'female',
    amo: 'male',
    ama: 'female',
    guía: undefined,
    mozo: 'male',
    moza: 'female',
    caballero: 'male',
    dama: 'female',
    abuelo: 'male',
    abuela: 'female',
    cura: 'male',
    marido: 'male',
    esposa: 'female',
    esposo: 'male',
    extranjero: 'male',
    extranjera: 'female',
    cochero: 'male',
    posadero: 'male',
    posadera: 'female',
    sacristán: 'male',
    tabernero: 'male',
    tabernera: 'female',
    guardia: undefined,
    sargento: 'male',
    marinero: 'male',
    enfermero: 'male',
    enfermera: 'female',
    camarero: 'male',
    camarera: 'female',
    portero: 'male',
    portera: 'female',
    vecino: 'male',
    vecina: 'female',
    maestro: 'male',
    maestra: 'female',
    sobrino: 'male',
    sobrina: 'female',
    nieto: 'male',
    nieta: 'female',
    primo: 'male',
    prima: 'female',
    cuñado: 'male',
    cuñada: 'female',
    suegro: 'male',
    suegra: 'female',
  },
};

/** Speaker nouns whose grammatical gender says nothing about the speaker ("una voz"). */
export const EPICENE: Record<Lang, Set<string>> = {
  en: new Set(['voice']),
  es: new Set(['voz', 'persona', 'criatura', 'figura', 'sombra']),
};

/** "his voice", "su voz": a voice that has an owner never names a speaker. */
export const POSSESSIVE_DETERMINERS: Record<Lang, Set<string>> = {
  en: new Set(['his', 'her', 'their', 'my', 'your', 'our']),
  es: new Set(['su', 'sus', 'mi', 'mis', 'tu', 'tus']),
};

/** Subject pronouns; the first-person forms mean whoever tells the story. */
export const PRONOUNS: Record<Lang, Record<string, Gender | 'narrator'>> = {
  en: {
    he: 'male',
    she: 'female',
    I: 'narrator',
    'I’m': 'narrator',
    "I'm": 'narrator',
    'I’d': 'narrator',
    "I'd": 'narrator',
    'I’ll': 'narrator',
    "I'll": 'narrator',
    'I’ve': 'narrator',
    "I've": 'narrator',
  },
  es: { él: 'male', ella: 'female', yo: 'narrator', Yo: 'narrator' },
};

/**
 * Words that show narration is in the first person ("my", "me", "we"). English "I" counts only
 * before a lower-case word in the same sentence (see the heuristic's isFirstPersonToken).
 */
export const FIRST_PERSON_WORDS: Record<Lang, Set<string>> = {
  en: new Set([
    'me',
    'my',
    'My',
    'myself',
    'mine',
    'I’m',
    "I'm",
    'I’d',
    "I'd",
    'I’ve',
    "I've",
    'I’ll',
    "I'll",
    'we',
    'We',
    'us',
    'our',
    'Our',
    'ours',
    'ourselves',
  ]),
  es: new Set([
    'yo',
    'Yo',
    'me',
    'Me',
    'mi',
    'Mi',
    'mis',
    'Mis',
    'conmigo',
    'mí',
    'nosotros',
    'Nosotros',
    'nosotras',
    'Nosotras',
    'nos',
    'Nos',
    'nuestro',
    'Nuestro',
    'nuestra',
    'Nuestra',
    'nuestros',
    'nuestras',
  ]),
};

/** Someone else's reflexive object: "recovering herself" goes on with the same person. */
export const SELF_WORDS = new Set(['himself', 'herself', 'themselves']);

/** Reflexive objects that turn a speech verb into thought: "I told myself". */
export const REFLEXIVES: Record<Lang, Set<string>> = {
  en: new Set(['myself', 'himself', 'herself']),
  es: new Set([]),
};

/** Object pronouns that may come before a Spanish verb: "y le dijo", "me preguntó". */
export const CLITICS: Record<Lang, Set<string>> = {
  en: new Set([]),
  es: new Set(['me', 'te', 'se', 'le', 'les', 'lo', 'la', 'los', 'las', 'nos', 'os']),
};

/**
 * Words that may sit between a subject and its verb: "Ana le dijo", "I had said", "Tom then said".
 * Never "was": "Tom was told" is said to Tom, not by him.
 */
export const BEFORE_VERB_SKIP: Record<Lang, Set<string>> = {
  en: new Set([
    'had',
    'has',
    'have',
    'would',
    'could',
    'should',
    'will',
    'shall',
    'did',
    'then',
    'again',
    'just',
    'now',
    'also',
    'only',
    'still',
  ]),
  es: new Set([
    'me',
    'te',
    'se',
    'le',
    'les',
    'lo',
    'la',
    'los',
    'las',
    'nos',
    'os',
    'entonces',
    'luego',
    'ya',
    'también',
  ]),
};

/**
 * Adverbs a subject may have before its verb, besides the ones in -ly and in BEFORE_VERB_SKIP: "and
 * Anne too smiled", "and Anne almost cried", "and Anne herself opened", "y Nela todavía sonreía".
 * With no verb after them the words are a phrase of their own ("Mrs. Bennet first,", "and Anne
 * too,", "but Anne most warmly,").
 */
export const SUBJECT_ADVERBS: Record<Lang, Set<string>> = {
  en: new Set([
    'too',
    'first',
    'most',
    'even',
    'never',
    'always',
    'once',
    'already',
    'almost',
    'quite',
    'rather',
    'herself',
    'himself',
    'themselves',
    'itself',
  ]),
  es: new Set(['primero', 'todavía', 'aún', 'siempre', 'nunca', 'tampoco']),
};

/**
 * Words after a person that make a phrase with no verb, not a clause: "Anne at his side", "his wife
 * beside him", "Jane included", "su mujer detrás", "Ana incluida". (An article or a preposition
 * such as "at" or "de" ends an object anyway: see endsObject.)
 */
export const PHRASE_AFTER_PERSON: Record<Lang, Set<string>> = {
  en: new Set([
    'beside',
    'behind',
    'with',
    'without',
    'by',
    'under',
    'beneath',
    'among',
    'alongside',
    'ahead',
    'close',
    'next',
    'included',
    'excepted',
    'excluded',
    'aside',
    'apart',
  ]),
  es: new Set([
    'detrás',
    'delante',
    'junto',
    'cerca',
    'incluido',
    'incluida',
    'incluidos',
    'incluidas',
    'excepto',
    'salvo',
    'descalzo',
    'descalza',
    'descalzos',
    'descalzas',
  ]),
};

/**
 * Verbs of knowing or seeing that make a comment of a short clause with nothing after them: "Tom
 * hesitated, Anne noticed, and then said", "Tom hesitates, she thinks, and says", "Anne must have
 * seen, and said", "Pablo dudó, ella pensó, y luego dijo:", "ella lo nota, y luego dice:". With an
 * object it is no comment ("Anne saw it,", "Nela lo vio,").
 */
export const COMMENT_VERBS: Record<Lang, Set<string>> = {
  en: new Set([
    'thought',
    'noticed',
    'saw',
    'remembered',
    'recalled',
    'felt',
    'knew',
    'supposed',
    'believed',
    'fancied',
    'imagined',
    'guessed',
    'suspected',
    'heard',
    'realized',
    'realised',
    'feared',
    'hoped',
    'reckoned',
    'observed',
    'see',
    'notice',
    'notices',
    'think',
    'thinks',
    'know',
    'knows',
    'remember',
    'remembers',
    'tell',
    'seen',
    'known',
  ]),
  es: new Set([
    'pensó',
    'notó',
    'vio',
    'recordó',
    'sintió',
    'supo',
    'supuso',
    'creyó',
    'imaginó',
    'sospechó',
    'oyó',
    'nota',
    've',
    'oye',
    'siente',
    'piensa',
    'temió',
    'advirtió',
  ]),
};

/**
 * Set phrases a subject may have before its verb: "and Anne at last looked up and said", "I at
 * once got up", "y Lucía por fin apoya la cabeza y dice:".
 */
export const BEFORE_VERB_PAIRS: Record<Lang, Set<string>> = {
  en: new Set([
    'at last',
    'at once',
    'of course',
    'for once',
    'at length',
    'at first',
    'at least',
    'in turn',
    'in return',
    'by then',
    'in reply',
    'in answer',
  ]),
  es: new Set([
    'por fin',
    'al fin',
    'de pronto',
    'de repente',
    'de nuevo',
    'en seguida',
    'sin más',
    'al final',
    'por último',
    'de golpe',
    'de inmediato',
  ]),
};

/**
 * English verb forms with no "-ed" that pass for a finite verb after a subject: past forms such as
 * "rose" or "stood", and "was", "is", "can", "does" ("Anne rose and said", not "Anne pale").
 */
export const FINITE_FORMS = new Set([
  'arose',
  'awoke',
  'was',
  'were',
  'bore',
  'beat',
  'became',
  'began',
  'bent',
  'bit',
  'bled',
  'blew',
  'broke',
  'brought',
  'built',
  'burnt',
  'burst',
  'bought',
  'caught',
  'chose',
  'clung',
  'came',
  'crept',
  'cut',
  'dealt',
  'dug',
  'drew',
  'dreamt',
  'drank',
  'drove',
  'ate',
  'fell',
  'fed',
  'felt',
  'fought',
  'found',
  'fled',
  'flung',
  'flew',
  'forbade',
  'forgot',
  'forgave',
  'froze',
  'got',
  'gave',
  'went',
  'grew',
  'hung',
  'heard',
  'hid',
  'hit',
  'held',
  'hurt',
  'kept',
  'knelt',
  'knew',
  'laid',
  'led',
  'leapt',
  'learnt',
  'left',
  'lent',
  'let',
  'lay',
  'lit',
  'lost',
  'made',
  'meant',
  'met',
  'paid',
  'put',
  'quit',
  'read',
  'rode',
  'rang',
  'rose',
  'ran',
  'said',
  'saw',
  'sought',
  'sold',
  'sent',
  'set',
  'shook',
  'shone',
  'shot',
  'shrank',
  'shut',
  'sang',
  'sank',
  'sat',
  'slept',
  'slid',
  'slung',
  'spoke',
  'sped',
  'spent',
  'spun',
  'spat',
  'split',
  'spread',
  'sprang',
  'stood',
  'stole',
  'stuck',
  'stung',
  'strode',
  'struck',
  'swore',
  'swept',
  'swam',
  'swung',
  'took',
  'taught',
  'tore',
  'told',
  'thought',
  'threw',
  'thrust',
  'trod',
  'understood',
  'woke',
  'wore',
  'wept',
  'won',
  'wrung',
  'wrote',
  'withdrew',
  'overheard',
  'overtook',
  'bade',
  'wove',
  'strove',
  'smote',
  'stank',
  'slunk',
  'beheld',
  'withheld',
  'upheld',
  'foresaw',
  'mistook',
  'forsook',
  'undertook',
  'overcame',
  'undid',
  'overthrew',
  'dwelt',
  'spelt',
  'leant',
  'is',
  'are',
  'am',
  'does',
  'goes',
  'can',
  'cannot',
  'may',
  'might',
  'must',
  'do',
]);

/**
 * English past forms that are also nouns or adjectives: a verb right after a subject with more of
 * the stretch after it ("Anne cast a glance at him,", "Anne shed a tear,"), but not inside a phrase
 * ("Anne with a wound on her arm,", "Anne with the spilt tea on her apron,", "with a slew of").
 */
export const NOUN_LIKE_PASTS = new Set([
  'cast',
  'bid',
  'wound',
  'bound',
  'ground',
  'strung',
  'knit',
  'bet',
  'shed',
  'smelt',
  'spilt',
  'spoilt',
  'slew',
]);

/** English auxiliaries in BEFORE_VERB_SKIP: after one a finite verb goes on ("Anne could not"). */
export const AUXILIARIES = new Set([
  'had',
  'has',
  'have',
  'would',
  'could',
  'should',
  'will',
  'shall',
  'did',
]);

/**
 * Third-person Spanish preterites with no regular ending: "su madre se puso pálida, y dijo", "Nela
 * hizo una pausa, y dijo".
 */
export const STRONG_PRETERITES = new Set([
  'dio',
  'dieron',
  'fue',
  'fueron',
  'hizo',
  'hicieron',
  'puso',
  'pusieron',
  'tuvo',
  'tuvieron',
  'vino',
  'vinieron',
  'estuvo',
  'estuvieron',
  'quiso',
  'quisieron',
  'supo',
  'supieron',
  'pudo',
  'pudieron',
  'trajo',
  'trajeron',
  'dijo',
  'dijeron',
  'vio',
  'vieron',
  'anduvo',
  'anduvieron',
  'hubo',
  'deshizo',
  'rehízo',
  'propuso',
  'dispuso',
  'repuso',
  'compuso',
  'mantuvo',
  'detuvo',
  'obtuvo',
  'contuvo',
  'sostuvo',
  'retuvo',
  'intervino',
  'condujo',
  'produjo',
  'tradujo',
  'rio',
  'rieron',
]);

/**
 * English verbs of perceiving before "that" and someone else's subject: "I noticed that Anne looked
 * away" (not "I knew that Tom was right", "the coat that Anne gave me").
 */
export const PERCEIVING = new Set([
  'noticed',
  'saw',
  'watched',
  'heard',
  'observed',
  'felt',
  'sensed',
  'spotted',
  'glimpsed',
  'see',
  'sees',
  'notice',
  'notices',
  'watch',
  'watches',
  'hear',
  'hears',
]);

/**
 * Spanish verbs of seeing or hearing someone after a clitic, or as an infinitive with one: in "y
 * cuando Pablo la vio, exclamó:" or "y al verla Pablo, exclamó:" Pablo speaks.
 */
export const SEEING_VERBS = new Set([
  'vio',
  'vieron',
  'veía',
  'veían',
  'miró',
  'miraron',
  'miraba',
  'miraban',
  'divisó',
  'descubrió',
  'reconoció',
  'encontró',
  'oyó',
  'oyeron',
  'oía',
  'sintió',
  'notó',
  'distinguió',
  'vislumbró',
  'escuchó',
  'escucharon',
  'escuchaba',
  'observó',
  'contempló',
  've',
  'ven',
  'mira',
  'miran',
  'oye',
  'oyen',
  'escucha',
  'descubre',
  'reconoce',
  'encuentra',
  'siente',
  'distingue',
  'observa',
  'contempla',
  'nota',
]);
export const SEEING_INFINITIVES = new Set([
  'ver',
  'mirar',
  'divisar',
  'descubrir',
  'reconocer',
  'encontrar',
  'oír',
  'sentir',
  'notar',
  'escuchar',
  'observar',
  'contemplar',
]);

/** Words before "himself" or "herself" in an aside that keeps the speaker: "recovering herself". */
export const RECOVERY_WORDS = new Set([
  'recovering',
  'collecting',
  'composing',
  'correcting',
  'checking',
  'catching',
]);

/** Spanish gerunds of the same kind: "reponiéndose", "recobrándose", "serenándose". */
export const RECOVERY_GERUNDS =
  /^(?:repon|recobr|rehac|corrig|sobrepon|seren|domin|conteni|recompon)\p{L}*ndose$/u;

/** Question words: someone who asks with one does not answer ("Mary wanted to know where"). */
export const WH_WORDS: Record<Lang, Set<string>> = {
  en: new Set(['what', 'why', 'how', 'who', 'where', 'when', 'which']),
  es: new Set(['qué', 'quién', 'cómo', 'dónde', 'adónde', 'cuándo', 'cuál']),
};

/** Tag verbs that ask: a reply after one answers the line ("“Where?” asked Tom, and he answered:"). */
export const ASKING_VERBS: Record<Lang, Set<string>> = {
  en: new Set([
    'asked',
    'asks',
    'ask',
    'inquired',
    'enquired',
    'demanded',
    'queried',
    'questioned',
  ]),
  es: new Set(['preguntó', 'pregunta', 'preguntaba', 'pregunté', 'inquirió', 'interrogó']),
};

/** Lead words before someone who comes in: "Suddenly Anne came in", "De pronto entró Ana". */
export const ENTRY_LEADS: Record<Lang, Set<string>> = {
  en: new Set(['suddenly', 'just', 'soon', 'presently', 'finally']),
  es: new Set(['pronto', 'repente']),
};

/** Adverbs of a habit before a verb of arriving: "She usually came in the evening". */
export const HABIT_ADVERBS = new Set([
  'usually',
  'only',
  'generally',
  'normally',
  'rarely',
  'seldom',
  'occasionally',
  'frequently',
  'regularly',
  'typically',
  'invariably',
  'habitually',
  'customarily',
  'nightly',
  'daily',
]);

/** Words after "appeared" when someone arrives, not when they look a way ("She appeared tired"). */
export const APPEARING_WHERE = new Set([
  'at',
  'in',
  'on',
  'before',
  'outside',
  'by',
  'from',
  'through',
  'round',
  'around',
  'again',
  'back',
  'here',
  'there',
  'home',
  'out',
  'up',
  'beside',
  'behind',
  'inside',
  'late',
  'early',
  'after',
  'with',
  'unannounced',
]);

/** Nouns after "that" in a phrase of time, not a clause: "said so early that morning". */
export const TIME_AFTER_THAT = new Set([
  'morning',
  'afternoon',
  'evening',
  'night',
  'day',
  'week',
  'month',
  'year',
  'time',
  'summer',
  'winter',
  'spring',
  'autumn',
  'moment',
  'hour',
  'minute',
  'very',
  'same',
]);

/**
 * Words that make a "nada" after a speech verb what was said, like a negation: "Apenas dijo nada
 * en toda la tarde", "Ninguno de los dos respondió nada en todo el camino".
 */
export const NADA_NEGATIONS = new Set([
  'apenas',
  'ninguno',
  'ninguna',
  'ningún',
  'ningunos',
  'ningunas',
  'sin',
]);

/**
 * Adverbs of frequency that may sit between a subject and an English -s form: "she always tells
 * me", "Mom never calls". (Ones in -ly, such as "usually", are skipped anyway.)
 */
export const FREQUENCY_ADVERBS = new Set([
  'always',
  'never',
  'often',
  'sometimes',
  'ever',
  'even',
  'seldom',
  'forever',
]);

/**
 * Words of endearment after a name the line is said to: "Anne dear", "Tom my boy", "Ana mía", "Ana
 * preciosa", "Ana de mi alma".
 */
export const ENDEARMENTS: Record<Lang, Set<string>> = {
  en: new Set([
    'dear',
    'darling',
    'dearest',
    'my',
    'love',
    'sweetheart',
    'honey',
    'sweetie',
    'dearie',
    'boy',
    'girl',
    'lad',
    'lass',
  ]),
  es: new Set([
    'mío',
    'mía',
    'querido',
    'querida',
    'guapo',
    'guapa',
    'lindo',
    'linda',
    'bonito',
    'bonita',
    'precioso',
    'preciosa',
    'hermoso',
    'hermosa',
    'bello',
    'bella',
    'amado',
    'amada',
    'adorado',
    'adorada',
    'niño',
    'niña',
    'de',
    'del',
    'mi',
    'alma',
    'vida',
    'corazón',
    'cariño',
    'amor',
    'cielo',
    'tesoro',
  ]),
};

/** Words that may sit between a verb and its inverted subject: "dijo entonces el doctor". */
export const AFTER_VERB_SKIP: Record<Lang, Set<string>> = {
  en: new Set(['then', 'again', 'now']),
  es: new Set(['entonces', 'luego', 'después', 'también', 'ya', 'finalmente']),
};

/** Two-word adverbs that may follow a verb: "said at last", "dijo de pronto". */
export const AFTER_VERB_PAIRS: Record<Lang, Set<string>> = {
  en: new Set(['at last', 'at once']),
  es: new Set(['de pronto', 'al fin', 'por fin', 'de nuevo', 'otra vez']),
};

/**
 * Words that may open a sentence before its subject: "Then Anne said", "Tom shrugged, so Anne
 * picked up the bag and said", "Entonces la anciana".
 */
export const SENTENCE_LEADS: Record<Lang, Set<string>> = {
  en: new Set(['then', 'now', 'at', 'last', 'and', 'but', 'so']),
  es: new Set(['entonces', 'luego', 'después', 'al', 'fin', 'y', 'pero']),
};

/** Prepositions after which a name is a place or an absent person, not someone present. */
export const NON_PARTICIPANT_PREPOSITIONS: Record<Lang, Set<string>> = {
  en: new Set([
    'in',
    'at',
    'on',
    'into',
    'onto',
    'from',
    'of',
    'near',
    'towards',
    'toward',
    'about',
    'for',
    'upon',
    'across',
    'through',
    'past',
    'beyond',
  ]),
  es: new Set(['en', 'de', 'del', 'desde', 'hacia', 'sobre', 'por', 'para', 'hasta']),
};

/** Prepositions that mark the person spoken to: "said to Anne", "le dijo a Ana", "preguntó al ciego". */
export const ADDRESSEE_MARKERS: Record<Lang, Set<string>> = {
  en: new Set(['to']),
  es: new Set(['a', 'al']),
};

/**
 * Words that open a question clause: a question word, or an auxiliary before its subject ("What
 * could I say?", "Had I said too much?", "Por qué le dije eso?"). A tag's clause opens with none
 * of them, so a question after it is a clause of its own: "“I’m fine,” I said, but was I?", "I
 * said, because what else could I say?"
 */
export const QUESTION_OPENERS: Record<Lang, Set<string>> = {
  en: new Set([
    'what',
    'why',
    'how',
    'who',
    'whom',
    'where',
    'when',
    'which',
    'whose',
    'do',
    'does',
    'did',
    'can',
    'could',
    'shall',
    'should',
    'will',
    'would',
    'may',
    'might',
    'must',
    'had',
    'has',
    'have',
    'was',
    'were',
    'is',
    'are',
    'am',
    "don't",
    "doesn't",
    "didn't",
    "can't",
    "couldn't",
    "shan't",
    "shouldn't",
    "won't",
    "wouldn't",
    "mustn't",
    "hadn't",
    "hasn't",
    "haven't",
    "wasn't",
    "weren't",
    "isn't",
    "aren't",
  ]),
  es: new Set([
    'qué',
    'por',
    'cómo',
    'cuándo',
    'dónde',
    'quién',
    'quiénes',
    'cuál',
    'cuáles',
    'cuánto',
    'cuánta',
    'cuántos',
    'cuántas',
  ]),
};

/**
 * Words that join a clause of its own after a comma or a pause, such as a question after a tag:
 * "“I’m fine,” I said, but was I?", "Tom said, because what else could he say?", "—dijo, porque
 * qué más podía decir?"
 */
export const CONJUNCTIONS: Record<Lang, Set<string>> = {
  en: new Set([
    'and',
    'but',
    'or',
    'for',
    'yet',
    'so',
    'though',
    'although',
    'because',
    'since',
    'as',
  ]),
  es: new Set(['y', 'e', 'pero', 'o', 'u', 'aunque', 'porque', 'pues']),
};

/** Words that may come before a question clause's opener: "And had I said too much?" */
export const QUESTION_JOINS: Record<Lang, Set<string>> = {
  en: new Set(['and', 'but', 'or', 'so']),
  es: new Set(['y', 'e', 'pero', 'o', 'u']),
};

/** "I turned to her and said": a verb after one of these shares the clause's subject. */
export const COORDINATORS: Record<Lang, Set<string>> = {
  en: new Set(['and']),
  es: new Set(['y', 'e']),
};

/** Subject pronouns of someone else: in "I suppose she sighed and said", "said" is hers. */
export const OTHER_SUBJECTS: Record<Lang, Set<string>> = {
  en: new Set(['he', 'she', 'they']),
  es: new Set(['él', 'ella', 'ellos', 'ellas']),
};

/**
 * Words that start a clause of its own. In English a name right after one is that clause's
 * subject ("I think Mrs. Bennet turned and said"); Spanish drops the subject, so there the word
 * alone starts one ("Yo creo que se volvía y le decía", "Yo no sé si la cocinera suspiraba").
 */
export const CLAUSE_LEADS: Record<Lang, Set<string>> = {
  en: new Set([
    'that',
    'when',
    'while',
    'as',
    'until',
    'because',
    'if',
    'though',
    'although',
    'think',
    'thought',
    'suppose',
    'believe',
    'remember',
    'guess',
    'imagine',
    'hope',
    'know',
    'knew',
    'fear',
    'sure',
    'say',
  ]),
  es: new Set(['que', 'si', 'cuando', 'mientras', 'porque', 'aunque']),
};

/**
 * Pronouns that are a person the reader can see as a subject. Spanish drops the subject, so after
 * "si" (or "como cuando", "como que") only such a word, a name or a speaker descriptor makes a
 * clause of its own ("Yo no sé si ella suspiraba y le decía", "si la cocinera suspiraba"); a
 * thing, a clitic before a verb or nothing makes none ("si la sopa estaba lista", "como si la
 * viera", "a ver si llovía", "por si acaso").
 */
export const SUBJECT_STARTS: Record<Lang, Set<string>> = {
  en: new Set<string>(),
  es: new Set(['él', 'ella', 'ellos', 'ellas', 'alguien', 'nadie']),
};

/**
 * The teller's own verbs that take a clause, in the present, and modals: after "I suppose" or "I
 * must" a later "and said" is the clause's, even when its subject cannot be seen ("I suppose the
 * cook sighed and said"). After a past verb it is the teller's ("I thought for a moment and said",
 * "I could not help laughing and said"), and so is a present "and say" or a past modal ("I must
 * have blushed and said").
 */
export const AUTHORIAL_VERBS = new Set([
  'suppose',
  'daresay',
  'dare',
  'believe',
  'think',
  'fancy',
  'hear',
  'imagine',
  'guess',
  'reckon',
  'expect',
  'know',
  'say',
  'confess',
  'admit',
  'own',
  'trust',
  'hope',
  'fear',
  'doubt',
  'see',
  'understand',
  'gather',
  'remember',
  'recall',
  'feel',
  'find',
  'suspect',
  'presume',
  'assume',
  'need',
  'tell',
  'warrant',
  'swear',
  'grant',
  'wonder',
  'wish',
  'regret',
  'declare',
  'venture',
  'am',
  'must',
  'will',
  'shall',
  'may',
  'might',
  'can',
  'cannot',
  "can't",
  "won't",
  "shan't",
  'would',
  "wouldn't",
  'should',
  "shouldn't",
]);

/**
 * Verbs of saying after which "would" is the teller's comment ("I would add that the cook…");
 * before other verbs it is the teller's own past ("I would not look at him and said").
 */
export const SAYING_VERBS = new Set([
  'add',
  'say',
  'think',
  'imagine',
  'guess',
  'suppose',
  'venture',
  'admit',
  'confess',
  'swear',
  'wager',
  'bet',
]);

/**
 * Words that open a clause the teller's "I" may be the subject of without governing the verb
 * after it: "I think, when I was young, the cook sighed and said", "I turned to Uncle Abel, who I
 * suppose had heard it all before, and said".
 */
export const SUBORDINATORS = new Set([
  'who',
  'whom',
  'whose',
  'which',
  'when',
  'whenever',
  'while',
  'as',
  'until',
  'till',
  'because',
  'if',
  'though',
  'although',
  'since',
  'before',
  'after',
  'unless',
  'once',
]);

/** Words that may sit between "I" and such a verb: "I really believe", "I do not doubt". */
export const AUTHORIAL_SKIP = new Set([
  'do',
  "don't",
  'not',
  'never',
  'also',
  'only',
  'still',
  'just',
  'even',
  'well',
  'rather',
  'quite',
  'almost',
  'seem',
  'to',
]);

/**
 * Words that open an aside about what someone says, which tags no line: "Mrs. Bennet, as my aunt
 * told me, was nervous", "or so I was told", "como nos dice el refrán".
 */
export const ASIDES: Record<Lang, string[][]> = {
  en: [['as'], ['or', 'so']],
  es: [['como'], ['según'], ['o', 'eso']],
};

/**
 * Objects that make a speech verb report what was said rather than tag a line: "She nodded and
 * said goodbye.", "He said nothing.", "said good night", "Ella asintió y dijo adiós.", "dijo que
 * sí".
 */
export const REPORTED_OBJECTS: Record<Lang, Set<string>> = {
  en: new Set([
    'nothing',
    'something',
    'anything',
    'everything',
    'goodbye',
    'good-bye',
    'goodnight',
    'good',
    'hello',
    'yes',
    'no',
    'so',
    'sorry',
    'thanks',
    'grace',
    'amen',
  ]),
  es: new Set([
    'nada',
    'algo',
    'adiós',
    'hola',
    'buenas',
    'buenos',
    'gracias',
    'amén',
    'que',
    'sí',
  ]),
};

/** Words that deny a verb: "No dije nada", "I did not see Anne until the next day." */
export const NEGATIONS: Record<Lang, Set<string>> = {
  en: new Set(['not', 'never', 'no', 'nobody', 'nothing']),
  es: new Set(['no', 'nunca', 'jamás', 'tampoco', 'ni', 'nadie']),
};

/**
 * A word after "algo" that tells the speaker's state, so "algo" means "somewhat": "dije algo
 * nervioso", "contestó algo molesta", "respondieron algo asustados". A feminine or plural
 * participle or "-oso" adjective, or a word for a mood. "algo extraño", "algo divertido" and "algo
 * ininteligible" are what was said, and so may be a masculine "algo molesto" or "algo confuso".
 */
export const SPEAKER_STATE =
  /^(?:\p{Ll}{3,}(?:ad|id|os)(?:a|as|os)|(?:nervios|asustad|cansad|preocupad|sorprendid|avergonzad|inquiet|alterad|irritad|apenad|desconcertad|turbad|intranquil|aturdid|cohibid|ofendid|enfadad|enojad|emocionad|perplej)(?:o|a|os|as)|(?:molest|confus)(?:a|as|os)|impacientes?)$/u;

/** Objects that may follow an English base-form tag: "I tell him." */
export const BARE_OBJECTS = new Set(['him', 'her', 'them', 'you', 'it', 'us']);

/** Auxiliaries that come before "I" in a question, which is never a tag: "Should I tell Dad?" */
export const QUESTION_AUXILIARIES = new Set([
  'do',
  'does',
  'did',
  'can',
  'could',
  'shall',
  'should',
  'will',
  'would',
  'may',
  'might',
  'must',
  "don't",
  "doesn't",
  "didn't",
  "can't",
  "couldn't",
  "shan't",
  "shouldn't",
  "won't",
  "wouldn't",
  "mustn't",
]);

/**
 * Words before such an auxiliary that still make a question ("What do I tell Mom?", "And can I
 * ask?"). After other words the order is only emphatic: "Only then did I tell him."
 */
export const QUESTION_LEADS = new Set([
  'what',
  'why',
  'how',
  'who',
  'whom',
  'where',
  'when',
  'which',
  'whose',
  'and',
  'but',
  'or',
  'so',
]);

/**
 * Prepositions and quantifiers after which an English -s form is a plural noun, even when one
 * opens a sentence and looks like a name: "between sobs", "Amid laughs", "Two calls came."
 */
export const NOUN_LEADS = new Set([
  'about',
  'above',
  'after',
  'against',
  'amid',
  'amidst',
  'among',
  'amongst',
  'around',
  'at',
  'before',
  'behind',
  'below',
  'beneath',
  'beside',
  'between',
  'beyond',
  'by',
  'despite',
  'during',
  'for',
  'from',
  'in',
  'into',
  'like',
  'near',
  'of',
  'on',
  'over',
  'past',
  'through',
  'throughout',
  'to',
  'toward',
  'towards',
  'under',
  'until',
  'upon',
  'with',
  'within',
  'without',
  'all',
  'any',
  'both',
  'few',
  'many',
  'more',
  'most',
  'no',
  'several',
  'some',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
]);

/** Words that open a chapter heading. */
export const HEADING_WORDS =
  /^(chapter|part|book|prologue|epilogue|stave|cap[ií]tulo|parte|libro|pr[oó]logo|ep[ií]logo)(?!\p{L})/iu;

/** "In the evening", "Por la tarde": time has passed, so the scene before is over. */
export const TIME_SHIFTS: Record<Lang, string[][]> = {
  en: [
    ['later'],
    ['next', 'day'],
    ['next', 'morning'],
    ['next', 'evening'],
    ['next', 'night'],
    ['next', 'afternoon'],
    ['that', 'evening'],
    ['that', 'night'],
    ['in', 'the', 'evening'],
  ],
  es: [
    ['más', 'tarde'],
    ['al', 'día', 'siguiente'],
    ['el', 'día', 'siguiente'],
    ['la', 'mañana', 'siguiente'],
    ['la', 'noche', 'siguiente'],
    ['la', 'tarde', 'siguiente'],
    ['esa', 'noche'],
    ['aquella', 'noche'],
    ['por', 'la', 'tarde'],
    ['por', 'la', 'noche'],
  ],
};

/** Prepositions before a time that ends a wait: "I did not see Anne until the next day." */
export const UNTIL: Record<Lang, Set<string>> = {
  en: new Set(['until', 'till']),
  es: new Set(['hasta']),
};

/** Words that count the time before "later" when three come before it: "A few days later". */
export const TIME_COUNTS: Record<Lang, Set<string>> = {
  en: new Set([
    'a',
    'an',
    'few',
    'some',
    'several',
    'many',
    'two',
    'three',
    'four',
    'five',
    'ten',
    'days',
    'hours',
    'weeks',
    'months',
    'years',
    'nights',
    'time',
  ]),
  es: new Set([
    'unos',
    'unas',
    'pocos',
    'pocas',
    'dos',
    'tres',
    'cuatro',
    'cinco',
    'varios',
    'varias',
    'algunos',
    'algunas',
    'días',
    'horas',
    'semanas',
    'meses',
    'años',
    'noches',
    'tiempo',
  ]),
};

/**
 * Verbs of someone arriving: after "She arrived that evening." or "Llegó por la tarde." the
 * scene changes for her (see timeLaterInSentence), not after "She baked bread in the evening",
 * "She was leaving the next day" or "Trabajaba hasta tarde esa noche".
 */
export const ARRIVALS: Record<Lang, Set<string>> = {
  en: new Set([
    'arrived',
    'came',
    'knocked',
    'appeared',
    'returned',
    'visited',
    'showed',
    'called',
  ]),
  es: new Set([
    'llegó',
    'vino',
    'apareció',
    'volvió',
    'regresó',
    'entró',
    'llamó',
    'visitó',
    'presentó',
  ]),
};

/** English verbs of arriving after "did not": "Anne did not come down until that evening". */
export const ARRIVING = new Set(['come', 'arrive', 'appear', 'return', 'show', 'turn']);

/** Verbs of coming in after an entry lead: "Suddenly Anne burst in", "De repente irrumpió Ana". */
export const ENTERING: Record<Lang, Set<string>> = {
  en: new Set(['walked', 'burst', 'rushed', 'ran', 'stepped', 'hurried', 'entered', 'strode']),
  es: new Set(['irrumpió', 'asomó']),
};

/** Verbs of being there before a word of place: "Suddenly Anne was there", "De pronto estaba allí". */
export const BEING_THERE: Record<Lang, Set<string>> = {
  en: new Set(['was', 'stood', 'sat']),
  es: new Set(['estaba', 'apareció']),
};
export const THERE: Record<Lang, Set<string>> = {
  en: new Set(['there', 'here', 'in', 'at', 'on', 'by', 'beside']),
  es: new Set(['allí', 'ahí', 'aquí', 'en', 'junto']),
};

/** Verbs of leaving and of sending someone away: "Anne had gone", "I had sent Anne", "Mandé a Ana". */
export const LEAVING: Record<Lang, Set<string>> = {
  en: new Set(['went', 'left', 'gone', 'headed']),
  es: new Set(['fue', 'salió', 'bajó', 'subió', 'ido', 'marchó']),
};
export const SENDING: Record<Lang, Set<string>> = {
  en: new Set(['sent']),
  es: new Set(['mandé', 'mandó', 'envié', 'envió', 'mandado', 'enviado']),
};

/** Nouns of a state, not a place, after "appeared": "She appeared in better spirits". */
export const STATE_NOUNS = new Set([
  'spirits',
  'mood',
  'humour',
  'humor',
  'health',
  'verge',
  'sorts',
  'dream',
  'dreams',
  'tears',
  'distress',
  'pain',
  'trouble',
  'doubt',
  'thought',
]);

/** Words after "knocked", "showed" or "called" that make them arriving: "knocked twice". */
export const KNOCKING_WHERE = new Set([
  'on',
  'at',
  'upon',
  'twice',
  'again',
  'round',
  'by',
  'in',
  'for',
  'up',
  'early',
  'late',
  'after',
  'before',
]);

/** Nouns after "came to a" or "arrived at a" that are no arrival: "She came to a decision". */
export const DECISION_NOUNS = new Set([
  'decision',
  'conclusion',
  'understanding',
  'agreement',
  'end',
  'halt',
  'stop',
]);

/** Infinitives after "volvió a" or "regresó a" that come to someone: "Regresó a recogerlas". */
export const FETCHING = new Set([
  'venir',
  'aparecer',
  'entrar',
  'visitar',
  'buscar',
  'recoger',
  'despedir',
]);

/** Time shifts that only compare, so no time passes: "later than usual", "más tarde que nunca". */
export const TIME_COMPARISONS: Record<Lang, string[][]> = {
  en: [['later', 'than']],
  es: [['más', 'tarde', 'que']],
};

/** Words before "later" or "más tarde" that keep the scene: "A moment later", "Poco más tarde". */
export const SHORT_PAUSES: Record<Lang, Set<string>> = {
  en: new Set(['moment', 'moments', 'minute', 'minutes', 'second', 'seconds', 'instant', 'little']),
  es: new Set([
    'momento',
    'momentos',
    'minuto',
    'minutos',
    'segundo',
    'segundos',
    'instante',
    'instantes',
    'poco',
  ]),
};

/**
 * Auxiliaries after which the person before them is talked about rather than coming in: "and Anne
 * had promised to come", "Anne would come later", "y Ana había prometido venir".
 */
export const OFFSTAGE_AUXILIARIES: Record<Lang, Set<string>> = {
  en: new Set(['had', 'would', 'could', 'should', 'might', 'must', 'will', 'shall', 'may']),
  es: new Set(['había', 'habría', 'hubiera', 'iba']),
};

/**
 * "Tom drove me home and left.", "Tom went out again.", "y se fue.": someone leaves, at the end of
 * a clause.
 */
export const DEPARTURES: Record<Lang, string[][]> = {
  en: [['left'], ['went', 'away'], ['went', 'home'], ['went', 'out'], ['went', 'out', 'again']],
  es: [['se', 'fue'], ['se', 'marchó'], ['salió']],
};

/**
 * Prepositions that open a phrase of time or place, never the subject of a Spanish departure that
 * comes after it: "Después de la cena se fue.", "Por la mañana salió."
 */
export const PREPOSITIONS: Record<Lang, Set<string>> = {
  en: new Set<string>(),
  es: new Set([
    'a',
    'ante',
    'bajo',
    'con',
    'de',
    'desde',
    'durante',
    'en',
    'entre',
    'hacia',
    'hasta',
    'para',
    'por',
    'sin',
    'sobre',
    'tras',
  ]),
};

/** Nouns of time, which never leave: "Esa tarde se fue.", "El lunes salió." */
export const TIME_NOUNS: Record<Lang, Set<string>> = {
  en: new Set<string>(),
  es: new Set([
    'mañana',
    'tarde',
    'noche',
    'día',
    'semana',
    'mes',
    'año',
    'rato',
    'momento',
    'madrugada',
    'hora',
    'alba',
    'amanecer',
    'mediodía',
    'víspera',
    'lunes',
    'martes',
    'miércoles',
    'jueves',
    'viernes',
    'sábado',
    'domingo',
  ]),
};

/** "My name is Ishmael", "Call me Ishmael", "Me llamo Inés": the teller names themself. */
export const SELF_INTRODUCTIONS: Record<Lang, string[][]> = {
  en: [
    ['my', 'name', 'is'],
    ['my', 'name', 'was'],
    ['call', 'me'],
    ['called', 'me'],
    ['calls', 'me'],
    ['named', 'me'],
  ],
  es: [
    ['me', 'llamo'],
    ['me', 'llaman'],
    ['me', 'llamaban'],
    ['me', 'llamaba'],
    ['me', 'llamaron'],
    ['me', 'decían'],
    ['me', 'dicen'],
    ['mi', 'nombre', 'es'],
    ['mi', 'nombre', 'era'],
  ],
};

/**
 * Question words that ask what the teller is called, so the answer after the question is the
 * name: "What did they call me? The old man.", "¿Cómo me llamaban? La niña.", "¿Y sabes qué me
 * decían? La niña." ("Who called me? My uncle." names whoever called).
 */
export const NAME_QUESTIONS: Record<Lang, Set<string>> = {
  en: new Set(['what']),
  es: new Set(['cómo', 'qué']),
};

/**
 * Words for the name a question asks about, which the answer after it is ("And the name the
 * children called me? The old man.", "¿Y el mote que me decían? La niña."), unless one of
 * NAME_OWNERS follows: "the name of the man who called me? Mr. Collins." names someone else.
 */
export const NAME_WORDS: Record<Lang, Set<string>> = {
  en: new Set(['name', 'nickname']),
  es: new Set(['nombre', 'mote', 'apodo']),
};

/** "the name of the man", "el nombre del hombre": someone else's name. */
export const NAME_OWNERS: Record<Lang, Set<string>> = {
  en: new Set(['of']),
  es: new Set(['de', 'del']),
};

/**
 * Prepositions that may join a short phrase to the teller's nickname: "the old man of the
 * lighthouse", "the girl with the red hair", "la niña de la casa".
 */
export const NICKNAME_QUALIFIERS: Record<Lang, Set<string>> = {
  en: new Set(['of', 'with']),
  es: new Set(['de', 'del', 'con']),
};

/**
 * Self-introductions that can also mean someone calling the teller, named after the verb ("me
 * llamaba Pablo desde el patio"): they count only when the name ends its clause.
 */
export const CALLING_INTRODUCTIONS: Record<Lang, Set<string>> = {
  en: new Set<string>(),
  es: new Set(['me llamaba']),
};

/** Relative pronouns between a subject and its verb: "una voz de hombre, que dijo". */
export const RELATIVES: Record<Lang, Set<string>> = {
  en: new Set(['who']),
  es: new Set(['que', 'quien']),
};

/**
 * Capitalised words that are never names (pronouns, function words, interjections). Other
 * sentence-initial capitals only count as names when they match a known character.
 */
export const NOT_NAMES: Record<Lang, Set<string>> = {
  en: new Set([
    'The',
    'A',
    'An',
    'He',
    'She',
    'It',
    'I',
    'We',
    'They',
    'You',
    'His',
    'Her',
    'Their',
    'My',
    'Our',
    'Your',
    'But',
    'And',
    'Or',
    'So',
    'Then',
    'Now',
    'When',
    'While',
    'If',
    'As',
    'At',
    'In',
    'On',
    'Of',
    'To',
    'For',
    'With',
    'This',
    'That',
    'These',
    'Those',
    'There',
    'Here',
    'What',
    'Why',
    'How',
    'Who',
    'Oh',
    'Ah',
    'Yes',
    'No',
    'Not',
    'Well',
    'After',
    'Before',
    'Once',
    'Still',
    'Yet',
    'Do',
    'Is',
    'Indeed',
    'Only',
    // Sentence openers that would otherwise join the name after them ("Suddenly Anna").
    'Even',
    'Suddenly',
    'Meanwhile',
    'Perhaps',
    'Maybe',
    'Instead',
    'Finally',
    'Because',
    'Although',
    'Though',
    'Just',
    'Soon',
    'Later',
    'Again',
    'Both',
    'I’m',
    "I'm",
    'I’d',
    "I'd",
    'I’ll',
    "I'll",
    'I’ve',
    "I've",
    // Days and months, except those that are also names (Friday, March, April, May, June, August).
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Saturday',
    'Sunday',
    'January',
    'February',
    'July',
    'September',
    'October',
    'November',
    'December',
    'God',
    'Lord',
    'Heaven',
    'Heavens',
    'Christ',
    'Jesus',
    'Sir',
    'Madam',
    'Madame',
    'Miss',
    'Ma’am',
    "Ma'am",
    'Mister',
    'Master',
  ]),
  es: new Set([
    'El',
    'La',
    'Los',
    'Las',
    'Un',
    'Una',
    'Él',
    'Ella',
    'Yo',
    'Tú',
    'Usted',
    'Nosotros',
    'Ellos',
    'Ellas',
    'Pero',
    'Y',
    'O',
    'Entonces',
    'Luego',
    'Después',
    'Cuando',
    'Mientras',
    'Si',
    'Sí',
    'No',
    'Como',
    'En',
    'De',
    'Con',
    'Por',
    'Para',
    'Este',
    'Esta',
    'Ese',
    'Esa',
    'Aquí',
    'Allí',
    'Qué',
    'Quién',
    'Cómo',
    'Ya',
    'Bien',
    'Ah',
    'Eh',
    'Oh',
    'Hola',
    'Dios',
    'Mi',
    'Su',
    'Tras',
    'Era',
    'Fue',
    'Virgen',
    'Señor',
    'Señora',
    'Señorita',
    'Ud',
  ]),
};

/**
 * Given names that are also interjections or sacred names ("¡Ay, Jesús!", "rezó a Jesús"). One
 * the cast does not know yet becomes a character only as a speaker ("—dijo Jesús"), and so does a
 * sacred name made with it (see SACRED_WORDS).
 */
export const SPEAKER_ONLY_NAMES: Record<Lang, Set<string>> = {
  en: new Set<string>(),
  es: new Set(['Jesús']),
};

/**
 * Words that make a sacred name of a speaker-only name: right before it ("Niño Jesús", "Señor
 * Jesús"), or right after it ("Jesús Nazareno", "Jesús Obrero", "¡Jesús María!", though "María"
 * only with nothing but such words or one of `family` after it, and at the start of the name or
 * after one of `places`: "¡Jesús María José!", "el Colegio Jesús María"). "Jesús de Nazaret",
 * "Corazón de Jesús" and "Cofradía de Jesús de Nazaret" are sacred names too. Any other name with
 * it is a person's ("Jesús Pérez", "María Jesús", "Jesús María Pérez", "María Jesús del Valle",
 * "don Jesús María", "Fray Jesús María", "sor Teresa de Jesús María"), and so is one a speaker
 * noun introduces ("su tío Jesús", "el padre Jesús"), unless the noun is one of `nouns` ("el niño
 * Jesús"). After the exclamation "¡Jesús," the Holy Family (`family`) and an invocation that
 * `invocations` opens or a sacred word ends are no one called: "¡Jesús, María y José!",
 * "¡Jesús, Santa Bárbara!", "¡Jesús, María Santísima!".
 */
export const SACRED_WORDS: Record<
  Lang,
  {
    before: Set<string>;
    after: Set<string>;
    nouns: Set<string>;
    family: Set<string>;
    invocations: Set<string>;
    places: Set<string>;
  }
> = {
  en: {
    before: new Set<string>(),
    after: new Set<string>(),
    nouns: new Set<string>(),
    family: new Set<string>(),
    invocations: new Set<string>(),
    places: new Set<string>(),
  },
  es: {
    before: new Set(['Niño', 'Señor', 'Cristo', 'Padre', 'Santo', 'Sagrado', 'Divino', 'Buen']),
    after: new Set([
      'María',
      'Cristo',
      'Nazareno',
      'Crucificado',
      'Resucitado',
      'Cautivo',
      'Sacramentado',
      'Yacente',
      'Rescatado',
      'Redentor',
      'Misericordioso',
      'Santísima',
      'Purísima',
      'Obrero',
    ]),
    nouns: new Set(['niño']),
    family: new Set(['María', 'José']),
    invocations: new Set(['Ave', 'San', 'Santa', 'Santo', 'Virgen']),
    places: new Set([
      'Colegio',
      'Escuela',
      'Instituto',
      'Seminario',
      'Parroquia',
      'Iglesia',
      'Capilla',
      'Ermita',
      'Santuario',
      'Basílica',
      'Catedral',
      'Convento',
      'Monasterio',
      'Hermandad',
      'Cofradía',
      'Congregación',
      'Religiosas',
      'Hermanas',
      'Hospital',
      'Asilo',
      'Calle',
      'Plaza',
      'Avenida',
      'Barrio',
    ]),
  },
};

/** Articles that may follow a particle in a full name: "María de los Ángeles", "María de la Paz". */
export const NAME_ARTICLES: Record<Lang, Set<string>> = {
  en: new Set<string>(),
  es: new Set(['el', 'la', 'los', 'las']),
};

/** Lower-case words that may join the words of a name: "Juan de Dios", "Mr. de Winter". */
export const NAME_PARTICLES: Record<Lang, Set<string>> = {
  en: new Set(['de', 'van', 'von', 'du', 'da', 'di', 'del', 'della', 'der', 'le', 'la']),
  es: new Set(['de', 'del']),
};
