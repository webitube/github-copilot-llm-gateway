# DevOps Guide: Loop Detection

This document covers operational aspects of the reasoning loop detection feature: testing, performance impact, and tuning.

## Overview

The loop detection system monitors LLM reasoning streams in real-time. When it detects the model is stuck in a repetitive reasoning pattern, it terminates the stream and automatically sends a recovery request to force a final answer.

## Testing the Loop Detection Logic

### Unit Tests

Run the full test suite:

```bash
npm run test
```

Relevant test files:

| File | Coverage |
|------|----------|
| `src/__tests__/loopDetection.test.ts` | LoopDetector class: budget, stop sequences, unique ratio, phrase repetition, window analysis |
| `src/__tests__/loopDetectionIntegration.test.ts` | End-to-end stream integration: early break, recovery flow, cancellation, thinking tags |
| `src/__tests__/responseStreamer.test.ts` | StreamStats `loopDetected` flag, streamResponse with loopConfig |

Run a specific test file:

```bash
npx tsc -p tsconfig.test.json && node --test "out-test/__tests__/loopDetection.test.js"
```

### Manual Validation

To manually validate loop detection with a real model:

1. **Enable loop detection** in settings:
   ```json
   "github.copilot.llm-gateway.enableLoopDetection": true
   ```

2. **Use a model known to loop** — reasoning models (DeepSeek-R1, QwQ, etc.) with short context windows are good candidates.

3. **Send a complex prompt** that might trigger extended reasoning:
   - Multi-step math problems
   - Code generation with constraints
   - "Think step by step" prompts

4. **Watch the output channel** (`View → Output → GitHub Copilot LLM Gateway`):
   - Normal flow: no special log lines
   - Loop detected: `WARNING: Loop detected, initiating recovery protocol.`
   - Recovery: `Initiating loop recovery protocol.` followed by `Sending recovery request to model.`

5. **Verify recovery response** — the chat should show a thinking part indicating recovery, then a normal text response.

### Simulating Loops in Tests

The integration tests simulate loops by sending repetitive reasoning content:

```typescript
// Triggers reasoning budget heuristic
const chunks = Array(30).fill({
  reasoning_content: "I need to think about this more carefully. Let me reconsider my approach. "
});

// Triggers stop sequence heuristic
const chunks = [
  { reasoning_content: "Final Answer: first attempt. " },
  { reasoning_content: "Final Answer: second attempt. " },
  { reasoning_content: "Final Answer: third attempt. " }, // 3rd triggers (maxRepeats=2)
];
```

## Impact on Token Usage and Latency

### Normal Flow (No Loop Detected)

- **Token overhead**: Zero. The loop detector runs client-side on streamed content; no extra tokens are consumed.
- **Latency overhead**: Negligible (~1-2 ms per chunk for string operations on the reasoning window).
- **Network overhead**: None.

### Loop Detected Flow

When a loop is triggered, the extension sends a recovery request:

| Metric | Impact |
|--------|--------|
| **Additional tokens** | Recovery request re-sends the conversation history + interruption prompt. Approximate overhead: `input_tokens + interruption_prompt_length`. |
| **Additional latency** | One extra round-trip to the inference server. Expect ~2x total latency for the request. |
| **Token savings** | By terminating the looping stream early, you save the tokens the model would have burned in the loop. For a model stuck in a 2000-token loop, this is a net saving. |

### Tuning for False Positive Reduction

If loop detection is interrupting legitimate reasoning:

1. **Increase `loopDetectionReasoningBudget`** — default is `1024` tokens (~4096 characters). Models that need more reasoning headroom should get a higher budget.
2. **Increase `loopDetectionUniqueRatio`** — default is `0.3`. Raising to `0.5` means the detector tolerates more repetition before triggering.
3. **Increase `loopDetectionWindowSize`** — default is `200` characters. A larger window means the detector needs to see more content before analyzing for patterns.

### Tuning for False Negative Reduction

If loops are NOT being caught:

1. **Decrease `loopDetectionReasoningBudget`** — lower the token threshold.
2. **Decrease `loopDetectionUniqueRatio`** — lower to `0.2` to trigger on less repetition.
3. **Decrease `loopDetectionMaxRepeats`** — lower to `1` to trigger on the first repeated stop sequence.

## Architecture Summary

```
┌──────────────────────────────────────────────────────────────────┐
│  Chat Request                                                    │
│  ↓                                                               │
│  streamResponse() ────┬───── LoopDetector monitors chunks        │
│                       │                                         │
│                       ├─ Heuristic 1: Reasoning budget exceeded? │
│                       ├─ Heuristic 2: Stop sequence repeated?    │
│                       ├─ Heuristic 3: Unique ratio too low?      │
│                       └─ Heuristic 4: Phrase repetition?         │
│                       │                                         │
│                       ├─ Loop detected → break stream early      │
│                       └─ No loop → normal completion             │
│                                                               │
├─ Loop detected?                                                │
│  ├─ Yes → handleLoopRecovery()                                  │
│  │         ├─ Append interruption prompt                        │
│  │         ├─ Re-send with loop detection DISABLED              │
│  │         └─ Stream recovery response to user                  │
│  └─ No → normal flow                                           │
└──────────────────────────────────────────────────────────────────┘
```

## Configuration Reference

| Setting | Default | Tuning Direction |
|---------|---------|------------------|
| `loopDetectionReasoningBudget` | `1024` | ↑ more headroom, ↓ stricter |
| `loopDetectionMaxRepeats` | `2` | ↑ more tolerance, ↓ stricter |
| `loopDetectionUniqueRatio` | `0.3` | ↑ more tolerance, ↓ stricter |
| `loopDetectionPhraseLength` | `4` | ↑ longer phrases needed, ↓ shorter phrases trigger |
| `loopDetectionWindowSize` | `200` | ↑ larger analysis window, ↓ smaller window |
