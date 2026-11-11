// Short multi-part stories written for these tests, covering third person, first person,
// alternating narrators, frame tales and letters (see heldout.ts). They were written apart from
// the heuristic, but its first-person rules were then measured and tuned against them.
// A few passages adapt public-domain novels (Bleak House, Dracula, Don Quixote) for their
// narrator structure.
// Each expectation names the PERSON who should voice the unit containing the needle's first
// character. 'N' is the impersonal (third-person) narrator and must be the story's narrator entry.
// Any other person may be voiced by any single cast id (the narrator entry or a character), but
// every person needs their own id. `soft` marks status-quo-acceptable misses (a letter or a
// character's unquoted tale read by the frame narrator): `alt` lists the acceptable fallback.
import type { Lang } from '@/format/types';

export interface Expect {
  needle: string;
  who: string;
  soft?: boolean;
  alt?: string;
}

export interface PartSpec {
  text: string;
  expect: Expect[];
}

export interface StorySpec {
  id: string;
  scenario: string;
  lang: Lang;
  /** Ordinary third-person story: any change is a false positive. */
  third: boolean;
  parts: PartSpec[];
  /** Names that must NOT end up as aliases of the narrator entry. */
  forbiddenNarratorAliases?: string[];
  /** Persons who narrate (first-person tellers): voiced by any one id, never pinned by name. */
  tellers?: string[];
}

const p = (text: string, expect: Expect[]): PartSpec => ({ text, expect });

