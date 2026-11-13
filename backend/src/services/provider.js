// Provider contracts shared by the turn pipeline (documented with JSDoc so the
// fakes used in tests and the real providers stay interchangeable).
//
// STT:  transcribe(ctx, pcm16k, language, extra?) -> {text, language, queuedMs}; ready(ctx)
// LLM:  stream(ctx, request, onDelta) -> answer;  ready(ctx)
//       request = {history, prompt, language, evidence, tools, maxToolCalls, system, maxOutputTokens}
// TTS:  synthesize(ctx, text, language) -> {wav, sampleRate, voice};  ready(ctx)
// Tool: {name, description, parameters (JSON Schema), run(ctx, args) -> result}

// EndTurnError, thrown by Tool.run together with a result (error.result),
// ends generation after the tool call: the server finishes the turn itself
// (for example by asking the user to confirm a proposed change). The model
// cannot continue and therefore cannot claim the change was made.
export class EndTurnError extends Error {
  constructor(result) {
    super('tool ended the turn')
    this.name = 'EndTurnError'
    this.result = result
  }
}

export const isEndTurn = e => e instanceof EndTurnError
