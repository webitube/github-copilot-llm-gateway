import { LoopDetectionConfig, LoopDetectionResult } from './types';

/**
 * LoopDetector monitors a stream of reasoning content to detect repetitive patterns
 * that indicate the model is stuck in a reasoning loop.
 */
export class LoopDetector {
  private reasoningContent = '';
  private stopSequenceCounts: Map<string, number> = new Map();
  private readonly stopSequences = ['Final Answer:', 'Conclusion:', 'Answer:'];

  constructor(private readonly config: LoopDetectionConfig) {}

  /**
   * Process a new chunk of reasoning content and check for loops.
   * @param chunk The new text chunk from the reasoning stream.
   * @returns A result indicating if a loop was detected and the reason.
   */
  public processChunk(chunk: string): LoopDetectionResult {
    if (!this.config.enableLoopDetection) {
      return { loopDetected: false };
    }

    this.reasoningContent += chunk;

    // 1. Reasoning Budget Heuristic
    // Note: We use character count as a proxy for tokens if exact token count is unavailable.
    // A rough approximation is 1 token ~= 4 characters for English.
    const estimatedTokens = Math.ceil(this.reasoningContent.length / 4);
    if (estimatedTokens > this.config.loopDetectionReasoningBudget) {
      return {
        loopDetected: true,
        reason: `Reasoning budget exceeded: ${estimatedTokens} tokens > ${this.config.loopDetectionReasoningBudget}`,
      };
    }

    // 2. Stop Sequence Repetition
    for (const seq of this.stopSequences) {
      if (chunk.includes(seq)) {
        const count = (this.stopSequenceCounts.get(seq) || 0) + 1;
        this.stopSequenceCounts.set(seq, count);
        if (count > this.config.loopDetectionMaxRepeats) {
          return {
            loopDetected: true,
            reason: `Stop sequence "${seq}" repeated ${count} times`,
          };
        }
      }
    }

    // 3. Structural Repetition & Unique Ratio
    // We only check this periodically or when the content is large enough to avoid overhead.
    if (this.reasoningContent.length > this.config.loopDetectionWindowSize * 2) {
      const window = this.reasoningContent.slice(-this.config.loopDetectionWindowSize);
      const loopResult = this.analyzeWindow(window);
      if (loopResult.loopDetected) {
        return loopResult;
      }
    }

    return { loopDetected: false };
  }

  /**
   * Analyzes a window of text for structural repetitions and unique content ratio.
   */
  private analyzeWindow(window: string): LoopDetectionResult {
    const sentences = this.splitIntoSentences(window);
    if (sentences.length < 3) {
      return { loopDetected: false };
    }

    // Unique Ratio Heuristic
    const uniqueSentences = new Set(sentences.map(s => s.trim().toLowerCase()));
    const uniqueRatio = uniqueSentences.size / sentences.length;
    if (uniqueRatio < this.config.loopDetectionUniqueRatio) {
      return {
        loopDetected: true,
        reason: `Unique sentence ratio too low: ${uniqueRatio.toFixed(2)} < ${this.config.loopDetectionUniqueRatio}`,
      };
    }

    // Phrase Repetition Heuristic
    const phrases = this.extractPhrases(window, this.config.loopDetectionPhraseLength);
    const phraseCounts: Map<string, number> = new Map();
    for (const phrase of phrases) {
      const count = (phraseCounts.get(phrase) || 0) + 1;
      phraseCounts.set(phrase, count);
      if (count > this.config.loopDetectionMaxRepeats) {
        return {
          loopDetected: true,
          reason: `Phrase repetition detected: "${phrase}" repeated ${count} times`,
        };
      }
    }

    return { loopDetected: false };
  }

  private splitIntoSentences(text: string): string[] {
    // Simple sentence splitting on common punctuation
    return text.split(/[.!?\n]+/).filter(s => s.trim().length > 0);
  }

  private extractPhrases(text: string, minLength: number): string[] {
    const words = text.split(/\s+/).filter(w => w.length > 0);
    const phrases: string[] = [];
    for (let i = 0; i <= words.length - minLength; i++) {
      phrases.push(words.slice(i, i + minLength).join(' ').toLowerCase());
    }
    return phrases;
  }
}
