# Feature: Terminate Reasoning Loops / Recover from Bad Tool Calls

## Summary

This branch introduces two top-level resilience features for the GitHub Copilot LLM Gateway extension: **(1) Reasoning Loop Detection & Recovery**, which monitors streamed content for repetitive patterns and automatically interrupts and recovers stuck models, and **(2) Tool Call Failure & Recovery**, which detects empty responses caused by bad tool calls and injects a recovery prompt to give the model another chance. Both features are governed by user-configurable settings, with comprehensive test coverage and documentation.

## Features

### 1. Reasoning Loop Detection & Recovery

Monitors streamed reasoning/thinking content and final token generation for repetitive patterns indicating the model is stuck in a loop. When detected, the stream is interrupted and a recovery prompt forces the model to produce a final response.

- **Loop Detection Engine (loopDetection.ts)** — New `LoopDetector` class that monitors streamed content using three detection strategies:
  - **Stop-sequence counting** — Tracks repeated identical short sequences within a sliding window
  - **Phrase repetition analysis** — Detects when the same n-gram phrases repeat beyond a configurable threshold
  - **Reasoning budget enforcement** — Terminates when reasoning content exceeds a configurable token budget

- **Dual-Phase Detection (responseStreamer.ts)** — Loop detection runs during both:
  - **Reasoning/thinking phase** — Monitors `reasoning_content` chunks
  - **Token generation phase** — Monitors regular text output for loops

- **Loop Recovery Protocol (provider.ts)** — When a loop is detected, the extension:
  - Interrupts the current stream mid-generation
  - Reports a thinking part to the user explaining the recovery
  - Sends a new recovery request with an interruption prompt appended as an assistant message
  - Uses separate prompts for reasoning loops vs. content generation loops
  - Disables loop detection during recovery to avoid recursive triggers

### 2. Tool Call Failure & Recovery

Detects when the model returns an empty response (typically caused by a bad tool call) and automatically attempts recovery instead of surfacing an error to the user.

- **Empty Response Detection** — Improved handling of empty stream results (0 chars, 0 text parts, 0 tool calls)
- **Recovery Prompt Injection** — Injects a configurable tool-failure recovery prompt instead of just logging a warning
- **Automatic Recovery Request** — Sends a new request to give the model another chance to produce valid output

### Supporting Infrastructure

- **Configurable Settings (types.ts)** — New `LoopDetectionConfig` interface with 10 user-configurable options:
  - Enable/disable toggle, window size, max repeats threshold, unique ratio, phrase length, reasoning budget
  - Custom interruption prompts for reasoning loops, content loops, and tool failure recovery

- **Stream Stats Tracking** — Extended `StreamStats` with `loopDetected`, `loopDetectionReason`, and `loopDetectedInReasoning` fields for visibility

- **Comprehensive Testing** — 978 lines of new tests across `loopDetection.test.ts` (unit tests) and `loopDetectionIntegration.test.ts` (integration tests)

- **Documentation** — Added plan, post-mortem, and updated DEVOPS.md, ONBOARDING.md, and README.md