# LLM eval results

Rows are appended by `npm run eval:llm` (see tests/eval/llm.eval.ts). Target: speaker attribution ≥ 90% on every fixture with Claude Haiku 5.5, no character made for a first-person narrator, and the cost estimate within ±50% of the tokens the API reports.

| Date | Fixture | Model | Effort | Attribution | Speech/narration | Fallback units | Tokens (in/out) | Estimated tokens (in/out) | Cost | Estimate | Time |
| ---- | ------- | ----- | ------ | ----------- | ---------------- | -------------- | --------------- | ------------------------- | ---- | -------- | ---- |
