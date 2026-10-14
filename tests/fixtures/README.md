# Test fixtures

Public-domain excerpts from Project Gutenberg, stored as canonical text (LF line endings, no BOM).
`.gitattributes` keeps this folder byte-exact.

| File | Source | Excerpt |
|---|---|---|
| `en/pride-ch1.txt` | Jane Austen, *Pride and Prejudice* (Gutenberg #1342) | Chapter 1, with one `[Illustration: …]` block removed |
| `es/marianela-ch1.txt` | Benito Pérez Galdós, *Marianela* (Gutenberg #17340) | End of chapter I, from "--Esta es una situación divina" |

Each `.labels.json` lists every speech span (`start`/`end` offsets and exact `text`) with the
person who says it, assigned by hand. `people` maps each person to the names and descriptors the
text uses for them; a predicted character counts as correct if its name is one of those.

The heuristic was developed against these two excerpts, so its scores here are optimistic.
