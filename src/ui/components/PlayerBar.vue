<script setup lang="ts">
import { computed } from 'vue';
import type { Player, PlayerSnapshot } from '@/playback/player';
import { setSetting } from '@/storage/settings';
import { SPEEDS } from '../speeds';

const props = defineProps<{ player: Player; snapshot: PlayerSnapshot }>();

const playing = computed(() => props.snapshot.state === 'playing');

/** The chosen speed also becomes the default for the next session. */
function changeSpeed(speed: number) {
  void props.player.setSpeed(speed);
  void setSetting('speed', speed);
}

function toggle() {
  const p = props.player;
  if (props.snapshot.state === 'playing') void p.pause();
  else if (props.snapshot.state === 'paused') void p.resume();
  else void p.play(props.snapshot.position);
}
</script>

<template>
  <div class="player-bar" role="region" aria-label="Player">
    <p v-if="snapshot.message" class="message" role="status">{{ snapshot.message }}</p>
    <div class="controls">
      <button aria-label="Previous paragraph" @click="player.skipParagraph(-1)">⏮</button>
      <button aria-label="Previous line" @click="player.skipSegment(-1)">◀</button>
      <button class="primary play" :aria-label="playing ? 'Pause' : 'Play'" @click="toggle">
        {{ playing ? '❚❚' : '▶' }}
      </button>
      <button aria-label="Next line" @click="player.skipSegment(1)">▶</button>
      <button aria-label="Next paragraph" @click="player.skipParagraph(1)">⏭</button>
      <label class="speed">
        <span class="sr-only">Speed</span>
        <select
          :value="snapshot.speed"
          @change="changeSpeed(Number(($event.target as HTMLSelectElement).value))"
        >
          <option v-for="s in SPEEDS" :key="s" :value="s">{{ s }}×</option>
        </select>
      </label>
    </div>
  </div>
</template>

<style scoped>
.player-bar {
  position: fixed;
  inset: auto 0 0 0;
  background: var(--surface);
  border-top: 1px solid var(--border);
  padding: 8px var(--gutter) calc(8px + env(safe-area-inset-bottom));
  z-index: 10;
}

.controls {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  max-width: 720px;
  margin: 0 auto;
}

.controls button {
  min-width: 44px;
  padding: 0 10px;
}

.play {
  min-width: 56px;
  font-size: 1.1rem;
}

.speed select {
  width: auto;
  padding: 8px;
}

.message {
  margin: 0 auto 6px;
  max-width: 720px;
  text-align: center;
  font-size: 0.9rem;
  color: var(--muted);
}
</style>
