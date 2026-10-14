import { ref } from 'vue';
import type { Part, Story } from '@/format/types';
import { analyzePart } from '@/analysis/analyzer';
import { createAnthropicTransport, MODELS } from '@/analysis/llm/client';
import { costOf, estimateCost, formatUsd, type CostEstimate } from '@/analysis/llm/cost';
import { splitUnits } from '@/analysis/units';
import type { StoryDb } from '@/storage/db';
import { getAllSettings, type Settings } from '@/storage/settings';
import { getEngine } from './usePlayer';

export type Method = 'llm' | 'heuristic';

export function modelLabel(model: string): string {
  return MODELS.find((m) => m.id === model)?.label.replace(/ \(.*\)$/u, '') ?? model;
}

/** Runs analyses for one story view and keeps their progress, errors and outcomes. */
export function useAnalysis(db: StoryDb) {
  const settings = ref<Settings>();
  const progress = ref<Record<string, { done: number; total: number }>>({});
  const errors = ref<Record<string, { message: string; method: Method }>>({});
  const notes = ref<Record<string, string>>({});

  async function loadSettings(): Promise<Settings> {
    settings.value = await getAllSettings();
    return settings.value;
  }

  const hasKey = () => Boolean(settings.value?.apiKey);

  /** Estimated cost of analysing these parts with the current model and cast. */
  function estimate(story: Story, parts: readonly Part[]): CostEstimate {
    const model = settings.value?.model ?? '';
    const total: CostEstimate = { requests: 0, inputTokens: 0, outputTokens: 0, usd: 0 };
    for (const part of parts) {
      const e = estimateCost({
        text: part.text,
        lang: story.lang,
        units: splitUnits(part.text, story.lang, part.hints),
        cast: story.cast,
        model,
      });
      total.requests += e.requests;
      total.inputTokens += e.inputTokens;
      total.outputTokens += e.outputTokens;
      total.usd = e.usd === undefined || total.usd === undefined ? undefined : total.usd + e.usd;
    }
    return total;
  }

  async function run(part: Pick<Part, 'id'>, method: Method): Promise<void> {
    delete errors.value[part.id];
    delete notes.value[part.id];
    const s = await loadSettings();
    const useLlm = method === 'llm' && Boolean(s.apiKey);
    try {
      const report = await analyzePart(db, part.id, {
        voices: await getEngine().listVoices(),
        ...(useLlm
          ? {
              llm: {
                transport: createAnthropicTransport(s.apiKey),
                model: s.model,
                effort: s.effort,
              },
              onProgress: (done: number, total: number) => {
                progress.value[part.id] = { done, total };
              },
            }
          : {}),
      });
      if (report?.usage) {
        const usd = costOf(s.model, report.usage);
        const parts = [`Analysed with ${modelLabel(s.model)}`];
        if (usd !== undefined) parts.push(`cost ${formatUsd(usd)}`);
        if (report.fallbackUnits) {
          parts.push(
            `${report.fallbackUnits} ${report.fallbackUnits === 1 ? 'piece' : 'pieces'} used the free method`,
          );
        }
        notes.value[part.id] = parts.join(' · ');
      }
    } catch (e) {
      errors.value[part.id] = { message: e instanceof Error ? e.message : String(e), method };
    } finally {
      delete progress.value[part.id];
    }
  }

  return { settings, progress, errors, notes, loadSettings, hasKey, estimate, run };
}
