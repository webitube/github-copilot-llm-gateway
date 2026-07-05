# Onboarding Guide: Loop Detection System

This guide explains the architecture of the reasoning loop detection system and helps new engineers understand how to add, tune, or debug heuristics.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Data Flow](#data-flow)
- [Core Types](#core-types)
- [The LoopDetector Class](#the-loopdetector-class)
- [Existing Heuristics](#existing-heuristics)
- [Adding a New Heuristic](#adding-a-new-heuristic)
- [Tuning Heuristics](#tuning-heuristics)
- [Debugging Loop Detection](#debugging-loop-detection)
- [Testing](#testing)

---

## Architecture Overview

The loop detection system sits between the inference server's streaming response and the VS Code chat UI. It intercepts reasoning content in real-time and decides whether to continue the stream or terminate it.

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Inference   │────▶│  streamResponse  │────▶│  VS Code Chat   │
│   Server     │     │  (responseStream │     │    Reporter     │
│              │     │    er.ts)        │     └─────────────────┘
└─────────────┘     └────────┬─────────┘
                             │
                     ┌───────▼────────┐
                     │  LoopDetector  │
                     │ (loopDetection │
                     │     .ts)       │
                     └────────────────┘
                             │
                     ┌───────▼────────┐
                     │ handleLoop     │
                     │ Recovery()     │
                     │ (provider.ts)  │
                     └────────────────┘
```

### Key Files

| File | Responsibility |
|------|----------------|
| `src/types.ts` | `LoopDetectionConfig`, `LoopDetectionResult` interfaces |
| `src/loopDetection.ts` | `LoopDetector` class — core detection engine |
| `src/responseStreamer.ts` | Stream processing; integrates detector into chunk loop |
| `src/provider.ts` | Recovery protocol; sends second request when loop is detected |
| `package.json` | VS Code contribution settings for all loop detection config |

---

## Data Flow

1. User sends a chat message → `provider.ts` builds the request
2. Server streams back SSE chunks → `streamResponse()` consumes them
3. For each chunk:
   - If `reasoning_content` is present → fed to `LoopDetector.processChunk()`
   - If content has `<thinking>` tags → ThinkingParser extracts reasoning text → fed to detector
   - Detector returns `{ loopDetected: boolean, reason?: string }`
   - If `loopDetected === true` → stream breaks early, `stats.loopDetected = true`
4. After stream completes:
   - If `stats.loopDetected` → `handleLoopRecovery()` fires a recovery request
   - Recovery request has loop detection **disabled** to avoid infinite recovery loops
5. Recovery response streams to user normally

---

## Core Types

### LoopDetectionConfig

Defined in `src/types.ts`. Controls all heuristic thresholds:

```typescript
interface LoopDetectionConfig {
  enableLoopDetection: boolean;        // Master on/off switch
  loopDetectionReasoningBudget: number; // Max reasoning tokens (~chars/4)
  loopDetectionMaxRepeats: number;      // Stop sequence repeat threshold
  loopDetectionUniqueRatio: number;     // Min unique sentence ratio (0-1)
  loopDetectionPhraseLength: number;    // Min words in a phrase for matching
  loopDetectionWindowSize: number;      // Char window for structural analysis
  loopDetectionInterruptionPrompt: string; // Prompt sent on recovery
}
```

### LoopDetectionResult

Returned by `LoopDetector.processChunk()`:

```typescript
interface LoopDetectionResult {
  loopDetected: boolean;
  reason?: string;  // Human-readable explanation (logged to output channel)
}
```

---

## The LoopDetector Class

Located in `src/loopDetection.ts`.

### Constructor

```typescript
const detector = new LoopDetector(config: LoopDetectionConfig);
```

Takes the config and initializes internal state (reasoning content buffer, stop sequence counters).

### Main Method

```typescript
const result = detector.processChunk(chunk: string): LoopDetectionResult;
```

Called for every new piece of reasoning content. Returns immediately — designed to be fast enough for real-time stream processing.

**Internal flow of `processChunk()`**:

1. Append chunk to `reasoningContent` buffer
2. Check Heuristic 1: Reasoning budget (character count / 4 > budget?)
3. Check Heuristic 2: Stop sequence repetition (does chunk contain "Final Answer:" etc.?)
4. Check Heuristic 3: Structural repetition (only if buffer > windowSize × 2)
   - Slice the last `windowSize` characters
   - Call `analyzeWindow()` which checks unique ratio AND phrase repetition
5. Return `{ loopDetected: false }` if nothing triggered

### Helper Methods

| Method | Purpose |
|--------|---------|
| `splitIntoSentences(text)` | Splits text on `.`, `!`, `?`, `\n` — filters empty results |
| `extractPhrases(text, minLength)` | Sliding window of `minLength` words, lowercased |
| `analyzeWindow(window)` | Checks unique sentence ratio and phrase repetition on a text window |

---

## Existing Heuristics

### 1. Reasoning Budget Heuristic

**What it does**: Counts total reasoning characters and estimates tokens (1 token ≈ 4 chars). If estimated tokens exceed `loopDetectionReasoningBudget`, triggers immediately.

**Why it works**: A model stuck in a loop will eventually burn through its reasoning budget. This is the simplest, most reliable heuristic.

**Tuning**: Increase budget for models that legitimately need long reasoning chains. Decrease for models that tend to loop quickly.

### 2. Stop Sequence Repetition

**What it does**: Monitors for known "exit" phrases: `"Final Answer:"`, `"Conclusion:"`, `"Answer:"`. If the same phrase appears more than `loopDetectionMaxRepeats` times, triggers.

**Why it works**: Models that are about to exit reasoning often signal it. Repeating the signal multiple times means the model is stuck trying to exit but can't.

**Tuning**: Add more stop sequences to the `stopSequences` array in `LoopDetector` if your model uses different exit phrases.

### 3. Unique Sentence Ratio

**What it does**: Splits the analysis window into sentences, lowercases them, and computes `uniqueCount / totalCount`. If the ratio is below `loopDetectionUniqueRatio`, triggers.

**Why it works**: Repetitive reasoning produces a low diversity of sentences. Legitimate reasoning has higher sentence diversity.

**Tuning**: Default `0.3` means 30% unique sentences is the floor. Raise for more tolerance, lower for stricter detection.

### 4. Phrase Repetition

**What it does**: Extracts sliding-window phrases of `loopDetectionPhraseLength` words. If any phrase appears more than `loopDetectionMaxRepeats` times, triggers.

**Why it works**: Even if sentences are structurally different, repeated phrases indicate the model is cycling through the same ideas.

**Tuning**: Shorter phrase lengths catch more patterns but risk false positives. Longer phrases are more specific but might miss variation.

---

## Adding a New Heuristic

### Step 1: Decide where it fits

- **Per-chunk check** (fast, runs every chunk): Add to `processChunk()` before the structural repetition check.
- **Window analysis** (slower, runs periodically): Add to `analyzeWindow()`.
- **New analysis method**: Add a private method and call it from `processChunk()` or `analyzeWindow()`.

### Step 2: Add configuration (if needed)

If your heuristic needs a tunable threshold:

1. Add a property to `LoopDetectionConfig` in `src/types.ts`
2. Add a contribution setting in `package.json` under `contributes.configuration.properties`
3. Wire it into `loadConfig()` in `src/provider.ts` (or wherever config is assembled)

### Step 3: Implement the heuristic

```typescript
// In src/loopDetection.ts

public processChunk(chunk: string): LoopDetectionResult {
  // ... existing checks ...

  // Your new heuristic:
  const myResult = this.checkMyHeuristic(chunk);
  if (myResult.loopDetected) {
    return myResult;
  }

  // ... rest of existing checks ...
}

private checkMyHeuristic(text: string): LoopDetectionResult {
  // Your detection logic here
  if (/* condition */) {
    return {
      loopDetected: true,
      reason: 'My heuristic detected a loop',
    };
  }
  return { loopDetected: false };
}
```

### Step 4: Add tests

1. Add unit tests in `src/__tests__/loopDetection.test.ts`
2. Add integration tests in `src/__tests__/loopDetectionIntegration.test.ts` if the heuristic affects stream behavior

### Step 5: Document

Update this file with your new heuristic in the [Existing Heuristics](#existing-heuristics) section.

---

## Tuning Heuristics

### Common Scenarios

| Problem | Fix |
|---------|-----|
| Legitimate reasoning is interrupted | Increase `loopDetectionReasoningBudget` |
| Loops aren't being caught | Decrease `loopDetectionUniqueRatio` |
| Too many false positives on stop sequences | Increase `loopDetectionMaxRepeats` |
| Recovery request also loops | Check that `enableLoopDetection: false` is set on recovery (it is by default) |

### Per-Model Tuning

Different models have different reasoning styles. Consider these starting points:

| Model Family | Recommended Budget | Recommended Unique Ratio |
|--------------|-------------------|--------------------------|
| DeepSeek-R1 | 2048 | 0.2 |
| QwQ | 1024 | 0.3 |
| Llama (reasoning fine-tunes) | 1024 | 0.4 |

---

## Debugging Loop Detection

### Enable Verbose Logging

Set `"github.copilot.llm-gateway.verboseLogging": true` in settings, then check the **"GitHub Copilot LLM Gateway"** output channel.

### Key Log Lines

| Log Line | Meaning |
|----------|---------|
| `WARNING: Loop detected, initiating recovery protocol.` | Loop was detected; recovery is starting |
| `Initiating loop recovery protocol.` | Recovery request is being built |
| `Sending recovery request to model.` | Recovery request is being sent |
| `Recovery request completed, received X chars` | Recovery succeeded |
| `ERROR: Recovery request failed: ...` | Recovery failed; user sees error message |

### Common Issues

1. **Recovery request also loops**: This shouldn't happen because loop detection is disabled on the recovery request. If it does, check that `handleLoopRecovery` passes `{ ...this.config.loopDetection, enableLoopDetection: false }`.

2. **Stream breaks but `loopDetected` is false**: Check that `stats.loopDetected` is being set in `processStreamChunk` when the detector returns true.

3. **Heuristic never triggers**: Verify the content length exceeds `loopDetectionWindowSize * 2` — structural checks only run when there's enough content.

---

## Testing

```bash
# Full test suite
npm run test

# Only loop detection unit tests
npx tsc -p tsconfig.test.json && node --test "out-test/__tests__/loopDetection.test.js"

# Only integration tests
npx tsc -p tsconfig.test.json && node --test "out-test/__tests__/loopDetectionIntegration.test.js"
```

See [DEVOPS.md](./DEVOPS.md) for manual testing procedures.
