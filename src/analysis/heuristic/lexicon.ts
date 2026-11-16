import type { Gender, ToneLabel } from '@/format/types';

export interface VerbInfo {
  thought?: boolean;
  tone?: ToneLabel;
  /** "added": with no subject, the last speaker goes on. */
  continues?: true;
  /** "replied": not said by the person who just spoke. */
  reply?: true;
  /** An English base form ("ask", "reply"): a tag only right after "I" (see verbAt). */
  bare?: true;
}

const v = (tone?: ToneLabel): VerbInfo => (tone ? { tone } : {});
const THOUGHT: VerbInfo = { thought: true };
const REPLY: VerbInfo = { reply: true };
const CONTINUES: VerbInfo = { continues: true };
const bare = (tone?: ToneLabel): VerbInfo => ({ ...v(tone), bare: true });
const each = (words: string[], info: VerbInfo) => Object.fromEntries(words.map((w) => [w, info]));

/**
 * A word table with no prototype, so `in` and indexing find only its own words. In a plain
 * object, a word such as "constructor" or "toString" would find an inherited member.
 */
function table<T>(entries: Record<string, T>): Record<string, T> {
  return Object.assign(Object.create(null) as Record<string, T>, entries);
}

/** Speech and thought verbs that introduce or tag dialogue, with the tone they imply. */
export const VERBS: Record<string, VerbInfo> = table({
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
});

/** Adverbs that colour the tone of a tagged line. */
export const ADVERB_TONES: Record<string, ToneLabel> = table({
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
});

export const TITLES: Record<string, Gender | undefined> = table({
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
});

export const DETERMINERS = new Set([
  'the',
  'his',
  'her',
  'their',
  'my',
  'a',
  'an',
  'our',
  'your',
  'this',
  'that',
]);

/** Nouns that can name a speaker ("his wife"), with their gender when fixed. */
export const SPEAKER_NOUNS: Record<string, Gender | undefined> = table({
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
});

/** Speaker nouns that say nothing about the speaker ("a voice"). */
export const EPICENE = new Set(['voice']);

/** "his voice": a voice that has an owner never names a speaker. */
export const POSSESSIVE_DETERMINERS = new Set(['his', 'her', 'their', 'my', 'your', 'our']);

/**
 * Subject pronouns; the first-person forms mean whoever tells the story. isPronoun also reads
 * "She" and "I’m" (curly apostrophe) as these.
 */
export const PRONOUNS: Record<string, Gender | 'narrator'> = table({
  he: 'male',
  she: 'female',
  I: 'narrator',
  "I'm": 'narrator',
  "I'd": 'narrator',
  "I'll": 'narrator',
  "I've": 'narrator',
});

/** Subject pronouns, lower-case. */
export const SUBJECT_PRONOUNS = new Set(['i', 'you', 'he', 'she', 'we', 'they', 'it']);

/**
 * Words that show narration is in the first person ("my", "me", "we"). English "I" counts only
 * before a lower-case word in the same sentence (see the heuristic's isFirstPerson).
 */
export const FIRST_PERSON_WORDS = new Set([
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
]);

/** Someone else's reflexive object: "recovering herself" goes on with the same person. */
export const SELF_WORDS = new Set(['himself', 'herself', 'themselves']);

/** Reflexive objects that turn a speech verb into thought: "I told myself". */
export const REFLEXIVES = new Set(['myself', 'himself', 'herself']);

/** English auxiliaries: after one a finite verb goes on ("Anne could not"). */
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

/** Auxiliaries and the other modals before a verb: "no one can see", "Anne must have noticed". */
export const AUXILIARIES_AND_MODALS = new Set([
  ...AUXILIARIES,
  'can',
  'cannot',
  'may',
  'might',
  'must',
]);

/** Adverbs that may sit between a subject and its verb: "Tom then said". */
export const VERB_ADVERBS = new Set(['then', 'again', 'just', 'now', 'also', 'only', 'still']);

