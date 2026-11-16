<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
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
import { existingPlayer } from '../composables/usePlayer';
import { modelLabel, useAnalysis, type Method } from '../composables/useAnalysis';
import AddPartForm from '../components/AddPartForm.vue';
import PartActions from '../components/PartActions.vue';
import BookActions from '../components/BookActions.vue';

const props = defineProps<{ id: string }>();
const db = getAppDb();

const { data: story } = useLiveQuery(() => getStory(db, props.id), [() => props.id]);
const { data: parts } = useLiveQuery(() => listParts(db, props.id), [() => props.id]);
/** Adding a part: to this book id, or '' when the story has no books; null when not adding. */
const adding = ref<string | null>(null);
const replacing = ref<Part | undefined>();
const books = computed(() => story.value?.books ?? []);
/** Parts under their books (one group with book undefined when the story has no books). */
const groups = computed(() => groupParts(books.value, parts.value ?? []));
const previewBookOrder = ref<string[]>();
const previewPartOrder = ref<{ groupId: string; partIds: string[] }>();
const draggedBookId = ref<string>();
const draggedPartId = ref<string>();
const suppressActionClick = ref(false);
type DragSession = {
  kind: 'book' | 'part';
  id: string;
  groupId?: string;
  pointerId: number;
  startX: number;
  startY: number;
  originalOrder: string[];
  dragging: boolean;
  holdTimer: ReturnType<typeof setTimeout>;
};
const activeDrag = ref<DragSession>();
const displayGroups = computed(() => {
  let ordered = groups.value;
  if (previewBookOrder.value) {
    const byBook = new Map(groups.value.map((group) => [group.book?.id, group]));
    ordered = previewBookOrder.value.flatMap((id) => {
      const group = byBook.get(id);
      return group ? [group] : [];
    });
  }
  const preview = previewPartOrder.value;
  if (!preview) return ordered;
  return ordered.map((group) => {
    if ((group.book?.id ?? 'all') !== preview.groupId) return group;
    const byPart = new Map(group.parts.map((part) => [part.id, part]));
    return {
      ...group,
      parts: preview.partIds.flatMap((id) => {
        const part = byPart.get(id);
        return part ? [part] : [];
      }),
    };
  });
});
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
const collapsedBooks = ref(new Set<string>());

async function createBook() {
  const book = await addBook(db, props.id, newBookTitle.value);
  addingBook.value = false;
  newBookTitle.value = '';
  replacing.value = undefined;
  adding.value = book.id;
}

function toggleBook(bookId: string) {
  const collapsed = new Set(collapsedBooks.value);
  if (collapsed.has(bookId)) collapsed.delete(bookId);
  else collapsed.add(bookId);
  collapsedBooks.value = collapsed;
}

function startSortableDrag(
  kind: DragSession['kind'],
  id: string,
  groupId: string | undefined,
  event: PointerEvent,
) {
  if (activeDrag.value) return;
  if (!(event.target instanceof Element) || !event.target.closest('summary')) return;
  if (event.button !== 0) return;
  (event.target.closest('summary') as HTMLElement).setPointerCapture?.(event.pointerId);
  const originalOrder =
    kind === 'book'
      ? books.value.map((book) => book.id)
      : (groups.value
          .find((group) => (group.book?.id ?? 'all') === groupId)
          ?.parts.map((part) => part.id) ?? []);
  if (!originalOrder.includes(id)) return;
  const session: DragSession = {
    kind,
    id,
    ...(groupId ? { groupId } : {}),
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    originalOrder,
    dragging: false,
    holdTimer: setTimeout(() => activateSortableDrag(session), 250),
  };
  activeDrag.value = session;
  window.addEventListener('pointermove', updateBookDrag);
  window.addEventListener('pointerup', finishBookDrag);
  window.addEventListener('pointercancel', cancelBookDrag);
}

function activateSortableDrag(session: DragSession) {
  if (activeDrag.value !== session || session.dragging) return;
  clearTimeout(session.holdTimer);
  session.dragging = true;
  if (session.kind === 'book') {
    draggedBookId.value = session.id;
    previewBookOrder.value = [...session.originalOrder];
  } else {
    draggedPartId.value = session.id;
    previewPartOrder.value = { groupId: session.groupId!, partIds: [...session.originalOrder] };
  }
}

function removeDragListeners() {
  if (activeDrag.value) clearTimeout(activeDrag.value.holdTimer);
  window.removeEventListener('pointermove', updateBookDrag);
  window.removeEventListener('pointerup', finishBookDrag);
  window.removeEventListener('pointercancel', cancelBookDrag);
}