export const STORIES: StorySpec[] = [
  // ------------------------------------------------------------------ third person (false positives)
  {
    id: 'T1 pov heading + free direct thought',
    scenario: 'a',
    lang: 'en',
    third: true,
    forbiddenNarratorAliases: ['Margaret'],
    parts: [
      p(
        `MARGARET

Margaret stood at the window until the light was gone. It was no use. I cannot go back to him, I cannot. My father would never forgive me, and I would never forgive myself.

The door opened behind her.

“You are up early, Margaret,” said her aunt.

“I could not sleep.”

“Nor could I. Come down, my dear, and have some tea.”

“In a moment.”`,
        [
          { needle: 'MARGARET', who: 'N' },
          { needle: 'Margaret stood', who: 'N' },
          { needle: 'The door opened', who: 'N' },
          { needle: '“You are up early', who: 'Aunt' },
          { needle: '“I could not sleep', who: 'Margaret' },
          { needle: '“Nor could I', who: 'Aunt' },
          { needle: '“In a moment', who: 'Margaret' },
        ],
      ),
    ],
  },
  {
    id: 'T2 letter inside third person',
    scenario: 'a/e',
    lang: 'en',
    third: true,
    forbiddenNarratorAliases: ['Jane', 'Lizzy'],
    parts: [
      p(
        `CHAPTER XII

Elizabeth found a letter waiting on the hall table, and she opened it at once.

My dear Lizzy,

I write in great haste. Our uncle is ill, and I must stay at Longbourn until he is better. I hope you will not be anxious for me, and I beg you to say nothing to my mother.

Your affectionate sister,
Jane

She folded it and put it in her pocket.

“Bad news?” asked Charlotte.

“Not very bad,” said Elizabeth. “My uncle is ill.”

“Then you will go home?”

“Tomorrow.”`,
        [
          { needle: 'Elizabeth found', who: 'N' },
          { needle: 'My dear Lizzy', who: 'Jane', soft: true, alt: 'N' },
          { needle: 'I write in great haste', who: 'Jane', soft: true, alt: 'N' },
          { needle: 'Your affectionate sister', who: 'Jane', soft: true, alt: 'N' },
          { needle: 'She folded it', who: 'N' },
          { needle: '“Bad news?', who: 'Charlotte' },
          { needle: '“Not very bad', who: 'Elizabeth' },
          { needle: '“Then you will go home', who: 'Charlotte' },
          { needle: '“Tomorrow', who: 'Elizabeth' },
        ],
      ),
    ],
  },
  {
    id: 'T3 intrusive "dear reader" narrator',
    scenario: 'g',
    lang: 'en',
    third: true,
    forbiddenNarratorAliases: ['Becky'],
    parts: [
      p(
        `I must beg the reader to remember that our heroine was only nineteen, and that I have known older women behave a great deal worse. I do not excuse her; I only ask that my reader be patient with her a little longer, as I have been.

“Come here, Becky,” said Miss Pinkerton from the top of the stairs.

“Yes, ma’am.”

“Where is your bonnet?”

“I have lost it, ma’am.”

“Lost it! Then you shall go without.”`,
        [
          { needle: 'I must beg', who: 'N' },
          { needle: '“Come here, Becky', who: 'Pinkerton' },
          { needle: '“Yes, ma’am', who: 'Becky' },
          { needle: '“Where is your bonnet', who: 'Pinkerton' },
          { needle: '“I have lost it', who: 'Becky' },
          { needle: '“Lost it!', who: 'Pinkerton' },
        ],
      ),
    ],
  },
  {
    id: 'T4 es third person, subjectless tags',
    scenario: 'a/f',
    lang: 'es',
    third: true,
    parts: [
      p(
        `Ana y Pedro caminaban por la orilla del río, sin prisa, mirando cómo bajaba el agua.

—¿Vienes conmigo mañana? —preguntó Ana.

—No puedo —respondió.

—¿Por qué no?

—Tengo que trabajar —contestó, sin mirarla.

—Siempre tienes que trabajar.`,
        [
          { needle: 'Ana y Pedro', who: 'N' },
          { needle: '—¿Vienes conmigo', who: 'Ana' },
          { needle: '—No puedo', who: 'Pedro' },
          { needle: '—¿Por qué no?', who: 'Ana' },
          { needle: '—Tengo que trabajar', who: 'Pedro' },
          { needle: '—Siempre tienes', who: 'Ana' },
        ],
      ),
    ],
  },
  {
    id: 'T4b es third person, back-and-forth with subjectless tags',
    scenario: 'a/f',
    lang: 'es',
    third: true,
    parts: [
      p(
        `En la cocina, Julián se sentó junto al fuego, y Rosa le sirvió un plato de sopa sin decir nada.

—¿Has visto a la niña? —preguntó Julián al cabo de un rato.

—Esta mañana —respondió—. Iba hacia el río con su hermano.

—¿Siempre van juntos?

—Siempre.

—¿Y no tiene miedo?

—No tiene miedo de nada —contestó, y siguió fregando.`,
        [
          { needle: 'En la cocina', who: 'N' },
          { needle: '—¿Has visto', who: 'Julián' },
          { needle: '—Esta mañana', who: 'Rosa' },
          { needle: '—¿Siempre van', who: 'Julián' },
          { needle: '—Siempre.', who: 'Rosa' },
          { needle: '—¿Y no tiene', who: 'Julián' },
          { needle: '—No tiene miedo', who: 'Rosa' },
        ],
      ),
    ],
  },
  {
    id: 'T5 chapter-name heading + interior monologue, 2 parts',
    scenario: 'a',
    lang: 'en',
    third: true,
    forbiddenNarratorAliases: ['Anna', 'Tom'],
    parts: [
      p(
        `CHAPTER 3: ANNA

She woke before dawn and lay listening to the rain. I will tell him today, I will. I have waited long enough, and my courage will not last another week.

Downstairs the kettle was already singing.

“You’re up,” said Tom, without turning round.

“I couldn’t sleep.”

“Neither could I.”`,
        [
          { needle: 'CHAPTER 3', who: 'N' },
          { needle: 'She woke', who: 'N' },
          { needle: 'Downstairs', who: 'N' },
          { needle: '“You’re up', who: 'Tom' },
          { needle: '“I couldn’t sleep', who: 'Anna' },
          { needle: '“Neither could I', who: 'Tom' },
        ],
      ),
      p(
        `CHAPTER 4: TOM

The market was crowded, and Tom lost sight of her twice before he found her at the flower stall.

“There you are,” he said.

“Here I am,” said Anna. “Did you think I had run away?”

“For a moment.”`,
        [
          { needle: 'CHAPTER 4', who: 'N' },
          { needle: 'The market', who: 'N' },
          { needle: '“There you are', who: 'Tom' },
          { needle: '“Here I am', who: 'Anna' },
          { needle: '“For a moment', who: 'Tom' },
        ],
      ),
    ],
  },
  {
    id: 'T6 es letter inside third person',
    scenario: 'a/e',
    lang: 'es',
    third: true,
    forbiddenNarratorAliases: ['Andrés', 'Rosario'],
    parts: [
      p(
        `Cuando Rosario volvió del mercado encontró una carta sobre la mesa de la cocina. La abrió de pie, sin quitarse el abrigo.

Querida Rosario:

Te escribo deprisa porque sale el correo. Estoy bien, aunque echo de menos la casa y a todos vosotros. No le digas nada a madre de lo que te conté.

Tu hermano,
Andrés

Rosario guardó la carta en el bolsillo del delantal.

—¿Qué dice? —preguntó su madre desde la puerta.

—Que está bien —contestó Rosario.

—¿Nada más?

—Nada más.`,
        [
          { needle: 'Cuando Rosario', who: 'N' },
          { needle: 'Querida Rosario', who: 'Andrés', soft: true, alt: 'N' },
          { needle: 'Te escribo', who: 'Andrés', soft: true, alt: 'N' },
          { needle: 'Tu hermano', who: 'Andrés', soft: true, alt: 'N' },
          { needle: 'Rosario guardó', who: 'N' },
          { needle: '—¿Qué dice?', who: 'Madre' },
          { needle: '—Que está bien', who: 'Rosario' },
          { needle: '—¿Nada más?', who: 'Madre' },
          { needle: '—Nada más.', who: 'Rosario' },
        ],
      ),
    ],
  },
  {
    id: 'T7 es pov heading',
    scenario: 'a',
    lang: 'es',
    third: true,
    forbiddenNarratorAliases: ['Inés'],
    parts: [
      p(
        `INÉS

Inés se despertó tarde aquel domingo. Desde la ventana veía el patio, la higuera, el gato dormido sobre el muro.

—¿Bajas a desayunar? —gritó su madre desde la escalera.

—Ahora voy.

—El café se enfría.

—Ya voy, mamá.`,
        [
          { needle: 'INÉS', who: 'N' },
          { needle: 'Inés se despertó', who: 'N' },
          { needle: '—¿Bajas', who: 'Madre' },
          { needle: '—Ahora voy', who: 'Inés' },
          { needle: '—El café', who: 'Madre' },
          { needle: '—Ya voy', who: 'Inés' },
        ],
      ),
    ],
  },
  {
    id: 'T8 es heading + free indirect first person',
    scenario: 'a',
    lang: 'es',
    third: true,
    forbiddenNarratorAliases: ['Carmen'],
    parts: [
      p(
        `CARMEN

Carmen cerró la puerta y se quedó quieta en el pasillo. No volveré, no volveré nunca. Me lo prometí y lo cumpliré, aunque me muera de hambre.

—¿Carmen? —llamó su tía desde el salón—. ¿Eres tú?

—Sí, tía.

—Ven un momento.`,
        [
          { needle: 'CARMEN', who: 'N' },
          { needle: 'Carmen cerró', who: 'N' },
          { needle: '—¿Carmen?', who: 'Tía' },
          { needle: '—Sí, tía', who: 'Carmen' },
          { needle: '—Ven un momento', who: 'Tía' },
        ],
      ),
    ],
  },

  // ------------------------------------------------------------------ (b) one first-person narrator
  {
    id: 'B watson, named only by others, 2 parts',
    scenario: 'b',
    lang: 'en',
    third: false,
    tellers: ['Watson'],
    parts: [
      p(
        `I had been in London a week before I called upon my old friend. The landlady showed me up, and I found him bent over a chemical experiment.

“Ah, there you are, Watson,” said Holmes, without turning round. “Sit down. I shall not be a moment.”

“You knew I was coming?”

“I knew it from the mud on your boots.”

“It might have been anyone’s mud.”

“It might, but it was yours.”

I laughed and took the chair by the fire.

“Well, Watson,” he said at last, wiping his hands, “what brings you here?”

“Boredom,” said I.

“Then I have the cure for it.”`,
        [
          { needle: 'I had been in London', who: 'Watson' },
          { needle: '“Ah, there you are', who: 'Holmes' },
          { needle: '“You knew I was coming', who: 'Watson' },
          { needle: '“I knew it from the mud', who: 'Holmes' },
          { needle: '“It might have been', who: 'Watson' },
          { needle: '“It might, but', who: 'Holmes' },
          { needle: 'I laughed', who: 'Watson' },
          { needle: '“Well, Watson', who: 'Holmes' },
          { needle: '“Boredom', who: 'Watson' },
          { needle: '“Then I have the cure', who: 'Holmes' },
        ],
      ),
      p(
        `The cab put us down at the corner of the square. Holmes paid the driver and stood looking up at the house.

“Number seven,” he said. “The blinds are drawn.”

“Perhaps they are away.”

“Perhaps. Knock, Watson, and let us see.”

I knocked. A maid opened the door and looked at us with frightened eyes.

“Is your master at home?” I asked her.

“He is not, sir.”

“Then we shall wait,” said Holmes.`,
        [
          { needle: 'The cab put us', who: 'Watson' },
          { needle: '“Number seven', who: 'Holmes' },
          { needle: '“Perhaps they are away', who: 'Watson' },
          { needle: '“Perhaps. Knock', who: 'Holmes' },
          { needle: 'I knocked', who: 'Watson' },
          { needle: '“Is your master', who: 'Watson' },
          { needle: '“He is not, sir', who: 'Maid' },
          { needle: '“Then we shall wait', who: 'Holmes' },
        ],
      ),
    ],
  },
  {
    id: 'X1 third party addressed, narrator replies (no alias!)',
    scenario: 'b',
    lang: 'en',
    third: false,
    tellers: ['I'],
    forbiddenNarratorAliases: ['Tom'],
    parts: [
      p(
        `I followed the twins up the lane to their house. Their sister was waiting at the gate with her arms folded.

“Dinner’s ready, Tom,” she said. “Wash your hands.”

“We’re coming,” I said.

“Not you. You go home.”`,
        [
          { needle: 'I followed', who: 'I' },
          { needle: '“Dinner’s ready', who: 'Sister' },
          { needle: '“We’re coming', who: 'I' },
          { needle: '“Not you', who: 'Sister' },
        ],
      ),
      p(
        `The next morning Tom was waiting for me by the bridge, throwing stones into the water.

“You’re late,” said Tom.

“I had to feed the hens,” I said.

“You always have to feed the hens.”`,
        [
          { needle: 'The next morning', who: 'I' },
          { needle: '“You’re late', who: 'Tom' },
          { needle: '“I had to feed', who: 'I' },
          { needle: '“You always', who: 'Tom' },
        ],
      ),
    ],
  },
  {
    id: 'X1b same, longer first-person opening',
    scenario: 'b',
    lang: 'en',
    third: false,
    tellers: ['I'],
    forbiddenNarratorAliases: ['Tom'],
    parts: [
      p(
        `I followed the twins up the lane to their house, as I did most evenings that summer, because my own house was empty and I did not like to be alone in it. Their sister was waiting at the gate with her arms folded.

“Dinner’s ready, Tom,” she said. “Wash your hands.”

“We’re coming,” I said.

“Not you. You go home.”`,
        [
          { needle: 'I followed', who: 'I' },
          { needle: '“Dinner’s ready', who: 'Sister' },
          { needle: '“We’re coming', who: 'I' },
          { needle: '“Not you', who: 'Sister' },
        ],
      ),
      p(
        `The next morning Tom was waiting for me by the bridge, throwing stones into the water.

“You’re late,” said Tom.

“I had to feed the hens,” I said.

“You always have to feed the hens.”`,
        [
          { needle: 'The next morning', who: 'I' },
          { needle: '“You’re late', who: 'Tom' },
          { needle: '“I had to feed', who: 'I' },
          { needle: '“You always', who: 'Tom' },
        ],
      ),
    ],
  },
  {
    id: 'X4 observer narrator between two speakers',
    scenario: 'b',
    lang: 'en',
    third: false,
    tellers: ['I'],
    parts: [
      p(
        `I sat in the corner and said nothing while my aunt and the vicar argued about the roof. I had learned long ago that it was safer that way.

“The roof must be mended before the winter,” said the vicar.

“With what money?” said my aunt.

“The parish will find it.”

I looked from one to the other and wished I were somewhere else.

“The parish has never found anything.”

“Then the parish must try harder,” said the vicar. “And so must you, if I may say so.”

“You may not,” I said, and they both turned to stare at me.`,
        [
          { needle: 'I sat in the corner', who: 'I' },
          { needle: '“The roof must', who: 'Vicar' },
          { needle: '“With what money', who: 'Aunt' },
          { needle: '“The parish will', who: 'Vicar' },
          { needle: 'I looked from one', who: 'I' },
          { needle: '“The parish has never', who: 'Aunt' },
          { needle: '“Then the parish', who: 'Vicar' },
          { needle: '“You may not', who: 'I' },
        ],
      ),
    ],
  },
  {
    id: 'X2 "I am English," (not a name)',
    scenario: 'b',
    lang: 'en',
    third: false,
    tellers: ['I'],
    forbiddenNarratorAliases: ['English'],
    parts: [
      p(
        `I am English, and I had never seen snow like the snow that fell that winter in Vienna.

“You are not used to it,” said Herr Braun, watching me stamp my feet in his doorway.

“Not at all,” I said.

“Then come inside.”`,
        [
          { needle: 'I am English', who: 'I' },
          { needle: '“You are not used', who: 'Braun' },
          { needle: '“Not at all', who: 'I' },
          { needle: '“Then come inside', who: 'Braun' },
        ],
      ),
    ],
  },
  {
    id: 'X3 place-name chapter heading',
    scenario: 'b',
    lang: 'en',
    third: false,
    tellers: ['I'],
    forbiddenNarratorAliases: ['Thornfield'],
    parts: [
      p(
        `THORNFIELD

The carriage stopped at last, and a servant came out with a lantern to help me down. I was stiff and cold, and I could hardly stand.

“Welcome to Thornfield, miss,” said the housekeeper at the door. “You must be tired.”

“A little,” I said.

“Come in to the fire.”`,
        [
          { needle: 'THORNFIELD', who: 'I' },
          { needle: 'The carriage', who: 'I' },
          { needle: '“Welcome to Thornfield', who: 'Housekeeper' },
          { needle: '“A little', who: 'I' },
          { needle: '“Come in', who: 'Housekeeper' },
        ],
      ),
    ],
  },

  // ------------------------------------------------------------------ (c) alternating narrators
  {
    id: 'C alternating en: AMY / NICK / (no heading) Amy',
    scenario: 'c',
    lang: 'en',
    third: false,
    tellers: ['Amy', 'Nick'],
    parts: [
      p(
        `AMY

The morning Nick forgot my birthday, I made pancakes anyway. I set the table for two and waited.

He came down at nine, still in his running clothes.

“Smells good,” he said.

“It’s a special day,” I said.

“Is it?”

“You tell me.”

He looked at the calendar, and then at me, and I watched him understand.`,
        [
          { needle: 'AMY', who: 'Amy' },
          { needle: 'The morning Nick', who: 'Amy' },
          { needle: 'He came down', who: 'Amy' },
          { needle: '“Smells good', who: 'Nick' },
          { needle: '“It’s a special day', who: 'Amy' },
          { needle: '“Is it?', who: 'Nick' },
          { needle: '“You tell me', who: 'Amy' },
          { needle: 'He looked at the calendar', who: 'Amy' },
        ],
      ),
      p(
        `NICK

I drove to the bar because I did not know where else to go. My sister was behind the counter, counting the till.

“You look terrible,” Go said.

“Thanks.”

“What did you do?”

“I forgot Amy’s birthday.”

She put down the money and stared at me.

“Again?”`,
        [
          { needle: 'NICK', who: 'Nick' },
          { needle: 'I drove to the bar', who: 'Nick' },
          { needle: '“You look terrible', who: 'Go' },
          { needle: '“Thanks', who: 'Nick' },
          { needle: '“What did you do', who: 'Go' },
          { needle: '“I forgot Amy', who: 'Nick' },
          { needle: 'She put down the money', who: 'Nick' },
          { needle: '“Again?', who: 'Go' },
        ],
      ),
      p(
        `When I got home the house was dark. I sat on the stairs with my coat still on and listened to the clock in the hall.

At eleven the door opened.

“Amy?” Nick said. “Are you awake?”

“I’m here.”

“I’m sorry.”

“I know you are,” I said.`,
        [
          { needle: 'When I got home', who: 'Amy' },
          { needle: 'At eleven', who: 'Amy' },
          { needle: '“Amy?', who: 'Nick' },
          { needle: '“I’m here', who: 'Amy' },
          { needle: '“I’m sorry', who: 'Nick' },
          { needle: '“I know you are', who: 'Amy' },
        ],
      ),
    ],
  },
  {
    id: 'CE alternating es: MARTA / DIEGO',
    scenario: 'c/f',
    lang: 'es',
    third: false,
    tellers: ['Marta', 'Diego'],
    parts: [
      p(
        `MARTA

Aquel verano volví al pueblo después de diez años. Diego me esperaba en la estación, más delgado de lo que yo recordaba.

—Has tardado —me dijo.

—El tren venía lleno.

—Siempre viene lleno.

Le di la maleta y caminamos en silencio hasta la plaza.`,
        [
          { needle: 'MARTA', who: 'Marta' },
          { needle: 'Aquel verano', who: 'Marta' },
          { needle: '—Has tardado', who: 'Diego' },
          { needle: '—El tren', who: 'Marta' },
          { needle: '—Siempre viene', who: 'Diego' },
          { needle: 'Le di la maleta', who: 'Marta' },
        ],
      ),
      p(
        `DIEGO

Marta no había cambiado nada. Lo pensé mientras la miraba cruzar la plaza con aquella maleta absurda que se empeñó en llevar ella sola.

—¿Quieres un café? —le pregunté.

—Quiero dormir —contestó Marta.

—Primero el café.`,
        [
          { needle: 'DIEGO', who: 'Diego' },
          { needle: 'Marta no había', who: 'Diego' },
          { needle: '—¿Quieres un café', who: 'Diego' },
          { needle: '—Quiero dormir', who: 'Marta' },
          { needle: '—Primero el café', who: 'Diego' },
        ],
      ),
    ],
  },

  // ------------------------------------------------------------------ (d) teller change inside a chapter
  {
    id: 'D1 frame, unquoted takeover with colon cue',
    scenario: 'd',
    lang: 'en',
    third: false,
    tellers: ['Frame', 'Hale'],
    parts: [
      p(
        `I asked Mrs. Hale who had lived in the house before me, and she put down her sewing and told me:

I was in service there when I was a girl, and I remember the master well. He was a hard man, but he was fair to me. One winter night he called me into the study.

“Martha,” he said, “can you keep a secret?”

“Yes, sir,” I said.

“Then keep this one.”

He gave me a key, and I have it still.

Here Mrs. Hale stopped and looked at the fire, and I did not like to press her.

“And the key?” I asked at last.

“It is in my workbox,” she said.`,
        [
          { needle: 'I asked Mrs. Hale', who: 'Frame' },
          { needle: 'I was in service', who: 'Hale', soft: true, alt: 'Frame' },
          { needle: '“Martha,', who: 'Master' },
          { needle: '“Yes, sir', who: 'Hale' },
          { needle: '“Then keep this one', who: 'Master' },
          { needle: 'He gave me a key', who: 'Hale', soft: true, alt: 'Frame' },
          { needle: 'Here Mrs. Hale stopped', who: 'Frame' },
          { needle: '“And the key?', who: 'Frame' },
          { needle: '“It is in my workbox', who: 'Hale' },
        ],
      ),
    ],
  },
  {
    id: 'D2 frame, unquoted takeover without colon cue',
    scenario: 'd',
    lang: 'en',
    third: false,
    tellers: ['Frame', 'Hale'],
    parts: [
      p(
        `I asked Mrs. Hale who had lived in the house before me. She put down her sewing and was silent for a while, and then she told me the whole story.

I was in service there when I was a girl, and I remember the master well. He was a hard man, but he was fair to me. One winter night he called me into the study.

“Martha,” he said, “can you keep a secret?”

“Yes, sir,” I said.

“Then keep this one.”

He gave me a key, and I have it still.

Here Mrs. Hale stopped and looked at the fire, and I did not like to press her.

“And the key?” I asked at last.

“It is in my workbox,” she said.`,
        [
          { needle: 'I asked Mrs. Hale', who: 'Frame' },
          { needle: 'I was in service', who: 'Hale', soft: true, alt: 'Frame' },
          { needle: '“Martha,', who: 'Master' },
          { needle: '“Yes, sir', who: 'Hale' },
          { needle: '“Then keep this one', who: 'Master' },
          { needle: 'He gave me a key', who: 'Hale', soft: true, alt: 'Frame' },
          { needle: 'Here Mrs. Hale stopped', who: 'Frame' },
          { needle: '“And the key?', who: 'Frame' },
          { needle: '“It is in my workbox', who: 'Hale' },
        ],
      ),
    ],
  },
  {
    id: 'D3 quoted multi-paragraph tale in third person',
    scenario: 'd',
    lang: 'en',
    third: true,
    parts: [
      p(
        `The fire had burned low when old Tom began to speak.

“It was the winter of the great frost,” he said. “I was a boy then, and my father kept the mill.

“One night a stranger knocked at the door. My father let him in and gave him bread.

“We never saw him again. But in the spring the river rose and took every mill in the valley except ours.”

Nobody spoke for a while.

“Is that true?” asked the girl.

“Every word,” said Tom.`,
        [
          { needle: 'The fire had burned', who: 'N' },
          { needle: '“It was the winter', who: 'Tom' },
          { needle: '“One night a stranger', who: 'Tom' },
          { needle: '“We never saw him', who: 'Tom' },
          { needle: 'Nobody spoke', who: 'N' },
          { needle: '“Is that true', who: 'Girl' },
          { needle: '“Every word', who: 'Tom' },
        ],
      ),
    ],
  },

  // ------------------------------------------------------------------ (e) documents
  {
    id: 'E dracula-like: journal, letter, diary',
    scenario: 'e',
    lang: 'en',
    third: false,
    tellers: ['Jonathan', 'Mina', 'Seward'],
    parts: [
      p(
        `JONATHAN HARKER’S JOURNAL

3 May. — I left Munich at eight in the evening and arrived at Vienna early next morning. The train was an hour late, and I had to hurry to catch my connection.

At the inn the landlady met me at the door.

“The Herr Englishman?” she asked.

“Yes,” I said. “Jonathan Harker.”

She smiled and gave me a letter.

LETTER FROM MISS MINA MURRAY TO MISS LUCY WESTENRA

My dearest Lucy,

Forgive my long delay in writing. I have been simply overwhelmed with work, and Jonathan has been away for a month.

Your loving
Mina

DR. SEWARD’S DIARY

25 April. — Ebb tide in appetite today. I cannot eat, cannot rest, so diary instead.

“Is the patient quiet?” I asked the attendant.

“Quiet enough, sir.”`,
        [
          { needle: '3 May', who: 'Jonathan' },
          { needle: 'At the inn', who: 'Jonathan' },
          { needle: '“The Herr Englishman', who: 'Landlady' },
          { needle: '“Yes,” I said', who: 'Jonathan' },
          { needle: 'She smiled', who: 'Jonathan' },
          { needle: 'My dearest Lucy', who: 'Mina', soft: true, alt: 'Jonathan' },
          { needle: 'Forgive my long delay', who: 'Mina', soft: true, alt: 'Jonathan' },
          { needle: '25 April', who: 'Seward', soft: true, alt: 'Jonathan' },
          { needle: '“Is the patient quiet', who: 'Seward' },
          { needle: '“Quiet enough', who: 'Attendant' },
        ],
      ),
    ],
  },

  // ------------------------------------------------------------------ (f) Spanish first person
  {
    id: 'F es first person, pro-drop and "me preguntó"',
    scenario: 'f',
    lang: 'es',
    third: false,
    tellers: ['I'],
    parts: [
      p(
        `Cuando llegué al hospital, mi hermano ya estaba despierto. Me senté junto a la cama y le cogí la mano.

—¿Qué hora es? —me preguntó.

—Las seis —respondí.

—¿De la tarde?

—De la mañana. Has dormido toda la noche.

Entró una enfermera con una bandeja y nos miró a los dos.

—Tiene que comer algo —dijo.

—No tengo hambre —protestó mi hermano.

—Come —le dije—. Hazlo por mí.`,
        [
          { needle: 'Cuando llegué', who: 'I' },
          { needle: '—¿Qué hora es?', who: 'Hermano' },
          { needle: '—Las seis', who: 'I' },
          { needle: '—¿De la tarde?', who: 'Hermano' },
          { needle: '—De la mañana', who: 'I' },
          { needle: 'Entró una enfermera', who: 'I' },
          { needle: '—Tiene que comer', who: 'Enfermera' },
          { needle: '—No tengo hambre', who: 'Hermano' },
          { needle: '—Come —le dije', who: 'I' },
        ],
      ),
    ],
  },

  // ------------------------------------------------------------------ (g) narrator outside the events / mixed
  {
    id: 'G1 es authorial "yo" outside the events',
    scenario: 'g',
    lang: 'es',
    third: true,
    parts: [
      p(
        `En un lugar de la Mancha, de cuyo nombre no quiero acordarme, vivía un hidalgo que se llamaba Alonso Quijano. Yo no sé bien por qué perdió el juicio, pero lo perdió.

Una mañana entró su sobrina en la sala y lo encontró armado.

—¿Adónde va vuestra merced, tío? —preguntó la sobrina.

—A buscar aventuras —respondió don Alonso.

—¿Y quién cuidará de la casa?

—Tú, que eres moza y discreta.`,
        [
          { needle: 'En un lugar', who: 'N' },
          { needle: 'Una mañana', who: 'N' },
          { needle: '—¿Adónde va', who: 'Sobrina' },
          { needle: '—A buscar', who: 'Alonso' },
          { needle: '—¿Y quién', who: 'Sobrina' },
          { needle: '—Tú, que eres', who: 'Alonso' },
        ],
      ),
    ],
  },
  {
    id: 'G2 first-person frame, then third-person chapter',
    scenario: 'g',
    lang: 'en',
    third: false,
    tellers: ['Frame'],
    parts: [
      p(
        `My grandfather told me this story many times when I was a boy, and I have set it down as nearly as I can remember it.

“Write it all,” he said. “Leave nothing out.”

“I will,” I said.`,
        [
          { needle: 'My grandfather', who: 'Frame' },
          { needle: '“Write it all', who: 'Grandfather' },
          { needle: '“I will', who: 'Frame' },
        ],
      ),
      p(
        `CHAPTER ONE

The ship left Bristol on a grey morning in March. Captain Reed stood on the quarterdeck and watched the town fall away behind the masts of the other ships.

“A fair wind, sir,” said the mate.

“Fair enough,” said Reed. “Keep her steady.”`,
        [
          { needle: 'The ship left', who: 'Frame' },
          { needle: '“A fair wind', who: 'Mate' },
          { needle: '“Fair enough', who: 'Reed' },
        ],
      ),
    ],
  },
  {
    id: 'G3 third, then first-person character (Esther), then third',
    scenario: 'g',
    lang: 'en',
    third: false,
    tellers: ['Esther'],
    parts: [
      p(
        `Fog everywhere. Fog up the river and fog down the river, fog in the eyes and throats of the old pensioners, fog in the stem and bowl of the afternoon pipe of the wrathful skipper. In the midst of the fog sits the Lord High Chancellor in his High Court of Chancery.

“Mr. Tangle,” says the Lord High Chancellor.

“Mlud,” says Mr. Tangle.

“Have you nearly concluded your argument?”

“Mlud, no. Variety of points. Feel it my duty to submit.”`,
        [
          { needle: 'Fog everywhere', who: 'N' },
          { needle: '“Mr. Tangle,”', who: 'Chancellor' },
          { needle: '“Mlud,”', who: 'Tangle' },
          { needle: '“Have you nearly', who: 'Chancellor' },
          { needle: '“Mlud, no', who: 'Tangle' },
        ],
      ),
      p(
        `I have a great deal of difficulty in beginning to write my portion of these pages, for I know I am not clever. I always knew that. I can remember, when I was a very little girl indeed, how I used to sit by the fire and talk to my doll when we were alone together.

My godmother came into the room one evening while I sat there.

“Esther,” she said, “go to bed.”

“Yes, godmother,” I said.

“And Esther, say your prayers.”

“I will, godmother.”`,
        [
          { needle: 'I have a great deal', who: 'Esther' },
          { needle: 'My godmother came', who: 'Esther' },
          { needle: '“Esther,”', who: 'Godmother' },
          { needle: '“Yes, godmother', who: 'Esther' },
          { needle: '“And Esther', who: 'Godmother' },
          { needle: '“I will, godmother', who: 'Esther' },
        ],
      ),
      p(
        `While Esther sleeps, and while Esther wakes, it is still foggy weather down in Lincolnshire. Sir Leicester Dedlock sits in his library and looks out at the rain on the terrace.

“My dear,” says Sir Leicester to his lady, “you are tired.”

“Bored to death,” says Lady Dedlock.`,
        [
          { needle: 'While Esther sleeps', who: 'N' },
          { needle: '“My dear,”', who: 'Leicester' },
          { needle: '“Bored to death', who: 'Lady Dedlock' },
        ],
      ),
    ],
  },
];