/**
 * Words that may sit between a subject and its verb: "I had said", "Tom then said".
 * Never "was": "Tom was told" is said to Tom, not by him.
 */
export const BEFORE_VERB_SKIP = new Set([...AUXILIARIES, ...VERB_ADVERBS]);

/**
 * Adverbs a subject may have before its verb, besides the ones in -ly and in BEFORE_VERB_SKIP: "and
 * Anne too smiled", "and Anne almost cried", "and Anne herself opened".
 * With no verb after them the words are a phrase of their own ("Mrs. Bennet first,", "and Anne
 * too,", "but Anne most warmly,").
 */
export const SUBJECT_ADVERBS = new Set([
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
]);

/**
 * Words after a person that make a phrase with no verb, not a clause: "Anne at his side", "his wife
 * beside him", "Jane included". (An article or a preposition such as "at" ends an object anyway:
 * see endsObject.)
 */
export const PHRASE_AFTER_PERSON = new Set([
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
]);

/**
 * Verbs of knowing or seeing that make a comment of a short clause with nothing after them: "Tom
 * hesitated, Anne noticed, and then said", "Tom hesitates, she thinks, and says", "Anne must have
 * seen, and said". With an object it is no comment ("Anne saw it,").
 */
export const COMMENT_VERBS = new Set([
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
]);

/**
 * Set phrases a subject may have before its verb: "and Anne at last looked up and said", "I at
 * once got up".
 */
export const BEFORE_VERB_PAIRS = new Set([
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
]);

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

/** Words before "himself" or "herself" in an aside that keeps the speaker: "recovering herself". */
export const RECOVERY_WORDS = new Set([
  'recovering',
  'collecting',
  'composing',
  'correcting',
  'checking',
  'catching',
]);

/** Question words: someone who asks with one does not answer ("Mary wanted to know where"). */
export const WH_WORDS = new Set(['what', 'why', 'how', 'who', 'where', 'when', 'which']);

/** Tag verbs that ask: a reply after one answers the line ("“Where?” asked Tom, and he answered:"). */
export const ASKING_VERBS = new Set([
  'asked',
  'asks',
  'ask',
  'inquired',
  'enquired',
  'demanded',
  'queried',
  'questioned',
]);

/** Lead words before someone who comes in: "Suddenly Anne came in". */
export const ENTRY_LEADS = new Set(['suddenly', 'just', 'soon', 'presently', 'finally']);

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

/** Words of place after a verb of being there (see BEING_THERE): "Suddenly Anne was there". */
export const THERE = new Set(['there', 'here', 'in', 'at', 'on', 'by', 'beside']);

