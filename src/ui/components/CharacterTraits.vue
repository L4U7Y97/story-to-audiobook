<script setup lang="ts">
/** A cast member's traits (gender, age, species, size): what its voice is picked from. */
import { computed } from 'vue';
import { AGE_GROUPS, GENDERS, SIZES, SPECIES } from '@/format/types';
import type { Character, Traits } from '@/format/types';
import { cleanTraits, TRAIT_KEYS } from '@/cast/traits';

type TraitKey = (typeof TRAIT_KEYS)[number];

interface Field {
  key: TraitKey;
  label: string;
  /** What the list shows when the member has no such trait. */
  unset: string;
  options: Array<{ value: string; label: string }>;
}

const props = defineProps<{
  character: Character;
  /** The last change of traits left a voice set by hand as it was. */
  voiceKept?: boolean;
}>();
const emit = defineEmits<{
  /** Traits to set; one given as undefined is cleared. */
  change: [changes: { [K in keyof Traits]?: Traits[K] | undefined }];
  repick: [];
}>();

/** A list of every value the format has for a trait, in the format's order. */
function field<V extends string>(
  key: TraitKey,
  label: string,
  unset: string,
  values: readonly V[],
  labels: Record<V, string>,
): Field {
  return { key, label, unset, options: values.map((value) => ({ value, label: labels[value] })) };
}

const FIELDS = [
  field('gender', 'Gender', 'Not set', GENDERS, { male: 'Male', female: 'Female', other: 'Other' }),
  field('age', 'Age', 'Not set', AGE_GROUPS, {
    child: 'Child',
    teen: 'Teenager',
    adult: 'Adult',
    elder: 'Elderly',
  }),
  field('species', 'Species', 'Not set', SPECIES, {
    human: 'Human',
    animal: 'Animal',
    creature: 'Fantasy',
    machine: 'Machine',
  }),
  field('size', 'Size', 'Average', SIZES, { small: 'Small', large: 'Large' }),
];

/** The lists show the stored traits themselves; a value outside the format counts as not set. */
const traits = computed(() => cleanTraits(props.character));
const summary = computed(() => {
  const chosen = FIELDS.flatMap((f) => {
    const option = f.options.find((o) => o.value === traits.value[f.key]);
    return option ? [option.label.toLowerCase()] : [];
  });
  return chosen.length ? chosen.join(' · ') : 'not set';
});
const hintId = computed(() => `traits-hint-${props.character.id}`);

function pick(key: TraitKey, event: Event) {
  const { value } = event.target as HTMLSelectElement;
  const picked = cleanTraits({ [key]: value });
  // The first option of a list ("Not set", "Average") takes the trait away.
  emit('change', key in picked ? picked : { [key]: undefined });
}
</script>

<template>
  <details class="traits">
    <summary>Traits: {{ summary }}</summary>
    <div class="body">
      <fieldset :aria-describedby="hintId">
        <legend class="sr-only">Traits of {{ character.name }}</legend>
        <div class="fields">
          <label v-for="f in FIELDS" :key="f.key">
            {{ f.label }}
            <select :value="traits[f.key] ?? ''" @change="pick(f.key, $event)">
              <option value="">{{ f.unset }}</option>
              <option v-for="o in f.options" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
          </label>
        </div>
      </fieldset>
      <p :id="hintId" class="hint">
        The voice, its pitch and its speed are picked to suit these. Changing one picks them again,
        unless you set the voice by hand.
      </p>
      <p v-if="voiceKept" class="warning" role="alert">
        Traits changed; the voice you set by hand was kept. Use “Re-pick voice” to choose one that
        matches.
      </p>
      <button type="button" @click="emit('repick')">Re-pick voice</button>
    </div>
  </details>
</template>

<style scoped>
summary {
  cursor: pointer;
  color: var(--accent);
  font-size: 0.9rem;
  min-height: 44px;
  display: flex;
  align-items: center;
}

.body {
  display: grid;
  gap: 8px;
  padding-top: 8px;
}

/* A fieldset is as wide as its content unless told otherwise, which would widen a narrow card. */
fieldset {
  min-width: 0;
  margin: 0;
  padding: 0;
  border: none;
}

.fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 12px;
}

.body button {
  justify-self: start;
}

.hint {
  margin: 0;
  color: var(--muted);
  font-size: 0.85rem;
}

.warning {
  margin: 0;
  color: var(--warn);
  font-size: 0.9rem;
}
</style>
