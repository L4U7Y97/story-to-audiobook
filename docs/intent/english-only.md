# Intent: English-only analyzer

Confirmed with the user on 2026-11-13 via an interview-me session. It replaces the "Languages" line of [story-to-audiobook.md](story-to-audiobook.md): the app is English-only.

- **Outcome:** Three steps, in this order.
  1. The app becomes English-only. Spanish is removed from the analyzer's rules and word lists, dash and «» dialogue, the "Don/Doña" cast titles, the Spanish traits, the LLM prompt, the language picker, the voice preview, the default names, the `es` fixtures, SPEC.md and the intent doc.
  2. Single-quoted emphasis or thoughts inside narration are read by the narrator.
  3. A code-only cleanup of the English analyzer: dead code goes, duplicate helpers are merged, and `src/analysis/heuristic/index.ts` is split into smaller files, one per job.
- **User:** The author, listening to English web fiction on an Android phone.
- **Why now:** Two languages meant more dev time and more ways to introduce errors. Single-quoted words kept going to random cast members.
- **Success:**
  - No Spanish is left in the code, tests or docs, and the English tests pass.
  - After steps 1 and 2, a before/after run of the free analyzer on four books (_Beware of Chicken_, _She of Many Dragons_, _Beneath the Dragoneye Moons_ book 1, _Spores and Sorcery_ book 3) changes only single-quoted text and the places where Spanish had leaked into English, such as "Don" read as a Spanish title.
  - Single-quoted text inside a sentence goes to the narrator. A single-quoted line stays dialogue when it opens its paragraph, or starts a sentence with a speech tag right after it ("Bi De asked").
  - After step 3, the same run gives exactly the same labels, and the analyzer code is smaller.
- **Constraint:** No migration or compatibility work. Stories and backups already on the app may break; they can be re-analysed.
- **Out of scope:** Other wrong speakers, any change to results during the cleanup, other languages, and who gets a single-quoted line that opens a paragraph (it stays as it is).

## Decisions and why

| Decision                                                   | Reason                                                                                                                         |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Remove Spanish instead of splitting it into its own analyzer | Two languages doubled the rules to write and test, and the author listens to English books                                     |
| Remove it from the whole app, not only the free analyzer   | A Spanish story with no free analyzer would break the rule that the app works with no paid services                            |
| Single quotes inside a sentence go to the narrator         | In the four books, 290 single-quoted bits sit inside a sentence and none is followed by a speech tag: they are emphasis or thoughts |
| Single quotes that open a paragraph stay dialogue          | _Beware of Chicken_ uses them for the animals' speech ("Bi De asked", "Tigu sneered")                                          |
| The cleanup changes no results                             | Its proof is identical labels on the four books; fixing other speakers needs its own examples                                  |
