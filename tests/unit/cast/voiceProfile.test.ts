import { describe, expect, it } from 'vitest';
import { voiceProfile } from '@/cast/voiceProfile';

const profile = (name: string, lang = 'en-US') => voiceProfile({ name, lang });

const FEMALE = { gender: 'female' };
const MALE = { gender: 'male' };

describe('voiceProfile', () => {
  describe('explicit gender in the name', () => {
    it('reads a gender word that is a whole token', () => {
      expect(profile('Google UK English Female', 'en-GB')).toStrictEqual(FEMALE);
      expect(profile('Google UK English Male', 'en-GB')).toStrictEqual(MALE);
      expect(profile('com.apple.ttsbundle.siri_female_en-US_compact')).toStrictEqual(FEMALE);
      expect(profile('com.apple.ttsbundle.siri_male_en-GB_compact', 'en-GB')).toStrictEqual(MALE);
      expect(profile('English woman 2')).toStrictEqual(FEMALE);
      expect(profile('English (man)')).toStrictEqual(MALE);
      expect(profile('Voz de mujer', 'es-ES')).toStrictEqual(FEMALE);
      expect(profile('Español - Hombre', 'es-ES')).toStrictEqual(MALE);
      expect(profile('Voz femenina 1', 'es-ES')).toStrictEqual(FEMALE);
      expect(profile('Español (masculino)', 'es-ES')).toStrictEqual(MALE);
    });

    it('never reads "female" as "male", nor a gender word inside a longer word', () => {
      expect(profile('FEMALE')).toStrictEqual(FEMALE);
      expect(profile('voice-female-2')).toStrictEqual(FEMALE);
      expect(profile('en-us-x-zzz#female_2-local')).toStrictEqual(FEMALE);
      expect(profile('Germany')).toStrictEqual({});
      expect(profile('English (Isle of Mann)')).toStrictEqual({});
      expect(profile('Romana', 'es-ES')).toStrictEqual({});
      expect(profile('Superhombre', 'es-ES')).toStrictEqual({});
    });

    it('lets a "#male_N" or "#female_N" suffix beat the Android voice code', () => {
      // rjs is a male voice and sfg a female one, yet older engines list these variants.
      expect(profile('en-gb-x-rjs#female_1-local', 'en-GB')).toStrictEqual(FEMALE);
      expect(profile('en-gb-x-rjs#female_2-local', 'en-GB')).toStrictEqual(FEMALE);
      expect(profile('en-gb-x-rjs#male_1-local', 'en-GB')).toStrictEqual(MALE);
      expect(profile('en-gb-x-fis#female_1-local', 'en-GB')).toStrictEqual(FEMALE);
      expect(profile('en-us-x-sfg#male_1-local')).toStrictEqual(MALE);
      expect(profile('en-us-x-sfg#female_1-network')).toStrictEqual(FEMALE);
    });
  });

  describe('Google voices on Android', () => {
    it.each([
      ['en-us', 'tpc iob iog tpf sfg', 'iom iol tpd'],
      ['en-gb', 'gba gbc gbg fis', 'rjs gbb gbd'],
      ['en-au', 'aua auc afh', 'aub aud'],
      ['en-in', 'ena enc ahp cxx', 'end ene'],
      ['en-ng', 'tfn', ''],
      ['es-es', 'eee eea eec ana', 'eed eef'],
      ['es-us', 'esc sfb', 'esd esf'],
    ])('knows the %s voice codes, local or network', (locale, female, male) => {
      for (const code of female.split(' ')) {
        expect(profile(`${locale}-x-${code}-local`, locale)).toStrictEqual(FEMALE);
        expect(profile(`${locale}-x-${code}-network`, locale)).toStrictEqual(FEMALE);
      }
      for (const code of male.split(' ').filter(Boolean)) {
        expect(profile(`${locale}-x-${code}-local`, locale)).toStrictEqual(MALE);
        expect(profile(`${locale}-x-${code}-network`, locale)).toStrictEqual(MALE);
      }
    });

    it('reads the code whatever the case and the language the voice reports', () => {
      expect(profile('ES-ES-X-EEE-LOCAL', 'es-ES')).toStrictEqual(FEMALE);
      expect(profile('es-es-x-eed-local', 'es_ES')).toStrictEqual(MALE);
      expect(profile('en-us-x-iom-local', '')).toStrictEqual(MALE);
    });

    it('reads the code after the engine name Chrome OS puts before it', () => {
      const engine = 'Android Speech Recognition and Synthesis from Google';
      expect(profile(`${engine} en-us-x-tpd-network`)).toStrictEqual(MALE);
      expect(profile(`${engine} es-es-x-eee-local`, 'es-ES')).toStrictEqual(FEMALE);
      expect(profile(`${engine} en-GB-language`, 'en-GB')).toStrictEqual(FEMALE);
    });

    it('takes a code by its locale: the same letters elsewhere say nothing', () => {
      expect(profile('es-es-x-sfg-local', 'es-ES')).toStrictEqual({});
      expect(profile('en-us-x-eed-local')).toStrictEqual({});
      expect(profile('en-gb-x-tpc-local', 'en-GB')).toStrictEqual({});
    });

    it('knows no Mexican Spanish voice and no code it has not seen', () => {
      expect(profile('es-mx-x-eee-local', 'es-MX')).toStrictEqual({});
      expect(profile('es-MX-language', 'es-MX')).toStrictEqual({});
      expect(profile('en-us-x-zzz-local')).toStrictEqual({});
      expect(profile('fr-fr-x-vlf-local', 'fr-FR')).toStrictEqual({});
    });

    it('does not take a voice code for a first name', () => {
      // "ana" is a Spanish voice code, not the Microsoft child voice Ana; "sam" is no code at all.
      expect(profile('es-es-x-ana-local', 'es-ES')).toStrictEqual(FEMALE);
      expect(profile('en-us-x-ana-local')).toStrictEqual({});
      expect(profile('en-us-x-sam-local')).toStrictEqual({});
    });

    it.each(['en-US', 'en-GB', 'en-AU', 'en-IN', 'en-NG', 'es-ES', 'es-US'])(
      'takes the default voice %s-language as female',
      (locale) => {
        expect(profile(`${locale}-language`, locale)).toStrictEqual(FEMALE);
        expect(profile(`${locale.toLowerCase()}-language`, locale)).toStrictEqual(FEMALE);
      },
    );

    it('says nothing about the default voice of other locales', () => {
      expect(profile('en-CA-language', 'en-CA')).toStrictEqual({});
      expect(profile('es-AR-language', 'es-AR')).toStrictEqual({});
    });
  });

  describe('Google voices in Chrome', () => {
    it('knows the desktop voices by their exact name', () => {
      expect(profile('Google US English')).toStrictEqual(FEMALE);
      expect(profile('google us english')).toStrictEqual(FEMALE);
      expect(profile('Google español', 'es-ES')).toStrictEqual(MALE);
      expect(profile('Google español de Estados Unidos', 'es-US')).toStrictEqual(FEMALE);
      // A Google voice of a language outside the table.
      expect(profile('Google Deutsch', 'de-DE')).toStrictEqual({});
      expect(profile('Google UK English', 'en-GB')).toStrictEqual({});
    });

    it('knows the numbered Chrome OS voices', () => {
      for (const n of [1, 2, 5, 7]) {
        expect(profile(`Google US English ${n} (Natural)`)).toStrictEqual(FEMALE);
        expect(profile(`Chrome OS US English ${n}`)).toStrictEqual(FEMALE);
      }
      expect(profile('Chrome OS US English 8')).toStrictEqual(FEMALE);
      for (const n of [3, 4, 6]) {
        expect(profile(`Google US English ${n} (Natural)`)).toStrictEqual(MALE);
        expect(profile(`Chrome OS US English ${n}`)).toStrictEqual(MALE);
      }
      for (const n of [2, 4, 6]) {
        expect(profile(`Google UK English ${n}`, 'en-GB')).toStrictEqual(FEMALE);
      }
      for (const n of [1, 3, 5]) {
        expect(profile(`Google UK English ${n}`, 'en-GB')).toStrictEqual(MALE);
      }
      expect(profile('Chrome OS UK English 7', 'en-GB')).toStrictEqual(FEMALE);
      expect(profile('Google Australian English 1', 'en-AU')).toStrictEqual(FEMALE);
      expect(profile('Google Australian English 3', 'en-AU')).toStrictEqual(FEMALE);
      expect(profile('Google Australian English 2', 'en-AU')).toStrictEqual(MALE);
      expect(profile('Google Australian English 4', 'en-AU')).toStrictEqual(MALE);
      expect(profile('Chrome OS Australian English 5', 'en-AU')).toStrictEqual(MALE);
      // The numbered Spanish voices do not all share the gender of the unnumbered one.
      for (const n of [1, 2, 4]) {
        expect(profile(`Google español ${n}`, 'es-ES')).toStrictEqual(FEMALE);
      }
      expect(profile('Google español 3', 'es-ES')).toStrictEqual(MALE);
      expect(profile('Google español 5', 'es-ES')).toStrictEqual(MALE);
      expect(profile('Google español de Estados Unidos 1', 'es-US')).toStrictEqual(FEMALE);
      expect(profile('Google español de Estados Unidos 2', 'es-US')).toStrictEqual(FEMALE);
      expect(profile('Google español de Estados Unidos 3', 'es-US')).toStrictEqual(MALE);
      expect(profile('Google español de Estados Unidos 4', 'es-US')).toStrictEqual(MALE);
    });

    it('reads a number it does not know as the unnumbered voice', () => {
      expect(profile('Google US English 12 (Natural)')).toStrictEqual(FEMALE);
      expect(profile('Google español 9', 'es-ES')).toStrictEqual(MALE);
      expect(profile('Google UK English 9', 'en-GB')).toStrictEqual({});
      expect(profile('Chrome OS UK English 2', 'en-GB')).toStrictEqual({});
      expect(profile('Chrome OS Australian English 1', 'en-AU')).toStrictEqual({});
    });
  });

  describe('voices known by a first name', () => {
    it('finds the name in Microsoft display names', () => {
      expect(profile('Microsoft Zira - English (United States)')).toStrictEqual(FEMALE);
      expect(profile('Microsoft Zira Desktop - English (United States)')).toStrictEqual(FEMALE);
      expect(profile('Microsoft David - English (United States)')).toStrictEqual(MALE);
      expect(profile('Microsoft Mark - English (United States)')).toStrictEqual(MALE);
      expect(profile('Microsoft George - English (United Kingdom)', 'en-GB')).toStrictEqual(MALE);
      expect(profile('Microsoft Hazel Desktop - English (Great Britain)', 'en-GB')).toStrictEqual(
        FEMALE,
      );
      expect(profile('Microsoft James - English (Australia)', 'en-AU')).toStrictEqual(MALE);
      expect(profile('Microsoft Helena - Spanish (Spain)', 'es-ES')).toStrictEqual(FEMALE);
      expect(profile('Microsoft Pablo - Spanish (Spain)', 'es-ES')).toStrictEqual(MALE);
      expect(profile('Microsoft Sabina - Spanish (Mexico)', 'es-MX')).toStrictEqual(FEMALE);
      expect(profile('Microsoft Raul - Spanish (Mexico)', 'es-MX')).toStrictEqual(MALE);
      expect(profile('Microsoft Aria Online (Natural) - English (United States)')).toStrictEqual(
        FEMALE,
      );
      expect(profile('Microsoft Guy Online (Natural) - English (United States)')).toStrictEqual(
        MALE,
      );
      expect(profile('Microsoft Elvira Online (Natural) - Spanish (Spain)', 'es-ES')).toStrictEqual(
        FEMALE,
      );
      expect(profile('Microsoft Jorge Online (Natural) - Spanish (Mexico)', 'es-MX')).toStrictEqual(
        MALE,
      );
      expect(profile('Microsoft Sam Online (Natural) - English (Hongkong)', 'en-HK')).toStrictEqual(
        MALE,
      );
      expect(
        profile('Microsoft AndrewMultilingual Online (Natural) - English (United States)'),
      ).toStrictEqual(MALE);
      expect(
        profile('Microsoft AvaMultilingual Online (Natural) - English (United States)'),
      ).toStrictEqual(FEMALE);
    });

    it('finds the name in the voice URI Firefox builds on Windows', () => {
      expect(
        profile('urn:moz-tts:sapi:Microsoft Zira Desktop - English (United States)?en-US'),
      ).toStrictEqual(FEMALE);
      expect(
        profile('urn:moz-tts:sapi:Microsoft David Desktop - English (United States)?en-US'),
      ).toStrictEqual(MALE);
    });

    it('finds the name in Apple display names', () => {
      expect(profile('Samantha')).toStrictEqual(FEMALE);
      expect(profile('Alex')).toStrictEqual(MALE);
      expect(profile('Daniel', 'en-GB')).toStrictEqual(MALE);
      expect(profile('Karen', 'en-AU')).toStrictEqual(FEMALE);
      expect(profile('Paulina', 'es-MX')).toStrictEqual(FEMALE);
      expect(profile('Juan', 'es-MX')).toStrictEqual(MALE);
      expect(profile('Samantha (Enhanced)')).toStrictEqual(FEMALE);
      expect(profile('Eddy (English (US))')).toStrictEqual(MALE);
      expect(profile('Flo (Spanish (Spain))', 'es-ES')).toStrictEqual(FEMALE);
      expect(profile('Shelley (English (UK))', 'en-GB')).toStrictEqual(FEMALE);
      expect(profile('Rocko (Spanish (Mexico))', 'es-MX')).toStrictEqual(MALE);
    });

    it('finds the name in Safari identifiers, whatever the case of the suffix', () => {
      expect(profile('com.apple.voice.compact.en-US.Samantha')).toStrictEqual(FEMALE);
      expect(profile('com.apple.voice.compact.es-ES.Monica', 'es-ES')).toStrictEqual(FEMALE);
      expect(profile('com.apple.voice.enhanced.es-CL.Francisca', 'es-CL')).toStrictEqual(FEMALE);
      expect(profile('com.apple.voice.premium.en-GB.Serena', 'en-GB')).toStrictEqual(FEMALE);
      expect(profile('com.apple.voice.compact.en-AU.Lee', 'en-AU')).toStrictEqual(MALE);
      expect(profile('com.apple.eloquence.es-MX.Eddy', 'es-MX')).toStrictEqual(MALE);
      expect(profile('com.apple.eloquence.en-US.Reed')).toStrictEqual(MALE);
      expect(profile('com.apple.ttsbundle.siri_Aaron_en-US_compact')).toStrictEqual(MALE);
      expect(profile('com.apple.ttsbundle.siri_Nicky_en-US_compact')).toStrictEqual(FEMALE);
      expect(profile('com.apple.ttsbundle.Samantha-compact')).toStrictEqual(FEMALE);
      expect(profile('com.apple.speech.synthesis.voice.samantha')).toStrictEqual(FEMALE);
      expect(profile('com.apple.speech.synthesis.voice.samantha.premium')).toStrictEqual(FEMALE);
      expect(profile('com.apple.speech.synthesis.voice.Alex')).toStrictEqual(MALE);
      expect(profile('com.apple.speech.synthesis.voice.Victoria')).toStrictEqual(FEMALE);
      expect(profile('com.apple.speech.synthesis.voice.jorge', 'es-ES')).toStrictEqual(MALE);
    });

    it('finds the name in the voice URI Firefox builds on macOS', () => {
      expect(
        profile('urn:moz-tts:osx:com.apple.speech.synthesis.voice.daniel', 'en-GB'),
      ).toStrictEqual(MALE);
      expect(
        profile('urn:moz-tts:osx:com.apple.speech.synthesis.voice.monica', 'es-ES'),
      ).toStrictEqual(FEMALE);
    });

    it('ignores accents: Mónica is Monica', () => {
      expect(profile('Mónica', 'es-ES')).toStrictEqual(FEMALE);
      expect(profile('Monica', 'es-ES')).toStrictEqual(FEMALE);
      // The same name with the accent written as a separate combining mark.
      const decomposed = `Mo${String.fromCodePoint(0x301)}nica`;
      expect(decomposed).toHaveLength(7);
      expect(profile(decomposed, 'es-ES')).toStrictEqual(FEMALE);
      expect(profile('Microsoft Álvaro Online (Natural) - Spanish (Spain)', 'es-ES')).toStrictEqual(
        MALE,
      );
      expect(profile('Microsoft Raúl - Spanish (Mexico)', 'es-MX')).toStrictEqual(MALE);
    });

    it('knows every first name the research confirmed', () => {
      const female =
        'Zira Hazel Susan Catherine Linda Heera Helena Laura Sabina Hayley Heather Hilda ' +
        'Aria Jenny Michelle Emma Ava Sonia Libby Natasha Clara Neerja Emily Leah Molly Yan Luna ' +
        'Asilia Ezinne Rosa Imani Elvira Dalia Paloma Elena Sofía Catalina Salomé Ximena María ' +
        'Belkys Ramona Andrea Lorena Teresa Marta Karla Yolanda Margarita Tania Camila Karina ' +
        'Valentina Paola Samantha Allison Nicky Zoe Victoria Vicki Agnes Kate Serena Martha ' +
        'Stephanie Fiona Karen Matilda Moira Tessa Veena Isha Sangeeta Tara Mónica Marisol ' +
        'Paulina Angélica Isabela Francisca Soledad Jimena Kathy Shelley Flo Sandy';
      const male =
        'David Mark George James Richard Ravi Sean Pablo Raúl Guy Eric Steffan Christopher Roger ' +
        'Andrew Brian Ryan Thomas William Liam Prabhat Connor Luke Mitchell Sam Wayne Chilemba ' +
        'Abeo Elimu Álvaro Jorge Alonso Tomás Marcelo Lorenzo Gonzalo Juan Manuel Emilio Luis ' +
        'Rodrigo Javier Andrés Carlos Federico Roberto Mario Alex Víctor Mateo Sebastián Tom ' +
        'Aaron Evan Nathan Bruce Daniel Oliver Arthur Jamie Lee Gordon Rishi Aman Diego Fred ' +
        'Ralph Reed Eddy Rocko';
      for (const name of female.split(' ')) {
        expect(profile(name), name).toStrictEqual(FEMALE);
        expect(profile(name, 'es-ES'), name).toStrictEqual(FEMALE);
      }
      for (const name of male.split(' ')) {
        expect(profile(name), name).toStrictEqual(MALE);
        expect(profile(name, 'es-ES'), name).toStrictEqual(MALE);
      }
    });

    it('gives a first name shared by engines the same gender everywhere', () => {
      expect(profile('Microsoft Catherine - English (Australia)', 'en-AU')).toStrictEqual(FEMALE);
      expect(profile('com.apple.ttsbundle.siri_Catherine_en-AU_compact', 'en-AU')).toStrictEqual(
        FEMALE,
      );
      expect(profile('Microsoft Jorge Online (Natural) - Spanish (Mexico)', 'es-MX')).toStrictEqual(
        MALE,
      );
      expect(profile('com.apple.voice.compact.es-ES.Jorge', 'es-ES')).toStrictEqual(MALE);
      expect(profile('Microsoft Alex Online (Natural) - Spanish (Peru)', 'es-PE')).toStrictEqual(
        MALE,
      );
      expect(profile('com.apple.speech.synthesis.voice.Alex')).toStrictEqual(MALE);
      expect(profile('Microsoft Ava Online (Natural) - English (United States)')).toStrictEqual(
        FEMALE,
      );
      expect(profile('com.apple.voice.premium.en-US.Ava')).toStrictEqual(FEMALE);
      expect(profile('Microsoft Susan - English (United Kingdom)', 'en-GB')).toStrictEqual(FEMALE);
      expect(profile('com.apple.speech.synthesis.voice.susan')).toStrictEqual(FEMALE);
    });

    it('matches whole tokens only, never a name inside a longer word', () => {
      // sam/Samantha, eric/America, ana/Ghana, mark/Denmark, tom/Custom, lee/Leeds, flo/Florida.
      expect(profile('Samantha')).toStrictEqual(FEMALE);
      expect(profile('Spanish (Latin America)', 'es-419')).toStrictEqual({});
      expect(profile('English (Ghana)', 'en-GH')).toStrictEqual({});
      expect(profile('English (Denmark)', 'en-DK')).toStrictEqual({});
      expect(profile('Custom voice')).toStrictEqual({});
      expect(profile('English (Leeds)', 'en-GB')).toStrictEqual({});
      expect(profile('English (Florida)')).toStrictEqual({});
      expect(profile('Alexa')).toStrictEqual({});
      expect(profile('Rosario', 'es-AR')).toStrictEqual({});
    });

    it('does not fire on the ordinary words of a voice name', () => {
      for (const name of [
        'English',
        'Spanish',
        'Spain',
        'States',
        'Mexico',
        'Natural',
        'Online',
        'Desktop',
        'compact',
        'enhanced',
        'premium',
        'siri',
        'English (United States)',
        'English (United Kingdom)',
        'Spanish (Spain)',
        'Spanish (Mexico)',
        'español (Estados Unidos)',
        'Microsoft Online (Natural) - English (United States)',
        'Microsoft Desktop - Spanish (Mexico)',
        'com.apple.voice.compact.en-US',
        'com.apple.voice.enhanced.es-MX',
        'com.apple.voice.premium.en-GB',
        'com.apple.ttsbundle.siri_en-US_compact',
        'com.apple.eloquence.es-ES',
        'com.apple.speech.synthesis.voice',
        'urn:moz-tts:osx:com.apple.speech.synthesis.voice',
        'Multilingual',
      ]) {
        expect(profile(name), name).toStrictEqual({});
        expect(profile(name, 'es-MX'), name).toStrictEqual({});
      }
    });
  });

  describe('child and elder voices', () => {
    it('marks the child voices', () => {
      const girl = { gender: 'female', age: 'child' };
      expect(profile('Microsoft Ana Online (Natural) - English (United States)')).toStrictEqual(
        girl,
      );
      expect(
        profile('Microsoft Maisie Online (Natural) - English (United Kingdom)', 'en-GB'),
      ).toStrictEqual(girl);
      expect(profile('Joelle')).toStrictEqual(girl);
      expect(profile('com.apple.voice.compact.en-US.Joelle')).toStrictEqual(girl);
      const boy = { gender: 'male', age: 'child' };
      expect(profile('Junior')).toStrictEqual(boy);
      expect(profile('com.apple.speech.synthesis.voice.Junior')).toStrictEqual(boy);
      expect(profile('com.apple.speech.synthesis.voice.junior')).toStrictEqual(boy);
    });

    it('takes Ana for the child voice only among English voices', () => {
      expect(
        profile('Microsoft Ana Online (Natural) - English (United States)', 'en_US'),
      ).toStrictEqual({ gender: 'female', age: 'child' });
      expect(profile('Ana', 'EN-us')).toStrictEqual({ gender: 'female', age: 'child' });
      expect(profile('Ana', 'es-ES')).toStrictEqual({});
      expect(profile('Microsoft Ana - Spanish (Spain)', 'es-ES')).toStrictEqual({});
      expect(profile('Ana', '')).toStrictEqual({});
    });

    it('marks the Eloquence grandparents as elder, in every language they come in', () => {
      const grandma = { gender: 'female', age: 'elder' };
      const grandpa = { gender: 'male', age: 'elder' };
      expect(profile('Grandma (English (US))')).toStrictEqual(grandma);
      expect(profile('Grandma (Spanish (Mexico))', 'es-MX')).toStrictEqual(grandma);
      expect(profile('com.apple.eloquence.en-US.Grandma')).toStrictEqual(grandma);
      expect(profile('Grandpa (English (UK))', 'en-GB')).toStrictEqual(grandpa);
      expect(profile('com.apple.eloquence.es-ES.Grandpa', 'es-ES')).toStrictEqual(grandpa);
      expect(profile('com.apple.eloquence.es-MX.grandpa', 'es-MX')).toStrictEqual(grandpa);
    });

    it('gives the other voices no age', () => {
      expect(profile('com.apple.eloquence.en-US.Sandy')).toStrictEqual(FEMALE);
      expect(profile('es-es-x-ana-local', 'es-ES')).toStrictEqual(FEMALE);
    });
  });

  describe('novelty and robotic voices', () => {
    const NOVELTY = { novelty: true };
    const ROBOT = { robotic: true, novelty: true };

    it('marks the macOS robot voices as robotic and novelty', () => {
      expect(profile('Zarvox')).toStrictEqual(ROBOT);
      expect(profile('Trinoids')).toStrictEqual(ROBOT);
      expect(profile('com.apple.speech.synthesis.voice.Zarvox')).toStrictEqual(ROBOT);
      expect(profile('com.apple.speech.synthesis.voice.zarvox')).toStrictEqual(ROBOT);
      expect(profile('com.apple.speech.synthesis.voice.Trinoids')).toStrictEqual(ROBOT);
      expect(profile('urn:moz-tts:osx:com.apple.speech.synthesis.voice.trinoids')).toStrictEqual(
        ROBOT,
      );
      expect(profile('Zarvox (English (United States))')).toStrictEqual(ROBOT);
    });

    it.each([
      'Cellos',
      'Good News',
      'Bad News',
      'Organ',
      'Pipe Organ',
      'Bells',
      'Boing',
      'Bubbles',
      'Bahh',
      'Wobble',
      'Whisper',
      'Albert',
      'Jester',
      'Superstar',
      'Princess',
    ])('marks the macOS voice "%s" as novelty, with no gender', (name) => {
      expect(profile(name)).toStrictEqual(NOVELTY);
      expect(profile(`${name} (English (United States))`)).toStrictEqual(NOVELTY);
    });

    it.each([
      'Violonchelos',
      'Buenas noticias',
      'Malas noticias',
      'Órgano',
      'Campanas',
      'Burbujas',
      'Susurro',
      'Bufón',
      'Superestrella',
    ])('marks the Spanish display name "%s" as novelty', (name) => {
      expect(profile(name)).toStrictEqual(NOVELTY);
      expect(profile(`${name} (inglés (EE. UU.))`)).toStrictEqual(NOVELTY);
    });

    it.each([
      'Cellos',
      'GoodNews',
      'BadNews',
      'Organ',
      'Bells',
      'Boing',
      'Bubbles',
      'Bahh',
      'Deranged',
      'Whisper',
      'Albert',
      'Hysterical',
      'Princess',
    ])('marks the identifier suffix "%s" as novelty, whatever its case', (suffix) => {
      expect(profile(`com.apple.speech.synthesis.voice.${suffix}`)).toStrictEqual(NOVELTY);
      expect(profile(`com.apple.speech.synthesis.voice.${suffix.toLowerCase()}`)).toStrictEqual(
        NOVELTY,
      );
      expect(
        profile(`urn:moz-tts:osx:com.apple.speech.synthesis.voice.${suffix.toLowerCase()}`),
      ).toStrictEqual(NOVELTY);
    });

    it('takes a novelty name only when it is the whole voice name', () => {
      expect(profile('Microsoft Albert - English (United States)')).toStrictEqual({});
      expect(profile('English (Organ)')).toStrictEqual({});
      expect(profile('Good')).toStrictEqual({});
      expect(profile('News')).toStrictEqual({});
      expect(profile('com.apple.voice.compact.en-US.Samantha')).toStrictEqual(FEMALE);
    });

    it('keeps the legacy MacinTalk and Eloquence voices as normal gendered voices', () => {
      expect(profile('Fred')).toStrictEqual(MALE);
      expect(profile('com.apple.speech.synthesis.voice.Fred')).toStrictEqual(MALE);
      expect(profile('Ralph')).toStrictEqual(MALE);
      expect(profile('com.apple.speech.synthesis.voice.ralph')).toStrictEqual(MALE);
      expect(profile('Kathy')).toStrictEqual(FEMALE);
      expect(profile('com.apple.speech.synthesis.voice.Kathy')).toStrictEqual(FEMALE);
      expect(profile('Reed (English (US))')).toStrictEqual(MALE);
      expect(profile('Shelley (Spanish (Spain))', 'es-ES')).toStrictEqual(FEMALE);
    });
  });

  describe('unknown voices', () => {
    it.each([
      'es-default',
      'es-two',
      'es-cloud',
      'es-three',
      'en-one',
      'en-a',
      'en-b',
      'only',
      'v',
    ])('says nothing about the made-up name "%s"', (name) => {
      expect(profile(name, 'es-ES')).toStrictEqual({});
      expect(profile(name, 'en-GB')).toStrictEqual({});
    });

    it('says nothing about names it cannot read', () => {
      expect(profile('')).toStrictEqual({});
      expect(profile('   ')).toStrictEqual({});
      expect(profile('1234')).toStrictEqual({});
      expect(profile('English United States')).toStrictEqual({});
      expect(profile('com.samsung.SMT.lang_es_us_f00', 'es-US')).toStrictEqual({});
      expect(profile('Microsoft Zofia - Polish (Poland)', 'pl-PL')).toStrictEqual({});
      // Words every JavaScript object knows must not be taken for table entries.
      expect(profile('constructor')).toStrictEqual({});
      expect(profile('toString valueOf __proto__')).toStrictEqual({});
    });

    it('returns a fresh object each time, never a shared table entry', () => {
      const first = voiceProfile({ name: 'Zarvox', lang: 'en-US' });
      first.novelty = false;
      expect(profile('Zarvox')).toStrictEqual({ robotic: true, novelty: true });
      const grandma = voiceProfile({ name: 'Grandma (English (US))', lang: 'en-US' });
      delete grandma.age;
      expect(profile('Grandma (English (US))')).toStrictEqual({ gender: 'female', age: 'elder' });
    });
  });
});
