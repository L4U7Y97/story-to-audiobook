<script setup lang="ts">
import { computed, ref, shallowRef } from 'vue';
import type { Part } from '@/format/types';
import { combineChapters, EpubError, parseEpub, type EpubBook } from '@/ingest/epub';
import { getAppDb } from '@/storage/db';
import { addPart } from '@/storage/parts';

/** `position` is in reading order, or within the book when `bookId` is given. */
const props = defineProps<{ storyId: string; position: number; bookId?: string }>();
const emit = defineEmits<{ imported: [parts: Part[]] }>();

/** Sections that are almost never part of the story itself. */
const BOILERPLATE = /licen[cs]e|copyright|contents|índice|table of contents|project gutenberg/iu;

// Shallow: chapters must stay plain objects so IndexedDB can store them (no reactive proxies).
const book = shallowRef<EpubBook>();
const fileName = ref('');
const selected = ref<boolean[]>([]);
const combine = ref(false);
const loading = ref(false);
const error = ref('');

const chosen = computed(() => book.value?.chapters.filter((_, i) => selected.value[i]) ?? []);

function words(text: string): number {
  return text.split(/\s+/u).filter(Boolean).length;
}

async function onFileChange(event: Event) {
  const picked = (event.target as HTMLInputElement).files?.[0];
  book.value = undefined;
  error.value = '';
  if (!picked) return;
  loading.value = true;
  try {
    book.value = await parseEpub(picked);
    fileName.value = picked.name;
    // Pre-select real chapters: very short sections are usually title pages, and licences,
    // copyright notes and tables of contents are not part of the story.
    selected.value = book.value.chapters.map(
      (c) => words(c.text) >= 150 && !BOILERPLATE.test(c.title),
    );
    if (!selected.value.some(Boolean)) selected.value = selected.value.map(() => true);
  } catch (e) {
    error.value = e instanceof EpubError ? e.message : 'This EPUB could not be read.';
  } finally {
    loading.value = false;
  }
}

async function importChapters() {
  if (!chosen.value.length) return;
  loading.value = true;
  error.value = '';
  try {
    const db = getAppDb();
    const book = props.bookId ? { bookId: props.bookId } : {};
    const source = (href?: string) => ({
      kind: 'epub' as const,
      fileName: fileName.value,
      epubHref: href,
    });
    const parts: Part[] = [];
    if (combine.value) {
      const { text, hints } = combineChapters(chosen.value);
      const title =
        chosen.value.length === 1
          ? chosen.value[0]!.title
          : `${chosen.value[0]!.title} – ${chosen.value.at(-1)!.title}`;
      parts.push(
        await addPart(
          db,
          props.storyId,
          { title, source: source(), text, hints, ...book },
          props.position,
        ),
      );
    } else {
      for (const [i, c] of chosen.value.entries()) {
        parts.push(
          await addPart(
            db,
            props.storyId,
            { title: c.title, source: source(c.href), text: c.text, hints: c.hints, ...book },
            props.position + i,
          ),
        );
      }
    }
    emit('imported', parts);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="epub">
    <label>
      File
      <input type="file" accept=".epub,application/epub+zip" @change="onFileChange" />
    </label>
    <p v-if="loading" class="muted" role="status">Reading…</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <template v-if="book">
      <p class="muted">
        “{{ book.title }}” · {{ book.chapters.length }} sections. Choose what to import:
      </p>
      <ul class="chapters">
        <li v-for="(c, i) in book.chapters" :key="c.href">
          <label class="chapter">
            <input v-model="selected[i]" type="checkbox" />
            <span>
              <strong>{{ c.title }}</strong>
              <span class="muted"> · {{ words(c.text).toLocaleString() }} words</span>
              <span class="preview">{{ c.text.slice(0, 140) }}…</span>
            </span>
          </label>
        </li>
      </ul>
      <label class="combine">
        <input v-model="combine" type="checkbox" />
        Combine the selected sections into one part
      </label>
      <button
        type="button"
        class="primary"
        :disabled="!chosen.length || loading"
        @click="importChapters"
      >
        Import
        {{ combine ? 'as 1 part' : `${chosen.length} ${chosen.length === 1 ? 'part' : 'parts'}` }}
      </button>
    </template>
  </div>
</template>

<style scoped>
.epub {
  display: grid;
  gap: 12px;
}

.chapters {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  gap: 6px;
  max-height: 50vh;
  overflow-y: auto;
}

.chapter,
.combine {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 10px;
  align-items: start;
  color: var(--fg);
}

.chapter input,
.combine input {
  width: 20px;
  height: 20px;
  margin-top: 2px;
}

.preview {
  display: block;
  color: var(--muted);
  font-size: 0.85rem;
  overflow-wrap: anywhere;
}

.error {
  color: var(--danger);
  margin: 0;
}

.primary {
  justify-self: start;
}
</style>
