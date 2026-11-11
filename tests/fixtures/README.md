# Test fixtures

Public-domain excerpts from Project Gutenberg, and passages written for these tests, stored as
canonical text (LF line endings, no BOM). `.gitattributes` keeps this folder byte-exact.

| File | Source | Excerpt |
|---|---|---|
| `en/pride-ch1.txt` | Jane Austen, *Pride and Prejudice* (Gutenberg #1342) | Chapter 1, with one `[Illustration: …]` block removed |
| `es/marianela-ch1.txt` | Benito Pérez Galdós, *Marianela* (Gutenberg #17340) | End of chapter I, from "--Esta es una situación divina" |
| `en/lighthouse.txt` | Original passage written for these tests | A first-person narrator, Kit, whom others address by name |
| `es/abuela.txt` | Original passage written for these tests | A first-person narrator, Inés, with dash dialogue and pro-drop tags ("—respondí") |

Each `.epub.txt` is the canonical text expected when the same excerpt is imported from an EPUB
(one `<p>` per paragraph): HTML rendering joins the hard-wrapped lines, so it differs from the
`.txt`. It was written by collapsing whitespace inside each paragraph, independently of the EPUB
importer.

Each `.labels.json` lists every speech span (`start`/`end` offsets and exact `text`) with the
person who says it, assigned by hand. `people` maps each person to the names and descriptors the
text uses for them; a predicted character counts as correct if its name is one of those. In the
first-person passages the narrator's own lines count only when the narrator entry ("Narrator")
voices them, so a duplicate character named after the narrator is a miss.

The heuristic was developed against these excerpts and against the short stories in
`tests/helpers/heldoutStories.ts`, so its scores on them are optimistic.