function updateBookDrag(event: PointerEvent) {
  const active = activeDrag.value;
  if (!active || active.pointerId !== event.pointerId) return;

  if (!active.dragging) {
    if (Math.hypot(event.clientX - active.startX, event.clientY - active.startY) < 6) return;
    activateSortableDrag(active);
  }
  event.preventDefault();

  const element = document.elementFromPoint(event.clientX, event.clientY);
  if (active.kind === 'book') {
    const target = element?.closest<HTMLElement>('[data-book-id]');
    const currentOrder = previewBookOrder.value;
    if (!target || !currentOrder) return;
    reorderPreview(
      currentOrder,
      active.id,
      target.dataset.bookId,
      target,
      event.clientY,
      (order) => {
        previewBookOrder.value = order;
      },
    );
    return;
  }

  const target = element?.closest<HTMLElement>('[data-part-id]');
  const targetGroup = target?.closest<HTMLElement>('[data-part-group]');
  const preview = previewPartOrder.value;
  if (!target || targetGroup?.dataset.partGroup !== active.groupId || !preview) return;
  reorderPreview(
    preview.partIds,
    active.id,
    target.dataset.partId,
    target,
    event.clientY,
    (partIds) => {
      previewPartOrder.value = { ...preview, partIds };
    },
  );
}

async function finishBookDrag(event: PointerEvent) {
  const active = activeDrag.value;
  if (!active || active.pointerId !== event.pointerId) return;

  removeDragListeners();
  const order = active.kind === 'book' ? previewBookOrder.value : previewPartOrder.value?.partIds;
  const toIndex = active.dragging ? (order?.indexOf(active.id) ?? -1) : -1;
  if (active.dragging) {
    suppressActionClick.value = true;
    setTimeout(() => (suppressActionClick.value = false), 0);
  }
  try {
    if (toIndex >= 0 && toIndex !== active.originalOrder.indexOf(active.id)) {
      if (active.kind === 'book') await moveBook(db, props.id, active.id, toIndex);
      else await movePart(db, props.id, active.id, toIndex);
    }
  } finally {
    activeDrag.value = undefined;
    previewBookOrder.value = undefined;
    previewPartOrder.value = undefined;
    draggedBookId.value = undefined;
    draggedPartId.value = undefined;
  }
}

function cancelBookDrag(event: PointerEvent) {
  if (activeDrag.value?.pointerId !== event.pointerId) return;
  removeDragListeners();
  activeDrag.value = undefined;
  previewBookOrder.value = undefined;
  previewPartOrder.value = undefined;
  draggedBookId.value = undefined;
  draggedPartId.value = undefined;
}

function reorderPreview(
  order: string[],
  activeId: string,
  targetId: string | undefined,
  target: HTMLElement,
  clientY: number,
  update: (order: string[]) => void,
) {
  if (!targetId || targetId === activeId) return;
  const remaining = order.filter((id) => id !== activeId);
  const targetIndex = remaining.indexOf(targetId);
  if (targetIndex < 0) return;
  const rect = target.getBoundingClientRect();
  const insertAt = targetIndex + (clientY >= rect.top + rect.height / 2 ? 1 : 0);
  remaining.splice(insertAt, 0, activeId);
  if (remaining.some((id, index) => id !== order[index])) update(remaining);
}

function preventActionAfterDrag(event: MouseEvent) {
  if (!suppressActionClick.value) return;
  event.preventDefault();
  event.stopPropagation();
  suppressActionClick.value = false;
}

function moveBookByKeyboard(bookId: string, index: number, event: KeyboardEvent) {
  if (!(event.target instanceof HTMLElement) || event.target.tagName !== 'SUMMARY') return;
  const delta = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
  if (!delta) return;
  event.preventDefault();
  void moveBook(db, props.id, bookId, index + delta);
}

function movePartByKeyboard(part: Part, siblings: Part[], event: KeyboardEvent) {
  if (!(event.target instanceof HTMLElement) || event.target.tagName !== 'SUMMARY') return;
  const delta = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
  if (!delta) return;
  event.preventDefault();
  void move(part, siblings, delta);
}

