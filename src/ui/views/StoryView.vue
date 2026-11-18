<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { AnalysisStatus, Book, Part } from '@/format/types';
import { formatUsd } from '@/analysis/llm/cost';
import { exportFileName, exportStory } from '@/storage/exportImport';
import { saveTextFile } from '../files';
import { getAppDb } from '@/storage/db';
import { getStory } from '@/storage/stories';
import { deletePart, listParts, movePart, renamePart } from '@/storage/parts';
import {
  addBook,
  deleteBook,
  groupParts,
  moveBook,
  movePartToBook,
  renameBook,
} from '@/storage/books';
import { useLiveQuery } from '../composables/useLiveQuery';
import { useSortable } from '../composables/useSortable';
import { existingPlayer } from '../composables/usePlayer';
import { modelLabel, useAnalysis, type Method } from '../composables/useAnalysis';
import AddPartForm from '../components/AddPartForm.vue';
import PartActions from '../components/PartActions.vue';
import BookActions from '../components/BookActions.vue';
import SortableItem from '../components/SortableItem.vue';
import { useRoute, useRouter } from 'vue-router';

const props = defineProps<{ id: string; bookId?: string }>();
const db = getAppDb();
const router = useRouter();
const route = useRoute();

const { data: story } = useLiveQuery(() => getStory(db, props.id), [() => props.id]);
const { data: parts } = useLiveQuery(() => listParts(db, props.id), [() => props.id]);
/** Adding a part: to this book id, or '' when the story has no books; null when not adding. */
const adding = ref<string | null>(null);
const replacing = ref<Part | undefined>();
const books = computed(() => story.value?.books ?? []);
const selectedBookId = computed(
  () => props.bookId ?? (typeof route.params.bookId === 'string' ? route.params.bookId : undefined),
);
const selectedBook = computed(() => books.value.find((book) => book.id === selectedBookId.value));
/** Parts under their books (one group with book undefined when the story has no books). */
const groups = computed(() => groupParts(books.value, parts.value ?? []));
/** Group of the story's books, and of each book's parts ('all' when the story has no books). */
const BOOKS = 'books';
const partGroup = (bookId: string | undefined) => `parts:${bookId ?? 'all'}`;
const bookSort = useSortable({
  order: () => books.value.map((book) => book.id),
  move: (_group, id, toIndex) => moveBook(db, props.id, id, toIndex),
});
const partSort = useSortable({
  order: (group) =>
    groups.value.find((item) => partGroup(item.book?.id) === group)?.parts.map((part) => part.id) ??
    [],
  move: (_group, id, toIndex) => movePart(db, props.id, id, toIndex),
});
const displayGroups = computed(() =>
  bookSort
    .arrange(BOOKS, groups.value, (group) => group.book?.id ?? 'all')
    .filter((group) => !selectedBookId.value || group.book?.id === selectedBookId.value)
    .map((group) => ({
      ...group,
      parts: partSort.arrange(partGroup(group.book?.id), group.parts, (part) => part.id),
    })),
);
/** The book the add/replace form works on, if any. */
const formBook = computed<Book | undefined>(() => {
  const id = replacing.value?.bookId ?? adding.value;
  return books.value.find((b) => b.id === id);
});
const formParts = computed(() =>
  formBook.value
    ? (parts.value ?? []).filter((p) => p.bookId === formBook.value!.id)
    : (parts.value ?? []),
);
const addingBook = ref(false);
const newBookTitle = ref('');

async function createBook() {
  const book = await addBook(db, props.id, newBookTitle.value);
  addingBook.value = false;
  newBookTitle.value = '';
  replacing.value = undefined;
  adding.value = book.id;
}

function openPart(part: Part) {
  void router.push({ name: 'reader', params: { id: props.id, partId: part.id } });
}

function openBook(book: Book) {
  void router.push({ name: 'book', params: { id: props.id, bookId: book.id } });
}

async function removeBook(book: Book) {
  const playing = existingPlayer(props.id);
  const playingId = playing?.snapshot.value.position?.partId;
  if (playingId && parts.value?.some((p) => p.id === playingId && p.bookId === book.id)) {
    await playing!.player.stop();
  }
  await deleteBook(db, props.id, book.id);
}
const { settings, progress, errors, notes, loadSettings, hasKey, estimate, run } = useAnalysis(db);
/** Parts waiting for the user to accept the cost of analysing them with Claude. */
const confirming = ref<Part[]>([]);
const confirmEstimate = computed(() =>
  story.value && confirming.value.length ? estimate(story.value, confirming.value) : undefined,
);

onMounted(loadSettings);

const exporting = ref(false);
const exportError = ref('');

