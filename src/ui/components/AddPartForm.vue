<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Part } from '@/format/types';
import { getAppDb } from '@/storage/db';
import { addPart, replacePart } from '@/storage/parts';
import { fromPaste } from '@/ingest/paste';
import { readTxtFile } from '@/ingest/txt';

/** With `replacing`, the form swaps that part's text instead of adding a new part. */
const props = defineProps<{ storyId: string; parts: Part[]; replacing?: Part }>();
const emit = defineEmits<{ added: [part: Part]; cancel: [] }>();

const mode = ref<'paste' | 'file'>('paste');
const title = ref(props.replacing?.title ?? '');
const pasted = ref('');
const file = ref<{ name: string; text: string } | null>(null);
const notice = ref('');
const error = ref('');
/** Index in reading order where the new part goes; parts.length = at the end. */
const position = ref(props.parts.length);
const saving = ref(false);

const text = computed(() => (mode.value === 'paste' ? fromPaste(pasted.value) : file.value?.text));
const canSave = computed(() => !!text.value && /\S/.test(text.value) && !saving.value);
const defaultTitle = computed(() => props.replacing?.title ?? `Part ${props.parts.length + 1}`);

async function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const picked = input.files?.[0];
  error.value = '';
  notice.value = '';
  file.value = null;
  if (!picked) return;
  if (!/\.txt$/i.test(picked.name)) {
    error.value = 'Only .txt files are supported here.';
    return;
  }
  const ingested = await readTxtFile(picked);
  file.value = { name: picked.name, text: ingested.text };
  notice.value = ingested.notice ?? '';
  if (!title.value) title.value = ingested.title;
}

async function save() {
  if (!canSave.value || text.value === undefined) return;
  saving.value = true;
  error.value = '';
  try {
    const input = {
      title: title.value.trim() || defaultTitle.value,
      source:
        mode.value === 'paste'
          ? { kind: 'paste' as const }
          : { kind: 'txt' as const, fileName: file.value?.name },
      text: text.value,
    };
    const db = getAppDb();
    const part = props.replacing
      ? await replacePart(db, props.storyId, props.replacing.id, input)
      : await addPart(db, props.storyId, input, position.value);
    emit('added', part);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <form class="card add-part" @submit.prevent="save">
    <h2>{{ replacing ? `Replace “${replacing.title}”` : 'Add a part' }}</h2>
    <p v-if="replacing" class="muted">
      The new text replaces this part. Voices and characters are kept.
    </p>

    <div class="tabs" role="radiogroup" aria-label="Source">
      <button
        type="button"
        role="radio"
        :aria-checked="mode === 'paste'"
        :class="{ active: mode === 'paste' }"
        @click="mode = 'paste'"
      >
        Paste text
      </button>
      <button
        type="button"
        role="radio"
        :aria-checked="mode === 'file'"
        :class="{ active: mode === 'file' }"
        @click="mode = 'file'"
      >
        .txt file
      </button>
    </div>

    <label v-if="mode === 'paste'">
      Text
      <textarea v-model="pasted" rows="10" placeholder="Paste a chapter or a few pages…" />
    </label>
    <label v-else>
      File
      <input type="file" accept=".txt,text/plain" @change="onFileChange" />
    </label>
    <p v-if="notice" class="notice">{{ notice }}</p>

    <label>
      Title
      <input v-model="title" :placeholder="defaultTitle" autocomplete="off" />
    </label>

    <label v-if="parts.length && !replacing">
      Position
      <select v-model.number="position">
        <option :value="0">At the beginning</option>
        <option v-for="(p, i) in parts" :key="p.id" :value="i + 1">
          {{ i + 1 === parts.length ? 'At the end' : `After “${p.title}”` }}
        </option>
      </select>
    </label>

    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <div class="actions">
      <button type="button" @click="emit('cancel')">Cancel</button>
      <button class="primary" type="submit" :disabled="!canSave">
        {{ replacing ? 'Replace' : 'Add part' }}
      </button>
    </div>
  </form>
</template>

<style scoped>
.add-part {
  display: grid;
  gap: 12px;
}

.tabs {
  display: flex;
  gap: 8px;
}

.tabs button {
  flex: 1;
}

.tabs .active {
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 600;
}

.notice {
  color: var(--warn);
  margin: 0;
}

.error {
  color: var(--danger);
  margin: 0;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
