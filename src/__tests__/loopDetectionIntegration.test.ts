import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  StreamChunk,
  StreamReporter,
  streamResponse,
} from '../responseStreamer';
import { LoopDetectionConfig } from '../types';

// ---------- helpers ----------

interface ReporterEvent {
  kind: 'text' | 'thinking' | 'thinkingDone' | 'toolCall' | 'usage';
  value?: string;
}

function makeReporter(): { reporter: StreamReporter; events: ReporterEvent[] } {
  const events: ReporterEvent[] = [];
  const reporter: StreamReporter = {
    reportText: (text) => events.push({ kind: 'text', value: text }),
    reportThinking: (text) => events.push({ kind: 'thinking', value: text }),
    reportThinkingDone: () => events.push({ kind: 'thinkingDone' }),
    reportToolCall: () => events.push({ kind: 'toolCall' }),
    reportUsage: () => events.push({ kind: 'usage' }),
  };
  return { reporter, events };
}

async function* iter(chunks: StreamChunk[]): AsyncIterable<StreamChunk> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

const identityArgs = (tc: { arguments: string }): Record<string, unknown> => {
  try {
    return JSON.parse(tc.arguments) as Record<string, unknown>;
  } catch {
    return {};
  }
};

// ---------- base configs ----------

/** Config with loop detection enabled and a very small reasoning budget to trigger quickly. */
const LOOP_DETECT_CONFIG: LoopDetectionConfig = {
  enableLoopDetection: true,
  loopDetectionReasoningBudget: 50,
  loopDetectionMaxRepeats: 2,
  loopDetectionUniqueRatio: 0.3,
  loopDetectionPhraseLength: 3,
  loopDetectionWindowSize: 200,
  loopDetectionInterruptionPrompt: 'Stop reasoning and provide a final answer.',
  loopDetectionContentInterruptionPrompt: 'Loop detected. Please finalize your response and move on.',
  toolFailureRecoveryPrompt: 'Please review your work and move on. \n',
  enableToolFailureRecovery: false,
};

/** Config with loop detection disabled — simulates a recovery request. */
const NO_LOOP_DETECT_CONFIG: LoopDetectionConfig = {
  ...LOOP_DETECT_CONFIG,
  enableLoopDetection: false,
};

// ---------- integration tests ----------

