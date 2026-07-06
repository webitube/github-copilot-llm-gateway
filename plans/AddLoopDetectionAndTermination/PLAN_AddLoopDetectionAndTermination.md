# Plan: Reasoning Loop Detection and Termination

## Overview
Implement a system to monitor LLM reasoning streams, detect repetitive "thought loops" using heuristics, terminate the reasoning process when a loop is identified, and automatically request a final result from the model with reasoning disabled.

## Configuration
The following settings will be added to the extension configuration:
- `github.copilot.llm-gateway.enableLoopDetection` (boolean, default: `false`): Master switch to enable/disable the feature.
- `github.copilot.llm-gateway.loopDetectionWindowSize` (number, default: `200`): Window size for tracking repetitions.
- `github.copilot.llm-gateway.loopDetectionMaxRepeats` (number, default: `2`): Maximum allowed repetitions before triggering (e.g., 2 is OK, the 3rd triggers termination).
- `github.copilot.llm-gateway.loopDetectionUniqueRatio` (number, default: `0.3`): Minimum unique sentence ratio (0-1) before triggering.
- `github.copilot.llm-gateway.loopDetectionPhraseLength` (number, default: `4`): Minimum phrase length to consider a match.
- `github.copilot.llm-gateway.loopDetectionReasoningBudget` (number, default: `1024`): Maximum reasoning tokens before forced stop.
- `github.copilot.llm-gateway.loopDetectionInterruptionPrompt` (string, default: `"You were caught in a reasoning loop. Please provide the final result now."`): The prompt sent to the model to force convergence.

---

## Phased Implementation

### Phase 1: Configuration & Infrastructure
**Goal:** Define the settings and types necessary to support loop detection.

- [x] Update `package.json` to include the new configuration settings.
- [x] Update `src/types.ts` to include `LoopDetectionConfig` and `LoopDetectionResult` interfaces.
- [x] Update `src/frameworkConfig.ts` (or wherever `GatewayConfig` is defined) to include the new loop detection settings.

### Phase 2: Porting Loop Detection Logic
**Goal:** Bring the proven heuristics from the `webllama` project into the gateway.

- [x] Create `src/loopDetection.ts`.
- [x] Port the `LoopDetector` class from `webllama/src/ts/detection/LoopDetector.ts`.
- [x] Port the following heuristics from `webllama/src/ts/detection/heuristics/`:
    - [x] `structuralRepetition.ts`
    - [x] `keywordFrequency.ts`
    - [x] `reasoningBudget.ts`
    - [x] `thoughtLoopDetector.ts`
- [x] Implement stop sequence detection: monitor for `["Final Answer:", "Conclusion:", "Answer:"]` and trigger termination after `loopDetectionMaxRepeats` occurrences.
- [x] Ensure all dependencies and types are correctly mapped to the gateway's project structure.

### Phase 3: Stream Interception & Termination
**Goal:** Integrate the detector into the response streaming pipeline to detect loops in real-time.

- [x] Modify `src/responseStreamer.ts`:
    - [x] Instantiate `LoopDetector` within `streamResponse`.
    - [x] Feed `reasoning_content` and `ThinkingParser` output into the detector.
    - [x] If a loop is detected, trigger an early break of the stream.
    - [x] Update `StreamStats` to include a `loopDetected` flag.
- [x] Verify that the stream is terminated cleanly without crashing the reporter.

### Phase 4: Recovery Protocol Implementation
**Goal:** Implement the "Interrupt and Provide Final Response" logic in the provider.

- [x] Modify `src/provider.ts` in `provideLanguageModelChatResponse`:
    - [x] Check `stats.loopDetected` after `streamResponse` completes.
    - [x] If `true`, initiate a recovery request:
        - [x] Construct a new message list including the original history.
        - [x] Append the accumulated reasoning as an `assistant` message.
        - [x] Append the `loopDetectionInterruptionPrompt` (or the `system_prompt_final_instructions` from webllama) as a `user` message.
        - [x] Set `extraOptions` to disable reasoning (e.g., `reasoning_effort: 'off'`, `enable_thinking: false`, `preserve_thinking: false`).
    - [x] Stream the recovery response to the user.

### Phase 5: Testing & Validation
**Goal:** Ensure the detector works correctly and the recovery protocol is seamless.

- [x] Create `src/__tests__/loopDetection.test.ts`:
    - [x] Port and adapt unit tests from `webllama/src/ts/detection/` (e.g., `loopDetector.test.ts`, `loopDetector.uniqueSentences.test.ts`).
    - [x] Test various loop scenarios (structural, keyword, budget).
- [x] Create integration tests for the recovery flow in `src/__tests__/loopDetectionIntegration.test.ts`.
- [x] Perform manual validation with a model known to loop. (see [DEVOPS.md](./DEVOPS.md) for manual validation steps)

### Phase 6: Documentation & Onboarding
**Goal:** Document the feature for users and future maintainers.

- [x] Update `README.md` to describe the Loop Detection feature and its configuration.
- [x] Create `DEVOPS.md`:
    - [x] Document how to test the loop detection logic.
    - [x] Describe the impact on token usage and latency.
- [x] Create `ONBOARDING.md`:
    - [x] Explain the architecture of the loop detection system.
    - [x] Guide new engineers on how to add or tune heuristics.

---

## Risks & Considerations
- **False Positives**: Some models may repeat phrases without being in a "loop". Heuristics need careful tuning.
- **Token Overhead**: The recovery request adds a second round-trip to the LLM.
- **Server Support**: Not all servers support `reasoning_effort: 'off'`. Fallback mechanisms may be needed.
