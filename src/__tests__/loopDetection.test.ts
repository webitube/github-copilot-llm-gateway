import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { LoopDetector } from '../loopDetection';
import { LoopDetectionConfig } from '../types';

const DEFAULT_CONFIG: LoopDetectionConfig = {
  enableLoopDetection: true,
  loopDetectionReasoningBudget: 1000,
  loopDetectionMaxRepeats: 3,
  loopDetectionUniqueRatio: 0.5,
  loopDetectionPhraseLength: 5,
  loopDetectionWindowSize: 2000,
  loopDetectionInterruptionPrompt: 'Stop reasoning and provide a final answer.',
};

describe('LoopDetector', () => {
  test('should never detect a loop when disabled', () => {
    const config: LoopDetectionConfig = { ...DEFAULT_CONFIG, enableLoopDetection: false };
    const detector = new LoopDetector(config);
    const result = detector.processChunk('This is a test. This is a test. This is a test.');
    assert.strictEqual(result.loopDetected, false);
  });

  test('should detect a loop when reasoning budget is exceeded', () => {
    const config: LoopDetectionConfig = { ...DEFAULT_CONFIG, loopDetectionReasoningBudget: 10 };
    const detector = new LoopDetector(config);
    // 44 chars / 4 = ~11 tokens > 10 budget
    const result = detector.processChunk('This is a long enough string to exceed budget.');
    assert.strictEqual(result.loopDetected, true);
    assert.ok(result.reason?.includes('Reasoning budget exceeded'));
  });

  test('should not detect a loop when reasoning budget is not exceeded', () => {
    const config: LoopDetectionConfig = { ...DEFAULT_CONFIG, loopDetectionReasoningBudget: 1000 };
    const detector = new LoopDetector(config);
    const result = detector.processChunk('Short text.');
    assert.strictEqual(result.loopDetected, false);
  });

  test('should detect a loop when stop sequence repeats too many times', () => {
    const config: LoopDetectionConfig = { ...DEFAULT_CONFIG, loopDetectionMaxRepeats: 2 };
    const detector = new LoopDetector(config);
    detector.processChunk('Some reasoning. Final Answer: no.');
    detector.processChunk('More reasoning. Final Answer: still no.');
    const result = detector.processChunk('Even more. Final Answer: yes!');
    assert.strictEqual(result.loopDetected, true);
    assert.ok(result.reason?.includes('Final Answer:'));
  });

  test('should not detect a loop when stop sequence does not repeat too many times', () => {
    const config: LoopDetectionConfig = { ...DEFAULT_CONFIG, loopDetectionMaxRepeats: 3 };
    const detector = new LoopDetector(config);
    detector.processChunk('Final Answer: no.');
    const result = detector.processChunk('Final Answer: yes.');
    assert.strictEqual(result.loopDetected, false);
  });

  test('should detect loops for different stop sequences', () => {
    const config: LoopDetectionConfig = { ...DEFAULT_CONFIG, loopDetectionMaxRepeats: 1 };
    const detector = new LoopDetector(config);
    detector.processChunk('Conclusion: first attempt.');
    const result = detector.processChunk('Conclusion: second attempt.');
    assert.strictEqual(result.loopDetected, true);
    assert.ok(result.reason?.includes('Conclusion:'));
  });

  test('should detect a loop when unique sentence ratio is too low', () => {
    const config: LoopDetectionConfig = {
      ...DEFAULT_CONFIG,
      loopDetectionReasoningBudget: 10000,
      loopDetectionWindowSize: 500,
      loopDetectionUniqueRatio: 0.5,
    };
    const detector = new LoopDetector(config);
    // "This is the same sentence. " = 26 chars × 39 = 1014 > windowSize * 2 = 1000
    const repetitiveText = 'This is the same sentence. '.repeat(39);
    const result = detector.processChunk(repetitiveText);
    assert.strictEqual(result.loopDetected, true);
    assert.ok(result.reason?.includes('Unique sentence ratio too low'));
  });

  test('should not detect a loop when content is diverse', () => {
    const config: LoopDetectionConfig = {
      ...DEFAULT_CONFIG,
      loopDetectionReasoningBudget: 10000,
      loopDetectionWindowSize: 500,
      loopDetectionUniqueRatio: 0.5,
    };
    const detector = new LoopDetector(config);
    const diverseText = [
      'First, we need to understand the problem.',
      'Next, we should consider the available options.',
      'Then, we can evaluate each option carefully.',
      'After that, we should make a decision.',
      'Finally, we can implement the chosen solution.',
      'This approach ensures thorough analysis.',
      'Each step builds on the previous one.',
      'The result should be a robust solution.',
    ].join(' ');
    const result = detector.processChunk(diverseText);
    assert.strictEqual(result.loopDetected, false);
  });

  test('should detect phrase repetition', () => {
    const config: LoopDetectionConfig = {
      ...DEFAULT_CONFIG,
      loopDetectionReasoningBudget: 10000,
      loopDetectionWindowSize: 500,
      loopDetectionMaxRepeats: 2,
      loopDetectionPhraseLength: 3,
      loopDetectionUniqueRatio: 0, // Disable unique ratio check so phrase repetition is tested
    };
    const detector = new LoopDetector(config);
    // Repeating the same phrase many times (36 × 28 chars = 1008 > windowSize * 2 = 1000)
    const repetitiveText = 'let us consider the options. '.repeat(36);
    const result = detector.processChunk(repetitiveText);
    assert.strictEqual(result.loopDetected, true);
    assert.ok(result.reason?.includes('Phrase repetition detected'));
  });

  test('should only analyze when content exceeds window size * 2', () => {
    const config: LoopDetectionConfig = {
      ...DEFAULT_CONFIG,
      loopDetectionReasoningBudget: 10000,
      loopDetectionWindowSize: 1000,
    };
    const detector = new LoopDetector(config);
    // Content is less than windowSize * 2, so structural analysis should not trigger
    const result = detector.processChunk('Short content that should not trigger analysis.');
    assert.strictEqual(result.loopDetected, false);
  });
});