describe('Loop Detection Integration', () => {
  describe('streamResponse with loop detection enabled', () => {
    test('detects loop via reasoning budget and breaks stream early', async () => {
      const { reporter, events } = makeReporter();

      // Each chunk has 100 chars of reasoning_content, well over the budget of 50 tokens (~200 chars).
      const chunks: StreamChunk[] = [];
      for (let i = 0; i < 20; i++) {
        chunks.push({ reasoning_content: `Reasoning step ${i}: this is a long reasoning chunk that adds up. ` });
      }

      const stats = await streamResponse({
        chunks: iter(chunks),
        reporter,
        isCancelled: () => false,
        resolveToolCallArgs: identityArgs,
        loopConfig: LOOP_DETECT_CONFIG,
      });

      assert.strictEqual(stats.loopDetected, true);
      // Stream should have broken early, so not all thinking events were reported
      const thinkingEvents = events.filter((e) => e.kind === 'thinking');
      assert.ok(
        thinkingEvents.length < chunks.length,
        `Expected stream to break early, but got ${thinkingEvents.length} thinking events for ${chunks.length} chunks`
      );
    });

    test('detects loop via stop sequence repetition', async () => {
      const { reporter, events } = makeReporter();

      // Three chunks each containing "Final Answer:" — with maxRepeats=2, the 3rd should trigger.
      const chunks: StreamChunk[] = [
        { reasoning_content: 'Let me think about this. Final Answer: the first attempt. ' },
        { reasoning_content: 'Wait, let me reconsider. Final Answer: the second attempt. ' },
        { reasoning_content: 'Hmm, one more time. Final Answer: the third attempt. ' },
        { content: 'This content should not be reached.' },
      ];

      const stats = await streamResponse({
        chunks: iter(chunks),
        reporter,
        isCancelled: () => false,
        resolveToolCallArgs: identityArgs,
        loopConfig: LOOP_DETECT_CONFIG,
      });

      assert.strictEqual(stats.loopDetected, true);
      // No text events because the stream broke during reasoning
      const textEvents = events.filter((e) => e.kind === 'text');
      assert.strictEqual(textEvents.length, 0);
    });

    test('does not detect loop when content is diverse and within budget', async () => {
      const { reporter, events } = makeReporter();

      const diverseChunks: StreamChunk[] = [
        { reasoning_content: 'First, I need to understand the problem statement clearly. ' },
        { reasoning_content: 'Next, I should consider the available options carefully. ' },
        { reasoning_content: 'Then, I can evaluate each option against the constraints. ' },
        { content: 'Here is the final answer based on my analysis.' },
      ];

      const stats = await streamResponse({
        chunks: iter(diverseChunks),
        reporter,
        isCancelled: () => false,
        resolveToolCallArgs: identityArgs,
        loopConfig: {
          ...LOOP_DETECT_CONFIG,
          loopDetectionReasoningBudget: 10000, // Very high budget so it won't trigger
          loopDetectionWindowSize: 10000, // Very large window so structural checks won't trigger
        },
      });

      assert.strictEqual(stats.loopDetected, false);
      const textEvents = events.filter((e) => e.kind === 'text');
      assert.strictEqual(textEvents.length, 1);
    });

    test('reports thinking events before loop detection triggers', async () => {
      const { reporter, events } = makeReporter();

      const chunks: StreamChunk[] = [
        { reasoning_content: 'Step one of reasoning process. ' },
        { reasoning_content: 'Step two of reasoning process. ' },
        { reasoning_content: 'Step three of reasoning process. ' },
        { content: 'Should not reach here.' },
      ];

      await streamResponse({
        chunks: iter(chunks),
        reporter,
        isCancelled: () => false,
        resolveToolCallArgs: identityArgs,
        loopConfig: LOOP_DETECT_CONFIG,
      });

      // Should have reported at least some thinking events before breaking
      const thinkingEvents = events.filter((e) => e.kind === 'thinking');
      assert.ok(thinkingEvents.length > 0, 'Expected some thinking events before loop break');
      // Should have reported thinkingDone when the stream broke
      const thinkingDoneEvents = events.filter((e) => e.kind === 'thinkingDone');
      assert.ok(thinkingDoneEvents.length > 0, 'Expected thinkingDone after stream break');
    });
  });

  describe('recovery-style stream (loop detection disabled)', () => {
    test('completes full stream when loop detection is disabled', async () => {
      const { reporter, events } = makeReporter();

      // Same repetitive content that would trigger a loop, but with detection disabled.
      const chunks: StreamChunk[] = [];
      for (let i = 0; i < 10; i++) {
        chunks.push({ reasoning_content: `Repetitive reasoning step ${i}. ` });
      }
      chunks.push({ content: 'Final answer: the result.' });

      const stats = await streamResponse({
        chunks: iter(chunks),
        reporter,
        isCancelled: () => false,
        resolveToolCallArgs: identityArgs,
        loopConfig: NO_LOOP_DETECT_CONFIG,
      });

      assert.strictEqual(stats.loopDetected, false);
      // All chunks should be processed
      const thinkingEvents = events.filter((e) => e.kind === 'thinking');
      assert.strictEqual(thinkingEvents.length, 10);
      const textEvents = events.filter((e) => e.kind === 'text');
      assert.strictEqual(textEvents.length, 1);
    });

    test('recovery stream with only content (no reasoning) completes normally', async () => {
      const { reporter, events } = makeReporter();

      const chunks: StreamChunk[] = [
        { content: 'Based on my analysis, the answer is 42.' },
        { content: ' This is because the calculation shows that result.' },
      ];

      const stats = await streamResponse({
        chunks: iter(chunks),
        reporter,
        isCancelled: () => false,
        resolveToolCallArgs: identityArgs,
        loopConfig: NO_LOOP_DETECT_CONFIG,
      });

      assert.strictEqual(stats.loopDetected, false);
      assert.strictEqual(stats.hadThinking, false);
      const textEvents = events.filter((e) => e.kind === 'text');
      assert.strictEqual(textEvents.length, 2);
    });
  });

  describe('end-to-end loop detection and recovery simulation', () => {
    test('simulates full loop-detect-then-recover flow', async () => {
      // Phase 1: Initial stream with loop detection enabled — should detect loop
      const { reporter: reporter1 } = makeReporter();

      const loopingChunks: StreamChunk[] = [];
      for (let i = 0; i < 30; i++) {
        loopingChunks.push({
          reasoning_content: `I need to think about this more carefully. Let me reconsider my approach. `,
        });
      }
      loopingChunks.push({ content: 'This should not be reached.' });

      const stats1 = await streamResponse({
        chunks: iter(loopingChunks),
        reporter: reporter1,
        isCancelled: () => false,
        resolveToolCallArgs: identityArgs,
        loopConfig: LOOP_DETECT_CONFIG,
      });

      assert.strictEqual(
        stats1.loopDetected,
        true,
        'Phase 1: Initial stream should detect a loop'
      );

      // Phase 2: Recovery stream with loop detection disabled — should complete
      const { reporter: reporter2, events: events2 } = makeReporter();

      const recoveryChunks: StreamChunk[] = [
        { content: 'I understand. Based on the accumulated reasoning, here is the final answer.' },
        { content: ' The result is 42.' },
      ];

      const stats2 = await streamResponse({
        chunks: iter(recoveryChunks),
        reporter: reporter2,
        isCancelled: () => false,
        resolveToolCallArgs: identityArgs,
        loopConfig: NO_LOOP_DETECT_CONFIG,
      });

      assert.strictEqual(
        stats2.loopDetected,
        false,
        'Phase 2: Recovery stream should NOT detect a loop'
      );
      assert.strictEqual(
        stats2.totalTextParts,
        2,
        'Phase 2: Recovery stream should deliver text parts'
      );

      // Verify the recovery stream delivered actual text content
      const recoveryTextEvents = events2.filter((e) => e.kind === 'text');
      assert.ok(
        recoveryTextEvents.some((e) => e.value?.includes('final answer')),
        'Recovery stream should contain the final answer'
      );
    });

    test('handles cancellation during loop detection', async () => {
      const { reporter } = makeReporter();

      let cancelled = false;
      const chunks: StreamChunk[] = [];
      for (let i = 0; i < 50; i++) {
        chunks.push({
          reasoning_content: `Reasoning step ${i} that is quite long to accumulate tokens. `,
        });
      }

      // Simulate cancellation after a few chunks
      let chunkIndex = 0;
      const stats = await streamResponse({
        chunks: (async function* () {
          for (const chunk of chunks) {
            chunkIndex++;
            if (chunkIndex > 5) {
              cancelled = true;
            }
            yield chunk;
          }
        })(),
        reporter,
        isCancelled: () => cancelled,
        resolveToolCallArgs: identityArgs,
        loopConfig: {
          ...LOOP_DETECT_CONFIG,
          loopDetectionReasoningBudget: 10000, // High budget so loop detection won't trigger
        },
      });

      // Stream should stop because of cancellation (happens before loop detection kicks in)
      assert.strictEqual(stats.loopDetected, false);
    });

    test('loop detection with thinking tags in content field', async () => {
      const { reporter } = makeReporter();

      // Reasoning embedded in <thinking> tags inside content field
      const chunks: StreamChunk[] = [
        { content: '<thinking>I should think about this problem step by step. </thinking>' },
        { content: '<thinking>Let me reconsider the approach and think again. </thinking>' },
        { content: '<thinking>One more time, let me think through this carefully. </thinking>' },
        { content: 'The final answer is 42.' },
      ];

      const stats = await streamResponse({
        chunks: iter(chunks),
        reporter,
        isCancelled: () => false,
        resolveToolCallArgs: identityArgs,
        loopConfig: {
          ...LOOP_DETECT_CONFIG,
          loopDetectionReasoningBudget: 10000, // High budget
          loopDetectionWindowSize: 5000, // Large window
        },
      });

      // Should complete normally because content is diverse enough
      assert.strictEqual(stats.loopDetected, false);
      assert.strictEqual(stats.hadThinking, true);
    });
  });

  describe('StreamStats loopDetected flag behaviour', () => {
    test('loopDetected is false by default when no loop occurs', async () => {
      const { reporter } = makeReporter();

      const stats = await streamResponse({
        chunks: iter([{ content: 'Hello world' }]),
        reporter,
        isCancelled: () => false,
        resolveToolCallArgs: identityArgs,
        loopConfig: LOOP_DETECT_CONFIG,
      });

      assert.strictEqual(stats.loopDetected, false);
    });

    test('loopDetected persists after stream break', async () => {
      const { reporter } = makeReporter();

      const chunks: StreamChunk[] = [];
      for (let i = 0; i < 20; i++) {
        chunks.push({
          reasoning_content: `Repetitive reasoning that will trigger the budget limit quickly. `,
        });
      }

      const stats = await streamResponse({
        chunks: iter(chunks),
        reporter,
        isCancelled: () => false,
        resolveToolCallArgs: identityArgs,
        loopConfig: LOOP_DETECT_CONFIG,
      });

      assert.strictEqual(stats.loopDetected, true);
      // thinkingDone should have been emitted
    });
  });
});
