<script setup lang="ts">
import { computed, onMounted, ref, shallowRef } from 'vue';
import type { AnalysisStatus, Book, Part } from '@/format/types';
import { formatUsd } from '@/analysis/llm/cost';
import { exportFileName, exportStory } from '@/storage/exportImport';
import type { PlayerPosition } from '@/playback/player';
import { saveTextFile } from '../files';
import { getAppDb } from '@/storage/db';
import { getAnalysis } from '@/storage/analyses';
import { getStory } from '@/storage/stories';
import { deletePart, movePart, renamePart } from '@/storage/parts';
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
import { existingPlayer, restorePlace, usePlayer } from '../composables/usePlayer';
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
/**
 * The story's parts, as a key. The parts are read again when it changes, not on every save of the
 * story: its place is saved every few seconds while it plays.
 */
const partIdsKey = computed(() => story.value?.partIds.join('\n'));
const { data: parts } = useLiveQuery(async () => {
  const ids = story.value?.partIds;
  return ids && (await db.parts.bulkGet(ids)).filter((p): p is Part => p !== undefined);
}, [partIdsKey]);
/** Each part's word count, counted again only when the parts change. */
const wordCounts = computed(
  () => new Map((parts.value ?? []).map((part) => [part.id, wordCount(part.text)])),
);
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
  move: (_group, id, toIndex) => moveBook(db, props.id, id, toIndex).then(partsChanged),
});
const partSort = useSortable({
  order: (group) =>
    groups.value.find((item) => partGroup(item.book?.id) === group)?.parts.map((part) => part.id) ??
    [],
  move: (_group, id, toIndex) => movePart(db, props.id, id, toIndex).then(partsChanged),
});
const displayGroups = computed(() =>
  bookSort
    .arrange(BOOKS, groups.value, (group) => group.book?.id ?? 'all')
    .filter((group) => !selectedBookId.value || group.book?.id === selectedBookId.value)
    .map((group) => ({
      ...group,
      parts: partSort.arrange(partGroup(group.book?.id), group.parts, (part) => part.id),
      summary: bookSummary(group.parts),
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

/**
 * This story's player, if it has one. Only a play makes it: making it on sight would stop another
 * story playing.
 */
const live = shallowRef<ReturnType<typeof usePlayer> | undefined>(existingPlayer(props.id));
function playerToListen() {
  live.value = usePlayer(props.id);
  return live.value;
}
const playingNow = computed(() => live.value?.snapshot.value.state === 'playing');
const partById = (partId: string | undefined) => parts.value?.find((part) => part.id === partId);
/** The player's place, while its part is here. */
const livePlace = computed(() => {
  const at = live.value?.snapshot.value.position;
  return partById(at?.partId) ? at : undefined;
});
/** Where listening is: the player's place, else the saved one, while its part is here. */
const place = computed<PlayerPosition | undefined>(() => {
  const saved = story.value?.position;
  return livePlace.value ?? (partById(saved?.partId) ? saved : undefined);
});
/** Whether listening reached the end of the story at the place, as the player recorded it. */
const reachedEnd = computed(() =>
  livePlace.value
    ? live.value?.snapshot.value.ended === true
    : place.value !== undefined && story.value?.ended === true,
);
/**
 * The part after the place's one, where listening goes on from an end reached before it was
 * added. Read from the parts shown, so a part added is named as soon as it counts.
 */
const partAfterPlace = computed(() => {
  const list = parts.value ?? [];
  const index = list.findIndex((part) => part.id === place.value?.partId);
  return index < 0 ? undefined : list[index + 1]?.id;
});
/** All of the story was heard: listening reached its end, and no part was added after it. */
const finished = computed(() => reachedEnd.value && !partAfterPlace.value);
/** The place listening goes on from; none when nothing was heard yet, or all of it was. */
const keptPlace = computed<PlayerPosition | undefined>(() => {
  if (!reachedEnd.value) return place.value;
  return partAfterPlace.value ? { partId: partAfterPlace.value, segmentIndex: 0 } : undefined;
});
/** The part listening goes on in, or starts with. */
const placePart = computed(() => partById(keptPlace.value?.partId ?? story.value?.partIds[0]));
const placePartId = computed(() => keptPlace.value?.partId);
const { data: placeAnalysis } = useLiveQuery(
  async () => (placePartId.value ? getAnalysis(db, placePartId.value) : undefined),
  [placePartId],
);
/** The place's part as the lists show it, "3. The storm", and its book's title. */
const placeName = computed(() => {
  const part = placePart.value;
  const group = part && groups.value.find((g) => g.parts.includes(part));
  if (!part || !group) return undefined;
  return { book: group.book?.title, part: `${group.parts.indexOf(part) + 1}. ${part.title}` };
});
/** How far into its part the kept place is, in percent of the part's text. */
const placePercent = computed(() => {
  const at = keptPlace.value;
  const part = placePart.value;
  const analysis = placeAnalysis.value;
  if (!at || !part?.text.length || analysis?.partId !== at.partId) return undefined;
  if (analysis.textHash !== part.textHash) return undefined;
  const start = analysis.segments[at.segmentIndex]?.start;
  return start === undefined ? undefined : Math.floor((100 * start) / part.text.length);
});
const listenLabel = computed(() => {
  if (playingNow.value) return 'Now playing';
  if (keptPlace.value) return 'Continue';
  return finished.value ? 'Listen again' : 'Start listening';
});

onMounted(() => restorePlace(props.id).catch(() => undefined));

/** Whether a part can be heard: it has an analysis of its text, as the player asks. */
async function canPlay(part: Part): Promise<boolean> {
  if (part.analysisStatus === 'done') return true;
  // Analysed again (running, or failed): the analysis it had still reads its text.
  return (await getAnalysis(db, part.id))?.textHash === part.textHash;
}

/**
 * Listens on from the kept place (resuming a pause), else from the story's start, and opens the
 * reader. A part that cannot be heard yet is only shown: the reader says why.
 */
async function continueListening() {
  const at = keptPlace.value;
  const part = placePart.value;
  if (!part) return;
  // The reader finds the player's place and the saved one by itself; a part started is named.
  const goesOn = at !== undefined && (at === livePlace.value || at === story.value?.position);
  if (await canPlay(part)) {
    const { player, snapshot } = playerToListen();
    const state = snapshot.value.state;
    if (state === 'paused' && at === snapshot.value.position) void player.resume();
    else if (state !== 'playing') void player.play(startAt(at, part));
  }
  void router.push({
    name: 'reader',
    params: { id: props.id, partId: goesOn ? undefined : part.id },
  });
}

/**
 * Where a play starts: the kept place, else the start of `first`, the story's first part. The
 * saved place is left to the player, which first takes up a later place a killed app reached; so
 * is a story with no place saved yet, which may have such a place too.
 */
function startAt(at: PlayerPosition | undefined, first: Part): PlayerPosition | undefined {
  if (at) return at === story.value?.position ? undefined : at;
  return story.value?.position || finished.value
    ? { partId: first.id, segmentIndex: 0 }
    : undefined;
}

/** The book of the kept place (a plain value, so a new line does not redraw the books). */
const placeBookId = computed(() => (keptPlace.value ? placePart.value?.bookId : undefined));

/**
 * A book's play button. With a place kept, only its book has one, to go on there: starting another
 * book would lose the place. With none, each book can be started from its first part.
 */
function bookListen(book: Book): 'Listen' | 'Continue' | 'Playing' | undefined {
  if (placeBookId.value === book.id) return playingNow.value ? 'Playing' : 'Continue';
  return placeBookId.value ? undefined : 'Listen';
}

async function listenToBook(book: Book) {
  if (bookListen(book) !== 'Listen') return continueListening();
  const first = groups.value.find((group) => group.book?.id === book.id)?.parts[0];
  if (!first) return;
  if (await canPlay(first)) {
    void playerToListen().player.play({ partId: first.id, segmentIndex: 0 });
  }
  void router.push({ name: 'reader', params: { id: props.id, partId: first.id } });
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
  partsChanged();
}

async function moveToBook(part: Part, bookId: string) {
  await movePartToBook(db, props.id, part.id, bookId);
  partsChanged();
}

/**
 * After parts changed: the player drops a queue that holds the next part as it was, when another
 * part now comes next or it reads differently (Player.partsChanged).
 */
function partsChanged() {
  void existingPlayer(props.id)?.player.partsChanged();
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
 * Parts queued for analysis here, until their analysis ends: their rows say so and offer no
 * Analyse, so a batch's rows keep their height and no part is queued twice.
 */
const waiting = ref(new Set<string>());

/**
 * Analyses parts in reading order (analyses run one at a time, so later parts reuse earlier
 * characters). With an API key, Claude is used only after the user has seen the cost estimate.
 */
async function analyse(parts: Part[], method?: Method) {
  const queue = () => parts.forEach((part) => waiting.value.add(part.id));
  if (method) queue();
  await loadSettings();
  if (!method && hasKey()) {
    confirming.value = parts;
    return;
  }
  queue();
  confirming.value = [];
  for (const part of parts) {
    try {
      await run(part, method ?? 'heuristic');
    } finally {
      waiting.value.delete(part.id);
      partsChanged();
    }
  }
}

async function onAdded(added: Part[]) {
  const replaced = replacing.value;
  adding.value = null;
  replacing.value = undefined;
  // A part's new text has new lines: the player drops the old ones and waits at its first line.
  const playing = replaced && existingPlayer(props.id);
  if (playing && playing.snapshot.value.position?.partId === replaced.id) {
    await playing.player.jump({ partId: replaced.id, segmentIndex: 0 });
  } else partsChanged();
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
  partsChanged();
}

/** What a part's row says about its analysis: nothing once it is done. */
const STATUS_LABEL: Record<Exclude<AnalysisStatus, 'done'>, string> = {
  pending: 'Not analysed yet',
  running: 'Analysing…',
  failed: 'Analysis failed',
};

function statusLabel(part: Part): string | undefined {
  if (part.analysisStatus === 'done') return undefined;
  const p = progress.value[part.id];
  if (part.analysisStatus === 'running' && p?.total) return `Analysing… ${p.done}/${p.total}`;
  if (part.analysisStatus !== 'running' && waiting.value.has(part.id)) {
    return 'Waiting for analysis';
  }
  return STATUS_LABEL[part.analysisStatus];
}

/** Whether a part's row offers Analyse (or Retry) under its title. */
function canAnalyse(part: Part): boolean {
  if (waiting.value.has(part.id)) return false;
  return (
    (part.analysisStatus === 'pending' && !confirming.value.some((p) => p.id === part.id)) ||
    (part.analysisStatus === 'failed' && !errors.value[part.id])
  );
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** A book's line under its title: "3 parts · 2 not analysed". */
function bookSummary(bookParts: readonly Part[]): { parts: string; notAnalysed?: string } {
  const waiting = bookParts.filter((part) => part.analysisStatus !== 'done').length;
  return {
    parts: !bookParts.length
      ? 'No parts yet'
      : `${bookParts.length} ${bookParts.length === 1 ? 'part' : 'parts'}`,
    notAnalysed: waiting ? `${waiting} not analysed` : undefined,
  };
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
      <!-- The rest waits for the parts: no book says it has none meanwhile, nothing moves down. -->
      <p v-if="!parts" class="muted">Loading…</p>
      <template v-else>
        <div v-if="!selectedBookId && parts?.length" class="story-actions">
          <button class="primary listen" @click="continueListening">
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path
                v-if="playingNow"
                d="M5 9h3v6H5zm5.5-4h3v14h-3zM16 8h3v8h-3z"
                fill="currentColor"
              />
              <path v-else d="M8 5v14l11-7z" fill="currentColor" />
            </svg>
            <span class="listen-text">
              <span class="listen-what">{{ listenLabel }}</span>
              <span v-if="placeName" class="listen-where">
                <template v-if="placeName.book">
                  <span class="listen-book">{{ placeName.book }}</span>
                  <span class="listen-dot"> · </span>
                </template>
                <span class="listen-part">{{ placeName.part }}</span>
                <template v-if="placePercent">
                  <span class="listen-dot"> · </span>
                  <span class="listen-percent">{{ placePercent }}%</span>
                </template>
              </span>
            </span>
          </button>
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
            <header
              v-if="group.book"
              :class="['book-header', { 'on-page': selectedBookId }]"
              data-sortable-handle
            >
              <template v-if="!selectedBookId">
                <h2 :id="`book-${group.book.id}`">
                  <RouterLink
                    class="book-title"
                    draggable="false"
                    :to="{ name: 'book', params: { id: story.id, bookId: group.book.id } }"
                    >{{ group.book.title }}</RouterLink
                  >
                </h2>
                <!-- The ⋮ comes where it is drawn, so focus goes the way the eye does. -->
                <BookActions
                  class="book-menu"
                  :book="group.book"
                  :part-count="group.parts.length"
                  reorderable
                  @rename="renameBook(db, story.id, group.book.id, $event)"
                  @remove="removeBook(group.book)"
                />
              </template>
              <p class="book-summary">
                {{ group.summary.parts
                }}<template v-if="group.summary.notAnalysed">
                  · <span class="not-analysed">{{ group.summary.notAnalysed }}</span>
                </template>
              </p>
              <!-- Held, it lifts the book like the rest of the header. -->
              <button
                v-if="group.parts.length && bookListen(group.book)"
                class="book-listen"
                data-sortable-drag
                :aria-label="
                  bookListen(group.book) === 'Listen'
                    ? `Listen to ${group.book.title} from the start`
                    : `${bookListen(group.book)} ${group.book.title}`
                "
                @click="listenToBook(group.book)"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                  <path
                    v-if="bookListen(group.book) === 'Playing'"
                    d="M5 9h3v6H5zm5.5-4h3v14h-3zM16 8h3v8h-3z"
                    fill="currentColor"
                  />
                  <path v-else d="M8 5v14l11-7z" fill="currentColor" />
                </svg>
                {{ bookListen(group.book) }}
              </button>
              <BookActions
                v-if="selectedBookId"
                class="book-menu"
                :book="group.book"
                :part-count="group.parts.length"
                :reorderable="false"
                @rename="renameBook(db, story.id, group.book.id, $event)"
                @remove="removeBook(group.book)"
              />
            </header>
            <div
              v-if="!group.book || selectedBookId === group.book.id"
              :id="group.book ? `book-content-${group.book.id}` : undefined"
              class="book-content"
            >
              <TransitionGroup
                v-if="group.parts.length"
                tag="ol"
                name="sort"
                class="parts"
                :style="{ '--digits': String(group.parts.length).length }"
              >
                <SortableItem
                  v-for="(part, index) in group.parts"
                  :id="part.id"
                  :key="part.id"
                  tag="li"
                  :sortable="partSort"
                  :group="partGroup(group.book?.id)"
                  class="card part"
                  @open="openPart(part)"
                >
                  <span class="part-number">{{ index + 1 }}.</span>
                  <RouterLink
                    class="part-title"
                    draggable="false"
                    :to="{ name: 'reader', params: { id: story.id, partId: part.id } }"
                    >{{ part.title }}</RouterLink
                  >
                  <span class="part-meta">
                    {{ (wordCounts.get(part.id) ?? 0).toLocaleString() }} words<template
                      v-if="statusLabel(part)"
                    >
                      ·
                      <span class="status" :data-status="part.analysisStatus">{{
                        statusLabel(part)
                      }}</span>
                    </template>
                  </span>
                  <PartActions
                    class="part-menu"
                    :part="part"
                    :books="books.length > 1 ? books : undefined"
                    :has-key="Boolean(settings?.apiKey)"
                    @rename="renamePart(db, part.id, $event)"
                    @move-to-book="moveToBook(part, $event)"
                    @replace="startReplace(part)"
                    @reanalyse="analyse([part], $event)"
                    @remove="remove(part)"
                  />
                  <div v-if="canAnalyse(part)" class="part-do">
                    <button class="analyse" @click="analyse([part])">
                      {{ part.analysisStatus === 'failed' ? 'Retry' : 'Analyse' }}
                    </button>
                  </div>
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
              <p v-else-if="!group.book" class="muted">
                No parts yet. Add the first chapter or a few pages.
              </p>

              <template v-if="group.book">
                <AddPartForm
                  v-if="
                    adding === group.book.id || (replacing && replacing.bookId === group.book.id)
                  "
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
        <p v-else class="muted" role="status">Book not found.</p>

        <section
          v-if="confirming.length && confirmEstimate"
          class="card confirm"
          aria-labelledby="confirm-heading"
        >
          <h2 id="confirm-heading">
            Analyse
            {{
              confirming.length === 1 ? `“${confirming[0]!.title}”` : `${confirming.length} parts`
            }}
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

        <form
          v-if="!selectedBookId && addingBook"
          class="card add-book"
          @submit.prevent="createBook"
        >
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
            <button type="button" @click="((addingBook = false), (newBookTitle = ''))">
              Cancel
            </button>
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
}

/*
 * A part's row: its number, then its title (up to two lines) over its length and, when the part
 * needs something, what; the ⋮ on the right. Analyse or Retry gets a line of its own.
 */
.part {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  column-gap: 8px;
  row-gap: 2px;
  align-items: baseline;
}

/* As wide as the list's longest number, so the titles line up. */
.part-number {
  grid-column: 1;
  grid-row: 1;
  min-width: calc((var(--digits, 1) + 0.5) * 1ch);
  text-align: end;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}

.part-title {
  grid-column: 2;
  grid-row: 1;
  font-weight: 600;
  color: inherit;
  text-decoration: none;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
}

.part-meta {
  grid-column: 2;
  grid-row: 2;
  font-size: 0.85rem;
  color: var(--muted);
}

.part-do {
  grid-column: 2 / -1;
  margin-top: 6px;
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

/*
 * Continue: what it does over where it goes on, "Book 1 · 3. The storm · 42%" (a long title is
 * cut short, the percentage stays).
 */
.listen {
  flex: 1;
  min-width: 0;
  min-height: 56px;
  justify-content: flex-start;
  gap: 10px;
  padding: 6px 14px;
  text-align: start;
}

.listen svg {
  flex: none;
}

.listen-text {
  display: grid;
  min-width: 0;
}

.listen-what {
  font-weight: 600;
}

.listen-where {
  display: flex;
  gap: 0.3em;
  min-width: 0;
  font-size: 0.85rem;
}

.listen-book,
.listen-part {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* A long book title gives way first, so the part shows too. */
.listen-book {
  flex: none;
  max-width: 40%;
}

.listen-dot,
.listen-percent {
  flex: none;
}

.story-actions .button {
  flex: none;
  padding: 0 20px;
}

.part-menu {
  grid-column: 3;
  grid-row: 1 / span 2;
  align-self: center;
}

.status[data-status='failed'] {
  color: var(--danger);
}

.add {
  width: 100%;
}

.error,
.note {
  grid-column: 2 / -1;
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

/*
 * A book on the story page: its title and ⋮, then "3 parts · 2 not analysed" and Listen. On the
 * book's own page, under its title: one line of those, without the rule. Listen and the ⋮ have
 * columns of their own, so a title runs up to the ⋮ whether or not the book has Listen.
 */
.book-header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  column-gap: 8px;
  border-bottom: 1px solid var(--border);
  padding-bottom: 8px;
}

.book-header h2 {
  grid-column: 1 / 3;
  grid-row: 1;
  margin: 0;
  font-size: 1.15rem;
  min-width: 0;
  overflow-wrap: anywhere;
}

.book-menu {
  grid-column: 3;
  grid-row: 1;
  justify-self: end;
}

.book-summary {
  grid-column: 1;
  grid-row: 2;
  margin: 0;
  font-size: 0.9rem;
  color: var(--muted);
}

.not-analysed {
  color: var(--warn);
}

.book-listen {
  grid-column: 2 / 4;
  grid-row: 2;
  justify-self: end;
  gap: 6px;
  padding: 0 14px;
  border-radius: 999px;
  color: var(--accent);
  font-weight: 600;
}

.book-header.on-page {
  border-bottom: none;
  padding-bottom: 0;
}

.book-header.on-page .book-summary {
  grid-row: 1;
}

.book-header.on-page .book-listen {
  grid-column: 2;
  grid-row: 1;
}

.book-title {
  color: inherit;
  text-decoration: none;
}

/* A story without books keeps the list's own margins. */
.book .book-content {
  display: grid;
  gap: 8px;
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

/*
 * Phones: a part row's controls leave its title more room, as on the Cast page. The ⋮ looks the
 * same; its target stays at least 36px wide.
 */
@media (max-width: 480px) {
  .part {
    --gutter: 12px;
    column-gap: 6px;
  }

  .part-menu :deep(summary),
  .book-menu :deep(summary) {
    min-width: 36px;
  }
}
</style>