function cancelActiveDrag() {
  removeDragListeners();
  if (!activeDrag.value) return;
  activeDrag.value = undefined;
  previewBookOrder.value = undefined;
  previewPartOrder.value = undefined;
  draggedBookId.value = undefined;
  draggedPartId.value = undefined;
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
onUnmounted(cancelActiveDrag);

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

function startReplace(part: Part) {
  adding.value = null;
  replacing.value = part;
}

async function move(part: Part, siblings: Part[], delta: number) {
  const index = siblings.findIndex((p) => p.id === part.id);
  if (index >= 0) await movePart(db, props.id, part.id, index + delta);
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
    <RouterLink :to="{ name: 'library' }" class="back">← Library</RouterLink>

    <template v-if="story">
      <h1>{{ story.title }}</h1>
      <p class="muted">
        {{ characterCount }}
        {{ characterCount === 1 ? 'character' : 'characters' }}
      </p>
      <div v-if="parts?.length" class="story-actions">
        <RouterLink class="button primary" :to="{ name: 'reader', params: { id: story.id } }">
          {{ story.position ? 'Continue listening' : 'Read &amp; listen' }}
        </RouterLink>
        <RouterLink class="button" :to="{ name: 'cast', params: { id: story.id } }"
          >Cast</RouterLink
        >
      </div>

      <TransitionGroup tag="div" name="book-sort" class="book-list">
        <component
          :is="group.book ? 'section' : 'div'"
          v-for="(group, g) in displayGroups"
          :key="group.book?.id ?? 'all'"
          :data-book-id="group.book?.id"
          :class="{
            book: group.book,
            'book-dragging': draggedBookId === group.book?.id,
          }"
          :aria-labelledby="group.book ? `book-${group.book.id}` : undefined"
        >
          <header v-if="group.book" class="book-header">
            <h2 :id="`book-${group.book.id}`">{{ group.book.title }}</h2>
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
              @pointerdown.capture="startSortableDrag('book', group.book.id, undefined, $event)"
              @click.capture="preventActionAfterDrag"
              @keydown="moveBookByKeyboard(group.book.id, g, $event)"
              @rename="renameBook(db, story.id, group.book.id, $event)"
              @remove="removeBook(group.book)"
            />
            <button
              type="button"
              class="book-collapse"
              :aria-expanded="!collapsedBooks.has(group.book.id)"
              :aria-label="`${collapsedBooks.has(group.book.id) ? 'Expand' : 'Collapse'} ${group.book.title}`"
              :aria-controls="`book-content-${group.book.id}`"
              @click="toggleBook(group.book.id)"
            >
              <svg
                aria-hidden="true"
                focusable="false"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path :d="collapsedBooks.has(group.book.id) ? 'm6 9 6 6 6-6' : 'm6 15 6-6 6 6'" />
              </svg>
            </button>
          </header>
          <div
            v-show="!group.book || !collapsedBooks.has(group.book.id)"
            :id="group.book ? `book-content-${group.book.id}` : undefined"
            class="book-content"
          >
            <TransitionGroup
              v-if="group.parts.length"
              tag="ol"
              name="part-sort"
              class="parts"
              :data-part-group="group.book?.id ?? 'all'"
            >
              <li
                v-for="part in group.parts"
                :key="part.id"
                :data-part-id="part.id"
                :class="['card', 'part', { 'part-dragging': draggedPartId === part.id }]"
              >
                <RouterLink
                  class="part-title"
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
                  @pointerdown.capture="
                    startSortableDrag('part', part.id, group.book?.id ?? 'all', $event)
                  "
                  @click.capture="preventActionAfterDrag"
                  @keydown="movePartByKeyboard(part, group.parts, $event)"
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
              </li>
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
        </component>
      </TransitionGroup>

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

      <template v-if="!books.length">
        <AddPartForm
          v-if="adding !== null || replacing"
          :key="replacing?.id ?? 'new'"
          :story-id="story.id"
          :parts="formParts"
          :replacing="replacing"
          @added="onAdded"
          @cancel="((adding = null), (replacing = undefined))"
        />
        <button v-else class="primary add" @click="adding = ''">Add a part</button>
      </template>

      <form v-if="addingBook" class="card add-book" @submit.prevent="createBook">
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
        v-else
        :class="['add', 'add-book-button', { primary: books.length > 0 }]"
        @click="addingBook = true"
      >
        Add a book
      </button>

      <section v-if="parts?.length" class="backup" aria-labelledby="backup-heading">
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

.book-dragging {
  opacity: 0.7;
  z-index: 1;
}

.book-sort-move,
.part-sort-move {
  transition:
    transform 180ms ease,
    opacity 180ms ease;
}

.part-dragging {
  opacity: 0.7;
  z-index: 1;
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

.book-collapse {
  min-height: 36px;
  width: 36px;
  padding: 6px;
  flex: 0 0 36px;
}

.book-collapse svg {
  display: block;
  width: 20px;
  height: 20px;
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
  .book-sort-move,
  .part-sort-move,
  .book-dragging {
    transition: none;
  }
}
</style>
