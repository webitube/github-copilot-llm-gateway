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
   - Loop detected: `[LoopDetector] WARNING: Loop detected (...)`
   - Recovery: `[LoopDetector] Initiating loop recovery protocol.` followed by `[LoopDetector] Sending recovery request to model.`
   - Empty stream (tool failure): `[LoopDetector] WARNING: Empty stream detected (...)` followed by `[LoopDetector] Injecting recovery prompt: "..."`

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
│                       │                                         ││                       ├─ Loop detected → break stream early      │
│                       └─ No loop → normal completion             │
│                                                               │
├─ Loop detected?                                                │
│  ├─ Yes → handleLoopRecovery()                                  │
│  │         ├─ Pick prompt based on loop type                    │
│  │         ├─ (reasoning → loopDetectionInterruptionPrompt)     │
│  │         ├─ (content → loopDetectionContentInterruptionPrompt)│
│  │         ├─ Re-send with loop detection DISABLED              │
│  │         └─ Stream recovery response to user                  │
│  ├─ Empty stream (0/0/0)? → handleEmptyResponse()               │
│  │         ├─ Inject toolFailureRecoveryPrompt                  │
│  │         ├─ Re-send with loop detection DISABLED              │
│  │         └─ Stream recovery response to user                  │
│  └─ No → normal flow                                           │
└──────────────────────────────────────────────────────────────────┘```│                       ├─ Loop detected → break stream early      │
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

## Building and Running a Local Debug Build

A local debug build runs the extension inside VS Code's Extension Host with source maps enabled, allowing breakpoints and live reload via esbuild's watch mode.

### Prerequisites

```bash
npm install
```

### Option 1: Launch from VS Code (Recommended)

The workspace includes a `launch.json` configuration that handles the build and debug cycle automatically.

1. Open the Run & Debug panel (`Ctrl+Shift+D`).
2. Select **"Run Extension"** and press the play button (or `F5`).

This will:
- Start `esbuild-watch` in the background (builds with source maps and auto-rebuilds on file changes).
- Launch a second VS Code window (the "Extension Development Host") with the extension loaded.

The Extension Development Host window is isolated — it does not affect your main VS Code instance or its installed extensions.

### Option 2: Manual Build + Launch

If you prefer to control the build and launch steps separately:

```bash
# Build with source maps (one-time build, no watch)
npm run esbuild

# Launch the extension manually
code --extensionDevelopmentPath=g:\Dev\github-copilot-llm-gateway
```

Or use the **"Run Extension (No Build)"** launch config if you've already built manually.

### Verifying the Debug Build

1. Open the Output panel (`View → Output`) and select **"GitHub Copilot LLM Gateway"** from the dropdown.
2. You should see `[LLM Gateway] Extension activated.` on startup.
3. Set breakpoints in `src/extension.ts` or any other source file — they will be hit in the Extension Development Host.

### Stopping the Watch Build

The `esbuild-watch` task runs in the background. To stop it:
- Press `Ctrl+C` in the terminal panel running the task, or
- Close the Extension Development Host window (the task terminates with the debug session).

## Building and Installing a Standalone VSIX Dev Build

A VSIX build produces a self-contained extension package that can be installed alongside the published extension. This is useful for testing in a separate VS Code profile or on a different machine without affecting the main published build.

### Prerequisites

Ensure `@vscode/vsce` is available (it should be installed as a dev dependency):

```bash
npm install
```

### Build the VSIX

```bash
npm run package
```

This produces a `.vsix` file in the workspace root, e.g., `github-copilot-llm-gateway-1.3.0.vsix`.

### Install the VSIX

**From the command line:**

```powershell
code --install-extension github-copilot-llm-gateway-1.3.0.vsix
```

**Or from the VS Code UI:**

1. Open the Extensions view (`Ctrl+Shift+X`).
2. Click the `...` menu → **"Install from VSIX..."**.
3. Select the `.vsix` file.

### Running Alongside the Published Extension

VS Code allows only one extension per `publisher.name`. To run the dev build alongside the published extension without conflict:

1. **Use a different VS Code profile** (`Ctrl+Shift+P → Profiles: Create Profile`), then install the VSIX only in that profile.
2. **Or uninstall the published extension** temporarily in the target profile, then install the VSIX.

### Bump the Version Before Packaging (Optional)

If you want to distinguish the dev build from the published version, temporarily bump the version in `package.json` before packaging:

```json
"version": "1.3.0-dev.1"
```

This produces a uniquely-named `.vsix` file and makes it easy to identify which build is active.

### Rebuilding After Changes

```bash
# Update source files, then repackage
npm run package

# Reinstall (overwrites previous VSIX install)
code --force --install-extension github-copilot-llm-gateway-1.3.0-dev.1.vsix
```

The `--force` flag ensures the new version overwrites the previously installed VSIX even if the version is the same.

## Configuration Reference

| Setting | Default | Tuning Direction |
|---------|---------|------------------|
| `loopDetectionReasoningBudget` | `1024` | ↑ more headroom, ↓ stricter |
| `loopDetectionMaxRepeats` | `2` | ↑ more tolerance, ↓ stricter |
| `loopDetectionUniqueRatio` | `0.3` | ↑ more tolerance, ↓ stricter |
| `loopDetectionPhraseLength` | `4` | ↑ longer phrases needed, ↓ shorter phrases trigger |
| `loopDetectionWindowSize` | `200` | ↑ larger analysis window, ↓ smaller window |
