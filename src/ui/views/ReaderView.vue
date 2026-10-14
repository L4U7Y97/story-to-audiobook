<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { Segment } from '@/format/types';
import { paragraphStarts } from '@/playback/utterances';
import { getAppDb } from '@/storage/db';
import { getAnalysis } from '@/storage/analyses';
import { listParts } from '@/storage/parts';
import { getStory } from '@/storage/stories';
import { useLiveQuery } from '../composables/useLiveQuery';
import { usePlayer } from '../composables/usePlayer';
import { speakerColorIndex } from '../speakerColors';
import PlayerBar from '../components/PlayerBar.vue';

const props = defineProps<{ id: string; partId?: string }>();
const db = getAppDb();
const router = useRouter();
const { player, snapshot } = usePlayer(props.id);

const { data: story } = useLiveQuery(() => getStory(db, props.id), [() => props.id]);
const { data: parts } = useLiveQuery(() => listParts(db, props.id), [() => props.id]);

/** The part shown: the route's, else the one being played, else the saved or first one. */
const partId = computed(
  () =>
    props.partId ??
    snapshot.value.position?.partId ??
    story.value?.position?.partId ??
    story.value?.partIds[0],
);
const part = computed(() => parts.value?.find((p) => p.id === partId.value));
const { data: analysis } = useLiveQuery(
  async () => (partId.value ? getAnalysis(db, partId.value) : undefined),
  [partId],
);
const colors = computed(() => speakerColorIndex(story.value?.cast ?? []));
const names = computed(() => new Map(story.value?.cast.map((c) => [c.id, c.name])));
const narratorId = computed(() => story.value?.narratorId);

interface Paragraph {
  segments: Array<{ index: number; segment: Segment; text: string }>;
}

const paragraphs = computed<Paragraph[]>(() => {
  const p = part.value;
  const a = analysis.value;
  if (!p || !a || a.textHash !== p.textHash) return [];
  const starts = paragraphStarts(p.text, a.segments);
  const out: Paragraph[] = [];
  a.segments.forEach((segment, index) => {
    if (starts[index]) out.push({ segments: [] });
    out.at(-1)!.segments.push({ index, segment, text: p.text.slice(segment.start, segment.end) });
  });
  return out;
});

const currentIndex = computed(() => {
  const position = snapshot.value.position;
  return position && position.partId === partId.value ? position.segmentIndex : -1;
});

// Keep the spoken segment in view.
const textEl = ref<HTMLElement>();
watch(currentIndex, async (index) => {
  if (index < 0) return;
  await nextTick();
  textEl.value
    ?.querySelector(`[data-index="${index}"]`)
    ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
});

// Follow playback into the next part.
watch(
  () => snapshot.value.position?.partId,
  (playingPart) => {
    if (playingPart && props.partId && playingPart !== props.partId) {
      void router.replace({ name: 'reader', params: { id: props.id, partId: playingPart } });
    }
  },
);

function playFrom(index: number) {
  if (!partId.value) return;
  void player.play({ partId: partId.value, segmentIndex: index });
}

function selectPart(event: Event) {
  const id = (event.target as HTMLSelectElement).value;
  void player.jump({ partId: id, segmentIndex: 0 });
  void router.replace({ name: 'reader', params: { id: props.id, partId: id } });
}
</script>

<template>
  <main class="page reader">
    <nav class="top">
      <RouterLink :to="{ name: 'story', params: { id } }"
        >← {{ story?.title ?? 'Story' }}</RouterLink
      >
      <RouterLink :to="{ name: 'cast', params: { id } }">Cast</RouterLink>
    </nav>

    <label v-if="parts?.length" class="part-picker">
      <span class="sr-only">Part</span>
      <select :value="partId" @change="selectPart">
        <option v-for="p in parts" :key="p.id" :value="p.id">{{ p.title }}</option>
      </select>
    </label>

    <p v-if="part && !paragraphs.length" class="muted">
      This part has not been analysed yet. Analyse it from the story page to hear it.
    </p>

    <article ref="textEl" class="text" :lang="story?.lang">
      <p v-for="(paragraph, i) in paragraphs" :key="i">
        <span
          v-for="s in paragraph.segments"
          :key="s.index"
          :data-index="s.index"
          :data-mode="s.segment.mode"
          :class="[
            'segment',
            {
              current: s.index === currentIndex,
              voiced: s.segment.speakerId !== narratorId,
            },
          ]"
          :style="
            colors.has(s.segment.speakerId)
              ? { '--tint': `var(--speaker-${colors.get(s.segment.speakerId)})` }
              : undefined
          "
          :title="names.get(s.segment.speakerId)"
          @click="playFrom(s.index)"
          >{{ s.text }}</span
        >
      </p>
    </article>

    <PlayerBar :player="player" :snapshot="snapshot" />
  </main>
</template>

<style scoped>
.top {
  display: flex;
  justify-content: space-between;
  margin-bottom: 12px;
}

.part-picker {
  margin-bottom: 16px;
}

.text {
  font-size: 1.1rem;
  line-height: 1.7;
}

.text p {
  margin: 0 0 1em;
}

.segment {
  cursor: pointer;
  border-radius: 4px;
  transition: background-color 0.2s;
}

.segment.voiced {
  color: var(--tint, var(--fg));
}

.segment[data-mode='thought'] {
  font-style: italic;
}

.segment.current {
  background: color-mix(in srgb, var(--tint, var(--accent)) 22%, transparent);
  outline: 2px solid color-mix(in srgb, var(--tint, var(--accent)) 40%, transparent);
}

@media (prefers-reduced-motion: reduce) {
  .segment {
    transition: none;
  }
}
</style>