async function exportFile() {
  if (!story.value) return;
  exporting.value = true;
  exportError.value = '';
  try {
    const data = await exportStory(db, story.value.id);
    await saveTextFile(exportFileName(story.value), JSON.stringify(data));
  } catch (e) {
    exportError.value = `Export failed: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    exporting.value = false;
  }
}
const characterCount = computed(
  () => story.value?.cast.filter((c) => c.role === 'character').length ?? 0,
);

/**
 * Analyses parts in reading order (analyses run one at a time, so later parts reuse earlier
 * characters). With an API key, Claude is used only after the user has seen the cost estimate.
 */
async function analyse(parts: Part[], method?: Method) {
  await loadSettings();
  if (!method && hasKey()) {
    confirming.value = parts;
    return;
  }
  confirming.value = [];
  for (const part of parts) await run(part, method ?? 'heuristic');
}

async function onAdded(added: Part[]) {
  adding.value = null;
  replacing.value = undefined;
  await analyse(added);
}

/** Bumped on every "Replace text…" so an already-open form scrolls back into view. */
const replaceRequest = ref(0);

function startReplace(part: Part) {
  adding.value = null;
  replacing.value = part;
  replaceRequest.value++;
}

async function remove(part: Part) {
  // Stop playback if it is reading the part being deleted.
  const playing = existingPlayer(props.id);
  if (playing?.snapshot.value.position?.partId === part.id) await playing.player.stop();
  await deletePart(db, props.id, part.id);
}

const STATUS_LABEL: Record<AnalysisStatus, string> = {
  pending: 'Waiting for analysis',
  running: 'Analysing…',
  done: 'Ready',
  failed: 'Analysis failed',
};

function statusLabel(part: Part): string {
  const p = progress.value[part.id];
  if (part.analysisStatus === 'running' && p?.total) return `Analysing… ${p.done}/${p.total}`;
  return STATUS_LABEL[part.analysisStatus];
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}
</script>

<template>
  <main class="page">
    <RouterLink
      :to="
        selectedBookId ? { name: 'story', params: { id: story?.id ?? id } } : { name: 'library' }
      "
      class="back"
      >{{ selectedBookId && story ? `← ${story.title}` : '← Library' }}</RouterLink
    >

    <template v-if="story">
      <h1 v-if="selectedBook" :id="`book-${selectedBook.id}`">{{ selectedBook.title }}</h1>
      <h1 v-else-if="!selectedBookId">{{ story.title }}</h1>
      <p v-if="!selectedBookId" class="muted">
        {{ characterCount }}
        {{ characterCount === 1 ? 'character' : 'characters' }}
      </p>
      <div v-if="!selectedBookId && parts?.length" class="story-actions">
        <RouterLink class="button primary" :to="{ name: 'reader', params: { id: story.id } }">
          {{ story.position ? 'Continue listening' : 'Read &amp; listen' }}
        </RouterLink>
        <RouterLink class="button" :to="{ name: 'cast', params: { id: story.id } }"
          >Cast</RouterLink
        >
      </div>

      <TransitionGroup
        v-if="!selectedBookId || selectedBook"
        tag="div"
        name="sort"
        class="book-list"
      >
        <SortableItem
          v-for="group in displayGroups"
          :id="group.book?.id ?? 'all'"
          :key="group.book?.id ?? 'all'"
          :tag="group.book ? 'section' : 'div'"
          :sortable="bookSort"
          :group="BOOKS"
          handle
          :disabled="!group.book || Boolean(selectedBookId)"
          :class="{ book: group.book }"
          :aria-labelledby="group.book ? `book-${group.book.id}` : undefined"
          @open="group.book && openBook(group.book)"
        >
          <header v-if="group.book" class="book-header" data-sortable-handle>
            <h2 v-if="!selectedBookId" :id="`book-${group.book.id}`">
              <RouterLink
                class="book-title"
                draggable="false"
                :to="{ name: 'book', params: { id: story.id, bookId: group.book.id } }"
                >{{ group.book.title }}</RouterLink
              >
            </h2>
            <span class="muted">
              {{ group.parts.length }} {{ group.parts.length === 1 ? 'part' : 'parts' }}
            </span>
            <RouterLink
              v-if="group.parts.length"
              class="book-listen"
              :to="{ name: 'reader', params: { id: story.id, partId: group.parts[0]!.id } }"
            >
              Listen</RouterLink
            >
            <BookActions
              class="book-menu"
              :book="group.book"
              :part-count="group.parts.length"
              :reorderable="!selectedBookId"
              @rename="renameBook(db, story.id, group.book.id, $event)"
              @remove="removeBook(group.book)"
            />
          </header>
          <div
            v-if="!group.book || selectedBookId === group.book.id"
            :id="group.book ? `book-content-${group.book.id}` : undefined"
            class="book-content"
          >
            <TransitionGroup v-if="group.parts.length" tag="ol" name="sort" class="parts">
              <SortableItem
                v-for="part in group.parts"
                :id="part.id"
                :key="part.id"
                tag="li"
                :sortable="partSort"
                :group="partGroup(group.book?.id)"
                class="card part"
                @open="openPart(part)"
              >
                <RouterLink
                  class="part-title"
                  draggable="false"
                  :to="{ name: 'reader', params: { id: story.id, partId: part.id } }"
                  >{{ part.title }}</RouterLink
                >
                <span class="muted">{{ wordCount(part.text).toLocaleString() }} words</span>
                <span class="status" :data-status="part.analysisStatus">
                  {{ statusLabel(part) }}
                  <button
                    v-if="
                      (part.analysisStatus === 'pending' &&
                        !confirming.some((p) => p.id === part.id)) ||
                      (part.analysisStatus === 'failed' && !errors[part.id])
                    "
                    class="analyse"
                    @click="analyse([part])"
                  >
                    {{ part.analysisStatus === 'failed' ? 'Retry' : 'Analyse' }}
                  </button>
                </span>
                <PartActions
                  class="part-menu"
                  :part="part"
                  :books="books.length > 1 ? books : undefined"
                  :has-key="Boolean(settings?.apiKey)"
                  @rename="renamePart(db, part.id, $event)"
                  @move-to-book="movePartToBook(db, story.id, part.id, $event)"
                  @replace="startReplace(part)"
                  @reanalyse="analyse([part], $event)"
                  @remove="remove(part)"
                />
                <div v-if="errors[part.id]" class="error" role="alert">
                  <span>{{ errors[part.id]!.message }}</span>
                  <span class="error-actions">
                    <button class="analyse" @click="analyse([part], errors[part.id]!.method)">
                      Retry
                    </button>
                    <button
                      v-if="errors[part.id]!.method === 'llm'"
                      class="analyse"
                      @click="analyse([part], 'heuristic')"
                    >
                      Analyse without Claude
                    </button>
                    <RouterLink
                      v-if="errors[part.id]!.message === 'API key rejected'"
                      :to="{ name: 'settings' }"
                      >Settings</RouterLink
                    >
                  </span>
                </div>
                <p v-else-if="notes[part.id]" class="note muted">{{ notes[part.id] }}</p>
              </SortableItem>
            </TransitionGroup>
            <p v-else-if="group.book" class="muted">No parts in this book yet.</p>
            <p v-else-if="parts" class="muted">
              No parts yet. Add the first chapter or a few pages.
            </p>

            <template v-if="group.book">
              <AddPartForm
                v-if="adding === group.book.id || (replacing && replacing.bookId === group.book.id)"
                :key="replacing?.id ?? 'new'"
                :story-id="story.id"
                :parts="formParts"
                :replacing="replacing"
                :reveal-token="replaceRequest"
                :book-id="group.book.id"
                :book-title="group.book.title"
                @added="onAdded"
                @cancel="((adding = null), (replacing = undefined))"
              />
              <button
                v-else
                class="add"
                @click="((replacing = undefined), (adding = group.book.id))"
              >
                Add a part to “{{ group.book.title }}”
              </button>
            </template>
          </div>
        </SortableItem>
      </TransitionGroup>
      <p v-else-if="selectedBookId" class="muted" role="status">Book not found.</p>

      <section
        v-if="confirming.length && confirmEstimate"
        class="card confirm"
        aria-labelledby="confirm-heading"
      >
        <h2 id="confirm-heading">
          Analyse
          {{ confirming.length === 1 ? `“${confirming[0]!.title}”` : `${confirming.length} parts` }}
          with Claude?
        </h2>
        <p class="muted">
          {{ modelLabel(settings?.model ?? '') }} · {{ confirmEstimate.requests }}
          {{ confirmEstimate.requests === 1 ? 'request' : 'requests' }} · about
          {{ Math.round((confirmEstimate.inputTokens + confirmEstimate.outputTokens) / 1000) }}k
          tokens
        </p>
        <p>
          Estimated cost:
          <strong>{{
            confirmEstimate.usd === undefined
              ? 'unknown for this model'
              : formatUsd(confirmEstimate.usd)
          }}</strong>
        </p>
        <div class="confirm-actions">
          <button class="primary" @click="analyse(confirming, 'llm')">Analyse with Claude</button>
          <button @click="analyse(confirming, 'heuristic')">Use the free method</button>
          <button class="link" @click="confirming = []">Not now</button>
        </div>
      </section>

      <template v-if="!selectedBookId && !books.length">
        <AddPartForm
          v-if="adding !== null || replacing"
          :key="replacing?.id ?? 'new'"
          :story-id="story.id"
          :parts="formParts"
          :replacing="replacing"
          :reveal-token="replaceRequest"
          @added="onAdded"
          @cancel="((adding = null), (replacing = undefined))"
        />
        <button v-else class="primary add" @click="adding = ''">Add a part</button>
      </template>

      <form v-if="!selectedBookId && addingBook" class="card add-book" @submit.prevent="createBook">
        <h2>Add a book</h2>
        <p class="muted">
          <template v-if="!books.length && parts?.length">
            The parts you have now become “Book 1”.
          </template>
          Every book of this story shares the same characters and voices.
        </p>
        <label>
          Title
          <input
            v-model="newBookTitle"
            :placeholder="`Book ${books.length ? books.length + 1 : parts?.length ? 2 : 1}`"
            autocomplete="off"
          />
        </label>
        <div class="form-actions">
          <button type="button" @click="((addingBook = false), (newBookTitle = ''))">Cancel</button>
          <button class="primary" type="submit">Add book</button>
        </div>
      </form>
      <button
        v-else-if="!selectedBookId"
        :class="['add', 'add-book-button', { primary: books.length > 0 }]"
        @click="addingBook = true"
      >
        Add a book
      </button>

      <section
        v-if="!selectedBookId && parts?.length"
        class="backup"
        aria-labelledby="backup-heading"
      >
        <h2 id="backup-heading">Backup</h2>
        <p class="muted">
          Stories live only on this device. Export one to a file to keep a copy or open it on
          another device (Library → Import a story). The file has the text, analysis and voices,
          never your API key.
        </p>
        <button :disabled="exporting" @click="exportFile">
          {{ exporting ? 'Exporting…' : 'Export story' }}
        </button>
        <p v-if="exportError" class="error" role="alert">{{ exportError }}</p>
      </section>
    </template>

    <p v-else-if="story === undefined" class="muted">Loading…</p>
  </main>
</template>

<style scoped>
.back {
  display: inline-block;
  margin-bottom: 12px;
}

.parts {
  list-style: none;
  padding: 0;
  margin: 16px 0;
  display: grid;
  gap: 8px;
  counter-reset: part;
}

.part {
  display: grid;
  grid-template-columns: 1fr auto auto;
  gap: 2px 12px;
  counter-increment: part;
}

.part-title {
  font-weight: 600;
  color: inherit;
  text-decoration: none;
}

.backup {
  margin-top: 32px;
  display: grid;
  gap: 8px;
  justify-items: start;
}

.backup h2 {
  margin: 0;
  font-size: 1.05rem;
}

.backup p {
  margin: 0;
}

.story-actions {
  display: flex;
  gap: 8px;
  margin: 12px 0;
}

.story-actions .button {
  flex: 1;
}

.part-title::before {
  content: counter(part) '. ';
  color: var(--muted);
}

.part-menu {
  grid-column: 3;
  grid-row: 1 / span 2;
  align-self: center;
}

.status {
  grid-column: 2;
  grid-row: 1 / span 2;
  align-self: center;
  font-size: 0.85rem;
  color: var(--muted);
}

.status[data-status='done'] {
  color: var(--ok);
}

.status[data-status='failed'] {
  color: var(--danger);
}

.add {
  width: 100%;
}

.status {
  display: flex;
  align-items: center;
  gap: 8px;
}

.analyse {
  min-height: 36px;
  padding: 0 12px;
}

.error,
.note {
  grid-column: 1 / -1;
  margin: 4px 0 0;
  font-size: 0.85rem;
}

.error {
  color: var(--danger);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.error-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.confirm {
  display: grid;
  gap: 8px;
  margin-bottom: 16px;
}

.confirm h2 {
  margin: 0;
  font-size: 1.05rem;
}

.confirm p {
  margin: 0;
}

.confirm-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.link {
  border: none;
  background: none;
  color: var(--accent);
}
.book {
  margin: 24px 0;
  display: grid;
  gap: 8px;
}

.sort-move {
  transition:
    transform 180ms ease,
    opacity 180ms ease;
}

/* A lifted book has no card of its own: its background reaches a little past its edges. */
.book-list > .book.dragging {
  box-shadow:
    0 0 0 8px var(--surface),
    0 10px 28px 8px rgb(0 0 0 / 25%);
}

.book-header {
  display: flex;
  align-items: center;
  gap: 12px;
  border-bottom: 1px solid var(--border);
  padding-bottom: 4px;
}

.book-header h2 {
  margin: 0;
  font-size: 1.15rem;
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}

.book-title {
  color: inherit;
  text-decoration: none;
}

.book .parts {
  margin: 0;
}

.add-book-button {
  margin-top: 8px;
}

.add-book {
  display: grid;
  gap: 12px;
  margin-top: 16px;
}

.add-book h2 {
  margin: 0;
  font-size: 1.05rem;
}

.add-book p {
  margin: 0;
}

.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

@media (prefers-reduced-motion: reduce) {
  .sort-move {
    transition: none;
  }
}
</style>