/** Words after "appeared" when someone arrives, not when they look a way ("She appeared tired"). */
export const APPEARING_WHERE = new Set([
  ...THERE,
  'before',
  'outside',
  'from',
  'through',
  'round',
  'around',
  'again',
  'back',
  'home',
  'out',
  'up',
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
 * Words of endearment after a name the line is said to: "Anne dear", "Tom my boy".
 */
export const ENDEARMENTS = new Set([
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
]);

/** Words that may sit between a verb and its inverted subject. */
export const AFTER_VERB_SKIP = new Set(['then', 'again', 'now']);

/** Two-word adverbs that may follow a verb: "said at last". */
export const AFTER_VERB_PAIRS = new Set(['at last', 'at once']);

/**
 * Words that may open a sentence before its subject: "Then Anne said", "Tom shrugged, so Anne
 * picked up the bag and said".
 */
export const SENTENCE_LEADS = new Set(['then', 'now', 'at', 'last', 'and', 'but', 'so']);

/** Prepositions after which a name is a place or an absent person, not someone present. */
export const NON_PARTICIPANT_PREPOSITIONS = new Set([
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
]);

/** Prepositions that mark the person spoken to: "said to Anne". */
export const ADDRESSEE_MARKERS = new Set(['to']);

/** Words that ask a question: "What could I say?", "Whose was it?" */
const QUESTION_WORDS = ['what', 'why', 'how', 'who', 'whom', 'where', 'when', 'which', 'whose'];

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
 * Words that open a question clause: a question word, or an auxiliary before its subject ("What
 * could I say?", "Had I said too much?"). A tag's clause opens with none
 * of them, so a question after it is a clause of its own: "“I’m fine,” I said, but was I?", "I
 * said, because what else could I say?"
 */
export const QUESTION_OPENERS = new Set([
  ...QUESTION_WORDS,
  ...QUESTION_AUXILIARIES,
  'had',
  'has',
  'have',
  'was',
  'were',
  'is',
  'are',
  'am',
  "hadn't",
  "hasn't",
  "haven't",
  "wasn't",
  "weren't",
  "isn't",
  "aren't",
]);

/**
 * Words that join a clause of its own after a comma or a pause, such as a question after a tag:
 * "“I’m fine,” I said, but was I?", "Tom said, because what else could he say?"
 */
export const CONJUNCTIONS = new Set([
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
]);

/** Words that may come before a question clause's opener: "And had I said too much?" */
export const QUESTION_JOINS = new Set(['and', 'but', 'or', 'so']);

/**
 * Words before a question auxiliary (see QUESTION_AUXILIARIES) that still make a question ("What
 * do I tell Mom?", "And can I ask?"). After other words the order is only emphatic: "Only then did
 * I tell him."
 */
export const QUESTION_LEADS = new Set([...QUESTION_WORDS, ...QUESTION_JOINS]);

/** "I turned to her and said": a verb after one of these shares the clause's subject. */
export const COORDINATORS = new Set(['and']);

/** Subject pronouns of someone else: in "I suppose she sighed and said", "said" is hers. */
export const OTHER_SUBJECTS = new Set(['he', 'she', 'they']);

// "someone said": nobody in particular, and never the teller, who would say "I".
export const INDEFINITE_SUBJECTS = new Set(['someone', 'somebody', 'everyone', 'everybody']);

/**
 * Words that start a clause of its own. In English a name right after one is that clause's
 * subject ("I think Mrs. Bennet turned and said").
 */
export const CLAUSE_LEADS = new Set([
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
]);

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
 * told me, was nervous", "or so I was told".
 */
export const ASIDES = [['as'], ['or', 'so']];

/**
 * Objects that make a speech verb report what was said rather than tag a line: "She nodded and
 * said goodbye.", "He said nothing.", "said good night".
 */
export const REPORTED_OBJECTS = new Set([
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
]);

/** Words that deny a verb: "I did not see Anne until the next day." */
export const NEGATIONS = new Set(['not', 'never', 'no', 'nobody', 'nothing']);

/** Objects that may follow an English base-form tag: "I tell him." */
export const BARE_OBJECTS = new Set(['him', 'her', 'them', 'you', 'it', 'us']);

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
export const HEADING_WORDS = /^(chapter|part|book|prologue|epilogue|stave)(?!\p{L})/iu;

/** "In the evening": time has passed, so the scene before is over. */
export const TIME_SHIFTS = [
  ['later'],
  ['next', 'day'],
  ['next', 'morning'],
  ['next', 'evening'],
  ['next', 'night'],
  ['next', 'afternoon'],
  ['that', 'evening'],
  ['that', 'night'],
  ['in', 'the', 'evening'],
];

/** Prepositions before a time that ends a wait: "I did not see Anne until the next day." */
export const UNTIL = new Set(['until', 'till']);

/** Words that count the time before "later" when three come before it: "A few days later". */
export const TIME_COUNTS = new Set([
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
]);

/**
 * Verbs of someone arriving: after "She arrived that evening." the scene changes for her (see
 * timeLaterInSentence), not after "She baked bread in the evening" or "She was leaving the next
 * day".
 */
export const ARRIVALS = new Set([
  'arrived',
  'came',
  'knocked',
  'appeared',
  'returned',
  'visited',
  'showed',
  'called',
]);

/** English verbs of arriving after "did not": "Anne did not come down until that evening". */
export const ARRIVING = new Set(['come', 'arrive', 'appear', 'return', 'show', 'turn']);

/** Verbs of coming in after an entry lead: "Suddenly Anne burst in". */
export const ENTERING = new Set([
  'walked',
  'burst',
  'rushed',
  'ran',
  'stepped',
  'hurried',
  'entered',
  'strode',
]);

/** Verbs of being there before a word of place (see THERE): "Suddenly Anne was there". */
export const BEING_THERE = new Set(['was', 'stood', 'sat']);

/** Verbs of leaving and of sending someone away: "Anne had gone", "I had sent Anne". */
export const LEAVING = new Set(['went', 'left', 'gone', 'headed']);
export const SENDING = new Set(['sent']);

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

/** Time shifts that only compare, so no time passes: "later than usual". */
export const TIME_COMPARISONS = [['later', 'than']];

/** Words before "later" that keep the scene: "A moment later". */
export const SHORT_PAUSES = new Set([
  'moment',
  'moments',
  'minute',
  'minutes',
  'second',
  'seconds',
  'instant',
  'little',
]);

/**
 * Auxiliaries after which the person before them is talked about rather than coming in: "and Anne
 * had promised to come", "Anne would come later".
 */
export const OFFSTAGE_AUXILIARIES = new Set([
  'had',
  'would',
  'could',
  'should',
  'might',
  'must',
  'will',
  'shall',
  'may',
]);

/**
 * "Tom drove me home and left.", "Tom went out again.": someone leaves, at the end of a clause.
 */
export const DEPARTURES = [
  ['left'],
  ['went', 'away'],
  ['went', 'home'],
  ['went', 'out'],
  ['went', 'out', 'again'],
];

/** "My name is Ishmael", "Call me Ishmael": the teller names themself. */
export const SELF_INTRODUCTIONS = [
  ['my', 'name', 'is'],
  ['my', 'name', 'was'],
  ['call', 'me'],
  ['called', 'me'],
  ['calls', 'me'],
  ['named', 'me'],
];

/**
 * Question words that ask what the teller is called, so the answer after the question is the
 * name: "What did they call me? The old man." ("Who called me? My uncle." names whoever called).
 */
export const NAME_QUESTIONS = new Set(['what']);

/**
 * Words for the name a question asks about, which the answer after it is ("And the name the
 * children called me? The old man."), unless one of NAME_OWNERS follows: "the name of the man
 * who called me? Mr. Collins." names someone else.
 */
export const NAME_WORDS = new Set(['name', 'nickname']);

/** "the name of the man": someone else's name. */
export const NAME_OWNERS = new Set(['of']);

/**
 * Prepositions that may join a short phrase to the teller's nickname: "the old man of the
 * lighthouse", "the girl with the red hair".
 */
export const NICKNAME_QUALIFIERS = new Set(['of', 'with']);

/** Relative pronouns between a subject and its verb: "the man, who said". */
export const RELATIVES = new Set(['who']);

/**
 * Capitalised words that are never names (pronouns, function words, interjections). Other
 * sentence-initial capitals only count as names when they match a known character. "He", "She"
 * and the teller's "I", "I’m"… are not listed: as pronouns (see isPronoun) they are never names.
 */
export const NOT_NAMES = new Set([
  'The',
  'A',
  'An',
  'It',
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
]);

/** Lower-case words that may join the words of a name: "Mr. de Winter". */
export const NAME_PARTICLES = new Set([
  'de',
  'van',
  'von',
  'du',
  'da',
  'di',
  'del',
  'della',
  'der',
  'le',
  'la',
]);
