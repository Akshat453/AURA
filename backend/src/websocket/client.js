// One conversation session: a browser tab (/ws) or an ESP32 device session.
// It owns the recording, the bounded history, the single active turn and the
// pending confirmations. Devices share this pipeline through a deviceLink;
// only output differs (paced PCM instead of WAV per sentence).
import {Channel} from '../utils/channel.js'
import {Context, isCanceled} from '../utils/context.js'
import * as audio from '../utils/audio.js'
import {fields} from '../utils/gotext.js'
import {hasCode} from '../utils/http.js'
import {Session} from './session.js'
import * as protocol from './protocol.js'
import {Splitter, speakable} from '../services/pipeline.js'
import {citations, evidence, intArg, localReply, ModeAuto, ModeGeneral, normalizeMode, planJSON, route, stripCitations, Turn} from '../services/assist/assist.js'
import {intentToolNames} from '../services/assist/intent.js'
import {ConfirmPromptHindi, isBusy} from '../services/speech/whisper.js'
import {actionJSON, ErrBusy, ErrDecided, ErrExpired, ErrUnknown, isActionError, Status} from '../modules/actions/actions.js'
import {Approve, classify, Reject, Unclear} from '../modules/confirmation/classify.js'
import {ProfessorTurn} from '../modules/professor/tools.js'
import {featureNames} from '../modules/professor/tools.js'

void intArg

// sttLanguage maps the UI selection to a Whisper language. Hinglish is decoded
// as Hindi: "en" rejects Hindi-heavy speech and "auto" is slower without
// being more accurate.
export function sttLanguage(language) {
  if (language === 'en' || language === 'hi') return language
  if (language === 'hinglish') return 'hi'
  return 'auto'
}

// textLanguage detects the language of typed input by script, as Whisper does
// for speech: Devanagari means Hindi, anything else is treated as English.
export const textLanguage = text => (/[ऀ-ॿ]/.test(text) ? 'hi' : 'en')

export function normalizedLanguage(selected, detected) {
  if (selected && selected !== 'auto') return selected
  if (detected === 'hi' || detected === 'en') return detected
  return 'auto'
}

export const pickLang = (lang, en, hi) => (lang === 'hi' || lang === 'hinglish' ? hi : en)

export const optionsOf = (e, defaultMode) => ({
  mode: normalizeMode(e.mode || defaultMode), allowDocs: e.allow_doc_context, allowNotes: e.allow_note_context, docFilter: e.document_id, sttQueueMs: 0,
})

const emptyRecording = () => ({active: false, turn: 0, language: '', sampleRate: 0, nextSeq: 0, chunks: [], bytes: 0, debug: false, sttOnly: false, fixture: '', opts: null})

const round3 = v => Math.round(v * 1000) / 1000

// metricsJSON renders turn metrics with the Go field names (omitempty fields left out when zero).
export function metricsJSON(m) {
  const out = {stt_ms: m.sttMS}
  if (m.sttQueueMS) out.stt_queue_ms = m.sttQueueMS
  Object.assign(out, {llm_first_text_ms: m.llmFirstTextMS, llm_total_ms: m.llmTotalMS, first_tts_ms: m.firstTTSMS, first_audio_delivery_ms: m.firstAudioMS, total_ms: m.totalMS, inference: m.inference})
  if (m.mode) out.mode = m.mode
  if (m.retrievalMS) out.retrieval_ms = round3(m.retrievalMS)
  if (m.retrievalMethod) out.retrieval_method = m.retrievalMethod
  if (m.webSearchMS) out.web_search_ms = round3(m.webSearchMS)
  if (m.toolDecisionMS) out.tool_decision_ms = m.toolDecisionMS
  if (m.searches) out.searches = m.searches
  if (m.sources) out.sources = m.sources
  if (m.cited?.length) out.cited = m.cited
  if (m.invalidCitations?.length) out.invalid_citations = m.invalidCitations
  if (m.toolCalls?.length) out.tool_calls = m.toolCalls
  if (m.toolMS) out.tool_ms = round3(m.toolMS)
  if (m.action) out.action = m.action
  if (m.actionMS) out.action_ms = round3(m.actionMS)
  if (m.toolRoute) out.tool_route = m.toolRoute
  if (m.routeMS) out.route_ms = round3(m.routeMS)
  return out
}

const ms = since => Math.trunc(performance.now() - since)

export class Client {
  // transport: {sendText(ctx, string), sendBinary(ctx, Buffer)} for browsers.
  constructor(server, transport, {connCtx}) {
    this.s = server
    this.transport = transport
    this.connCtx = connCtx
    this.sess = new Session(server.cfg.historyTurns)
    this.rec = emptyRecording()
    this.dropped = 0 // turn whose recording was discarded after an audio error
    this.debug = false
    this.dev = null // deviceLink for ESP32 sessions
    this.acts = server.newActions()
    this.lastIntent = null
  }

  // send writes one event; devices receive the mapped device message.
  async send(ctx, e) {
    if (this.dev) return this.dev.event(ctx, e)
    if (ctx?.err) throw ctx.err // a write for an already-cancelled turn is skipped
    let text
    try {
      text = protocol.encodeEvent(e)
    } catch (err) {
      this.s.log.error({type: e.type, turn_id: e.turn_id, error: err.message}, 'event encoding failed')
      text = protocol.encodeEvent({type: 'error', turn_id: e.turn_id, code: 'internal', message: 'event encoding failed'})
    }
    return this.transport.sendText(text)
  }

  async audio(ctx, header, payload) {
    if (this.dev) return // devices receive paced PCM via speak, never WAV or debug frames
    if (ctx?.err) throw ctx.err
    return this.transport.sendBinary(protocol.encodeAudio(header, payload))
  }

  // trySend ignores delivery errors (Go: `_ = cl.send(...)`).
  trySend(ctx, e) {
    return this.send(ctx, e).catch(() => {})
  }

  async fail(ctx, turn, code, err) {
    if (isCanceled(err)) return
    this.s.log.warn({turn_id: turn, code, error: err?.message ?? String(err)}, 'turn failed')
    const [sendCtx, cancel] = ctx.withoutCancel().withTimeout(2000)
    try {
      await this.send(sendCtx, {type: 'error', turn_id: turn, code, message: err?.message ?? String(err)})
    } catch {
      // the connection is gone
    } finally {
      cancel()
    }
  }

  // control handles one browser control event (decoded JSON). It throws on a
  // request error; the caller reports it as bad_request.
  async control(ctx, data) {
    const e = typeof data === 'object' && !Buffer.isBuffer(data) ? data : protocol.decodeEvent(data)
    const cfg = this.s.cfg
    switch (e.type) {
      case 'listen_start':
        if (e.sample_rate < 8000 || e.sample_rate > 192000) throw new Error('unsupported microphone sample rate')
        if ((e.stt_only || e.fixture !== '') && !cfg.devTools) throw new Error('stt_only and fixture require VOICE_DEV_TOOLS=true')
        this.sess.abort()
        this.rec = {...emptyRecording(), active: true, turn: e.turn_id, language: e.language, sampleRate: e.sample_rate, debug: this.debug && cfg.audioDebugAllowed,
          sttOnly: e.stt_only, fixture: e.fixture, opts: optionsOf(e, cfg.defaultMode)}
        this.dropped = 0
        return this.send(ctx, {type: 'ready', turn_id: e.turn_id})
      case 'listen_stop': {
        const r = this.rec
        this.rec = emptyRecording()
        if (e.turn_id !== 0 && e.turn_id === this.dropped) return
        if (!r.active || r.turn !== e.turn_id) throw new Error('no matching recording')
        const pcm = Buffer.concat(r.chunks, r.bytes)
        try {
          audio.validatePCM16(pcm, r.sampleRate, cfg.maxRecordingSeconds)
        } catch (err) {
          await this.fail(ctx, r.turn, 'bad_request', err)
          return
        }
        this.runTurn(ctx, {...r, pcm}).catch(err => this.s.log.error({error: err.message}, 'turn crashed'))
        return
      }
      case 'abort':
        this.sess.abort()
        return this.send(ctx, {type: 'turn_complete', turn_id: e.turn_id, message: 'aborted'})
      case 'clear':
        this.sess.abort()
        this.sess.clear()
        return this.send(ctx, {type: 'ready', message: 'conversation cleared'})
      case 'text_input':
        if (e.text === '') throw new Error('empty text')
        if ([...e.text].length > 2000) throw new Error('text input is longer than 2000 characters')
        this.runText(ctx, e.turn_id, e.text, e.language, optionsOf(e, cfg.defaultMode)).catch(err => this.s.log.error({error: err.message}, 'turn crashed'))
        return
      case 'playback_started':
        this.s.log.info({turn_id: e.turn_id, client_metrics: e.metrics}, 'client playback started')
        return
      case 'action_confirm':
        if (!this.acts) throw new Error('professor tools are disabled')
        this.confirmAction(ctx, e).catch(err => this.s.log.error({error: err.message}, 'confirmation crashed'))
        return
      case 'debug_enable':
        this.debug = e.debug && cfg.audioDebugAllowed
        return this.send(ctx, {type: 'debug_state', debug: this.debug})
      default:
        throw new Error(`unknown event ${JSON.stringify(e.type)}`)
    }
  }

  // binary appends one PCM frame to the active recording and returns the turn
  // id. The first invalid frame discards the recording and is reported once;
  // later frames of that turn are dropped silently.
  binary(b) {
    const {header: h, payload: p} = protocol.decodeAudio(b) // throws FrameError (turn 0)
    if (h.kind !== protocol.AudioInputPCM) throw Object.assign(new Error('unexpected audio kind'), {turn: h.turnId})
    if (h.turnId !== 0 && h.turnId === this.dropped) return 0
    let err
    if (!this.rec.active || h.turnId !== this.rec.turn || h.sequence !== this.rec.nextSeq) err = new Error('stale or out-of-order audio frame')
    else if (this.rec.bytes + p.length > this.rec.sampleRate * this.s.cfg.maxRecordingSeconds * 2) err = new Error('recording duration exceeded')
    else {
      this.rec.nextSeq++
      this.rec.chunks.push(Buffer.from(p))
      this.rec.bytes += p.length
      return h.turnId
    }
    if (this.rec.active && h.turnId === this.rec.turn) this.rec = emptyRecording()
    this.dropped = h.turnId
    throw Object.assign(err, {turn: h.turnId})
  }

  async runTurn(parent, r) {
    const ctx = this.sess.begin(parent)
    const cfg = this.s.cfg
    const started = performance.now()
    let whisperPCM
    try {
      whisperPCM = audio.prepareWhisper(r.pcm, r.sampleRate, cfg.maxRecordingSeconds)
    } catch (e) {
      await this.fail(ctx, r.turn, 'audio_failed', e)
      return
    }
    if (r.debug) {
      const inputStats = audio.analyzePCM16(r.pcm, r.sampleRate)
      const outputStats = audio.analyzePCM16(whisperPCM, audio.WhisperSampleRate)
      await this.trySend(ctx, {type: 'audio_debug', turn_id: r.turn, language: sttLanguage(r.language), audio: {input: finite(inputStats), whisper: finite(outputStats), model: this.s.modelFor(sttLanguage(r.language))}})
      await this.audio(ctx, {kind: protocol.AudioDebugInputWAV, turnId: r.turn}, audio.wav(r.pcm, r.sampleRate)).catch(() => {})
      await this.audio(ctx, {kind: protocol.AudioDebugWhisperWAV, turnId: r.turn}, audio.wav(whisperPCM, audio.WhisperSampleRate)).catch(() => {})
    }
    let sttLang = sttLanguage(r.language)
    let extra = null
    const pending = this.pendingQuestion()
    if (pending && !r.sttOnly) {
      // The reply is probably a short yes/no in the question's language.
      if (sttLang === 'auto') sttLang = sttLanguage(pending.language)
      if (sttLang === 'hi') { // measured with confirm-bench
        whisperPCM = audio.padSilence(whisperPCM, audio.WhisperSampleRate, 500, 2000)
        extra = {prompt: ConfirmPromptHindi}
      }
    }
    const [sttCtx, cancel] = ctx.withTimeout(cfg.sttTimeout)
    const whisperStart = performance.now()
    let res
    try {
      if (extra && typeof this.s.stt.transcribeWith === 'function') res = await this.s.stt.transcribeWith(sttCtx, whisperPCM, sttLang, extra)
      else res = await this.s.stt.transcribe(sttCtx, whisperPCM, sttLang)
    } catch (e) {
      cancel()
      // A cancelled turn is never reported; a deadline is.
      const err = ctx.err ? ctx.err : e
      await this.fail(ctx, r.turn, isBusy(e) ? 'stt_busy' : 'stt_failed', err) // stt_busy: too many turns queued, retryable
      return
    }
    cancel()
    const sttDone = performance.now()
    if (r.sttOnly) {
      await this.finishSTTOnly(ctx, r, whisperPCM, res, whisperStart - started, sttDone - whisperStart)
      return
    }
    if (r.debug) await this.trySend(ctx, {type: 'audio_debug_transcript', turn_id: r.turn, text: res.text, language: res.language})
    const result = {type: 'stt_result', turn_id: r.turn, text: res.text, language: res.language}
    if (r.fixture) result.eval = this.s.fixtureEval(r, whisperPCM, res.text, Math.trunc(whisperStart - started), Math.trunc(sttDone - whisperStart))
    await this.trySend(ctx, result)
    const opts = {...r.opts, sttQueueMs: res.queuedMs ?? 0}
    await this.generate(ctx, r.turn, res.text, normalizedLanguage(r.language, res.language), opts, started, sttDone)
  }

  // finishSTTOnly ends a development STT-only turn without calling Gemini or Piper.
  async finishSTTOnly(ctx, r, whisperPCM, res, resampleMs, whisperMs) {
    const e = {type: 'stt_result', turn_id: r.turn, text: res.text, language: res.language}
    if (r.fixture) e.eval = this.s.fixtureEval(r, whisperPCM, res.text, Math.trunc(resampleMs), Math.trunc(whisperMs))
    await this.trySend(ctx, e)
    await this.trySend(ctx, {type: 'metrics', turn_id: r.turn, metrics: metricsJSON({sttMS: Math.trunc(resampleMs + whisperMs), inference: 'stt_only', llmFirstTextMS: 0, llmTotalMS: 0, firstTTSMS: 0, firstAudioMS: 0, totalMS: 0})})
    await this.trySend(ctx, {type: 'turn_complete', turn_id: r.turn, message: 'stt_only'})
  }

  async runText(parent, turn, text, lang, opts) {
    const ctx = this.sess.begin(parent)
    const now = performance.now()
    const detected = textLanguage(text)
    await this.trySend(ctx, {type: 'stt_result', turn_id: turn, text, language: detected})
    await this.generate(ctx, turn, text, normalizedLanguage(lang, detected), opts, now, now)
  }

  // speak delivers one synthesized sentence: a WAV frame for the browser,
  // paced 16 kHz PCM for devices.
  async speak(ctx, turn, seq, text, a) {
    if (this.dev) return this.dev.speak(ctx, turn, a)
    await this.trySend(ctx, {type: 'tts_start', turn_id: turn, sequence: seq, text, audio: {format: 'wav', sample_rate: a.sampleRate, voice: a.voice}})
    await this.audio(ctx, {kind: protocol.AudioOutputWAV, turnId: turn, sequence: seq}, a.wav)
    await this.send(ctx, {type: 'tts_end', turn_id: turn, sequence: seq})
  }

  // professorNames lists the professor tools this client may use.
  professorNames(notesToModel) {
    const s = this.s
    if (!s.prof || !this.acts) return {names: [], writes: false}
    let writes = true
    if (this.dev) {
      if (s.cfg.deviceProfessorTools === 'none') return {names: [], writes: false}
      if (s.cfg.deviceProfessorTools === 'read') writes = false
    }
    return {names: featureNames(s.features, writes, notesToModel), writes}
  }

  // userText is everything the user typed or said in this conversation; email
  // addresses in a proposed draft must come from it.
  userText(prompt) {
    let b = ''
    for (const m of this.sess.history()) if (m.role === 'user') b += m.text + '\n'
    return b + prompt
  }

  // notesToModel: note and memo text may reach Gemini only when the server
  // allows it (NOTES_SEND_TO_GEMINI) and the session consented. Only
  // configuration and the client's own consent decide this.
  notesToModel(opts) {
    return this.s.cfg.notesToGemini && !!opts.allowNotes
  }

  pendingQuestion() {
    if (!this.acts) return null
    const {action, ok} = this.acts.pending()
    return ok ? action : null
  }

  recentlyExpired() {
    return this.acts.lastExpired(10 * 60000) !== null
  }

  // sendAction tells the browser about an action (devices ignore these events).
  sendAction(ctx, kind, a) {
    return this.trySend(ctx, {type: kind, action_id: a?.id ?? '', action: actionJSON(a), message: a?.message ?? ''})
  }

  // answerPending handles a reply to a pending confirmation question. Only the
  // user's own words are classified, locally; nothing from the model, a tool
  // or a document can approve an action. Returns [reply, historyText]; the
  // reply is "" when the input is not an answer.
  async answerPending(ctx, prompt, lang, m) {
    if (!this.acts) return ['', '']
    const decision = classify(prompt)
    const {action: pending, ok, expired} = this.acts.pending()
    const expiredReply = pickLang(lang, 'That confirmation request expired, so nothing was changed. Please ask again.', 'वह पुष्टि का अनुरोध समाप्त हो गया, इसलिए कुछ नहीं बदला गया। कृपया दोबारा कहें।')
    if (!ok) {
      if (decision !== Unclear && (expired || this.recentlyExpired())) {
        m.action = 'expired'
        const a = this.acts.lastExpired(10 * 60000)
        if (a) await this.sendAction(ctx, 'action_result', a)
        return [expiredReply, '']
      }
      return ['', '']
    }
    if (decision === Approve || decision === Reject) {
      const start = performance.now()
      let a
      let err = null
      try {
        a = await this.acts.decide(ctx, pending.id, decision === Approve, null)
      } catch (e) {
        err = e
        a = e.action ?? pending
      }
      m.actionMS = performance.now() - start
      await this.sendAction(ctx, 'action_result', a)
      m.action = a.status + ':' + a.kind
      if (err) {
        this.s.log.warn({action_id: a.id, kind: a.kind, error: err.message}, 'action failed')
        if (isActionError(err, ErrExpired)) return [expiredReply, '']
        return [pickLang(lang, 'Sorry, that could not be done: ' + err.message + '. Nothing was changed.', 'माफ़ कीजिए, यह नहीं हो सका, कुछ नहीं बदला गया।'), '(The requested change failed; nothing was changed.)']
      }
      this.s.log.info({action_id: a.id, kind: a.kind, status: a.status, via: 'voice_or_text', ms: m.actionMS}, 'action decided')
      return [a.message, a.history]
    }
    // A very short reply that is neither yes nor no is usually a misheard
    // "haan"/"yes": ask again and keep the question open. Anything longer is
    // a new request and replaces the question.
    if (fields(prompt).length <= 2) {
      m.action = 'reprompt:' + pending.kind
      if (this.dev || lang === 'hi' || lang === 'hinglish') {
        return [pickLang(lang, 'Sorry, I did not catch that. Should I go ahead? Please say yes or no.', 'माफ़ कीजिए, मैं समझ नहीं पाया। क्या मैं आगे बढ़ूँ? कृपया हाँ, ठीक है, या नहीं, रहने दो, कहें।'), '']
      }
      return ['Sorry, I did not catch that. Should I go ahead? Say yes or no, or use the buttons.', '']
    }
    const a = this.acts.supersede()
    if (a) {
      m.action = 'superseded:' + a.kind
      await this.sendAction(ctx, 'action_result', a)
    }
    return ['', '']
  }

  // confirmAction handles the browser's Approve/Reject buttons. The action id
  // must belong to this session's pending question.
  async confirmAction(ctx, e) {
    if (e.decision !== 'approve' && e.decision !== 'reject') {
      await this.trySend(ctx, {type: 'action_result', action_id: e.action_id, code: 'bad_request', message: 'decision must be approve or reject'})
      return
    }
    const start = performance.now()
    let a
    let err = null
    try {
      a = await this.acts.decide(ctx, e.action_id, e.decision === 'approve', e.edits)
    } catch (x) {
      err = x
      a = x.action ?? null
    }
    const msTaken = ms(start)
    const ev = {type: 'action_result', action_id: e.action_id, action: actionJSON(a), message: a?.message ?? '', metrics: {action_ms: msTaken}}
    if (err) {
      if (isActionError(err, ErrUnknown)) Object.assign(ev, {code: 'unknown_action', message: 'This confirmation is not valid for this session. Nothing was changed.'})
      else if (isActionError(err, ErrExpired)) Object.assign(ev, {code: 'expired', message: 'This confirmation expired. Nothing was changed.'})
      else if (isActionError(err, ErrDecided) || isActionError(err, ErrBusy)) Object.assign(ev, {code: 'already_decided', message: 'This action was already decided: ' + (a?.status ?? '') + '.'})
      else if (a?.status === Status.Failed) Object.assign(ev, {code: 'failed', message: 'It could not be done: ' + err.message + '. Nothing was changed.'})
      else Object.assign(ev, {code: 'bad_request', message: err.message})
    }
    await this.trySend(ctx, ev)
    if (!err) {
      this.s.log.info({action_id: a.id, kind: a.kind, status: a.status, via: 'button', ms: msTaken}, 'action decided')
      let summary = a.summary
      let message = a.message
      if (a.history) { // a private note's title must not reach the model
        summary = 'a change to a private note'
        message = a.history
      }
      this.sess.add('user', '(' + e.decision + ' pressed for: ' + summary + ')')
      this.sess.add('assistant', message)
    }
  }

  async generate(ctx, turn, prompt, lang, opts, started, sttDone) {
    const s = this.s
    const cfg = s.cfg
    const [workCtx, workCancel] = ctx.withCancel()
    const [llmCtx, llmCancel] = workCtx.withTimeout(cfg.llmTimeout)
    const m = {sttMS: Math.trunc(sttDone - started), sttQueueMS: Math.trunc(opts.sttQueueMs ?? 0), inference: 'warm', llmFirstTextMS: 0, llmTotalMS: 0, firstTTSMS: 0,
      firstAudioMS: 0, totalMS: 0, toolCalls: [], toolMS: 0}
    try {
      // A reply to a pending confirmation question is handled locally.
      let [actionReply, historyAnswer] = await this.answerPending(ctx, prompt, lang, m)
      const notesOK = this.notesToModel(opts)
      const caps = s.capabilities(opts)
      let prof = null
      let {names: profNames, writes: profWrites} = this.professorNames(notesOK)
      const calendar = s.calendarTool()
      let hasCalendar = calendar !== null
      if (hasCalendar && profNames.length > 0) profNames = [...profNames, calendar.name]
      // Offer only the tool groups this request needs (General and Auto modes).
      // Routing can only remove permitted tools, never add one.
      if (s.router && actionReply === '' && profNames.length > 0) {
        const mode = normalizeMode(opts.mode)
        if (mode === ModeAuto || mode === ModeGeneral) {
          const intent = await s.router.route(ctx, prompt, this.lastIntent)
          this.lastIntent = intent
          profNames = intentToolNames(intent, profNames)
          m.routeMS = intent.ms
          m.toolRoute = intent.all ? 'all' : intent.groups?.length ? intent.groups.join('+') : 'general'
          hasCalendar = hasCalendar && profNames.includes(calendar.name)
        }
      }
      if (actionReply === '' && s.prof && this.acts) {
        // The date, time and tool rules are sent even when routing offers no
        // professor tool (plain conversation can still ask "what is the date?").
        caps.professorTools = profNames
        prof = new ProfessorTurn({svc: s.prof, actions: this.acts, turnId: turn, language: lang, device: this.dev !== null,
          userText: this.userText(prompt), prompt, notesToModel: notesOK,
          onLocalNotes: hits => this.trySend(ctx, {type: 'notes_found', turn_id: turn, notes: hits}),
          onCall: (name, d) => {
            m.toolCalls.push(name)
            m.toolMS += d
          }})
      }
      let plan = route(opts.mode, caps)
      if (actionReply !== '') plan = {mode: plan.mode, preSearchDocs: false, preSearchWeb: false, tools: [], skipGemini: true, localReply: 'action', note: ''}
      m.mode = plan.mode
      await this.trySend(ctx, {type: 'route', turn_id: turn, mode: plan.mode, plan: planJSON(plan)})
      const tools = new Turn({web: s.web, docsTopK: cfg.ragTopK, webResults: cfg.webSearchMaxResults, docFilter: opts.docFilter ?? '',
        onSources: sources => this.trySend(workCtx, {type: 'sources', turn_id: turn, sources}),
        onFailure: (tool, message) => this.trySend(workCtx, {type: 'tool_error', turn_id: turn, code: tool, message})})
      if (s.docs) tools.docs = s.docs
      // Notes and memos are in the document index; their text may reach Gemini
      // through document search only with note consent. Passages shown locally
      // (Documents mode without document consent) may still include them.
      tools.excludeNotes = !notesOK && !plan.skipGemini
      if (prof) {
        tools.extra = prof.tools(profNames)
        if (hasCalendar) tools.extra.push(calendar)
      }

      // Sentence-level synthesis while the model is still streaming.
      const sentences = new Channel(4)
      let seq = 0
      const ttsDone = (async () => {
        for (;;) {
          const {value: sentence, ok} = await sentences.recv()
          if (!ok) return null
          const spoken = speakable(sentence) // citations and URLs are shown, not read aloud
          if (spoken === '') continue
          const t0 = performance.now()
          const [tctx, tcancel] = workCtx.withTimeout(cfg.ttsTimeout)
          let a
          try {
            a = await s.tts.synthesize(tctx, spoken, lang)
          } catch (e) {
            tcancel()
            workCancel()
            return tctx.err && !workCtx.err ? tctx.err : e
          }
          tcancel()
          if (seq === 0) m.firstTTSMS = ms(t0)
          try {
            await this.speak(workCtx, turn, seq, spoken, a)
          } catch (e) {
            workCancel()
            return e
          }
          if (seq === 0) m.firstAudioMS = ms(started)
          seq++
        }
      })()
      const split = new Splitter()
      let firstText = 0
      let llmStart = performance.now()
      const onDelta = async delta => {
        if (firstText === 0) {
          firstText = Math.max(performance.now() - llmStart, 1e-6)
          m.llmFirstTextMS = Math.trunc(firstText)
        }
        await this.send(workCtx, {type: 'llm_delta', turn_id: turn, text: delta})
        for (const v of split.push(delta)) await sentences.send(v, workCtx)
      }
      let answer = ''
      let err = null
      const [ev, found] = await this.retrieve(workCtx, plan, tools, prompt)
      llmStart = performance.now()
      if (plan.skipGemini) {
        answer = actionReply || localReply(plan.localReply, found, lang, this.dev !== null)
        try {
          await onDelta(answer)
        } catch (e) {
          err = e
        }
      } else {
        const offered = tools.tools(plan.tools)
        let decided = false
        for (const t of offered) { // record how long Gemini took to decide on a tool
          const run = t.run
          t.run = (c, args) => {
            if (!decided) {
              decided = true
              m.toolDecisionMS = ms(llmStart)
            }
            return run(c, args)
          }
        }
        const req = {history: this.sess.history(), prompt, language: lang, evidence: ev, tools: offered, maxToolCalls: cfg.toolMaxCalls, system: '', maxOutputTokens: 0}
        if (prof) {
          req.system = prof.systemContext()
          // Finding a record and proposing a change takes at least two calls.
          req.maxToolCalls = Math.max(req.maxToolCalls, cfg.professorToolMaxCalls)
          if (profWrites && s.features.drafts) req.maxOutputTokens = Math.max(cfg.professorOutputTokens, cfg.maxOutputTokens) // drafts are written as tool arguments
        }
        try {
          answer = await s.llm.stream(llmCtx, req, onDelta)
          if (this.acts) {
            // A data-changing tool ended the model's turn: the question the
            // user confirms is generated here from the validated proposal.
            const a = this.acts.staged(turn)
            if (a) {
              const sep = answer.trim() !== '' ? ' ' : ''
              await onDelta(sep + a.summary)
              if (a.history) historyAnswer = (answer + sep + a.history).trim()
              answer = (answer + sep + a.summary).trim()
              m.action = 'proposed:' + a.kind
            }
          }
        } catch (e) {
          err = llmCtx.err && !workCtx.err ? llmCtx.err : e
        }
      }
      m.llmTotalMS = ms(llmStart)
      if (err) {
        workCancel()
      } else {
        const tail = split.flush()
        if (tail !== '') await sentences.send(tail, workCtx).catch(() => {})
      }
      sentences.close()
      const ttsErr = await ttsDone
      if (err) {
        await this.fail(ctx, turn, 'llm_failed', err)
        return
      }
      if (ttsErr) {
        await this.fail(ctx, turn, 'tts_failed', ttsErr)
        return
      }
      if (this.dev) { // devices: wait until the paced audio has been sent
        try {
          await this.dev.endSpeech(ctx, turn)
        } catch (e) {
          await this.fail(ctx, turn, 'playback_failed', e)
          return
        }
      }
      if (this.acts) { // the question was delivered completely: it may now be answered
        const a = this.acts.commit(turn)
        if (a) await this.sendAction(ctx, 'action_pending', a)
      }
      const sources = tools.allSources()
      m.retrievalMS = tools.retrievalMS
      m.webSearchMS = tools.webSearchMS
      m.searches = tools.searches
      m.sources = sources.length
      m.retrievalMethod = tools.retrievalMethod
      const c = citations(answer, sources)
      m.cited = c.cited
      m.invalidCitations = c.invalid
      this.sess.add('user', prompt)
      if (historyAnswer === '') historyAnswer = answer
      this.sess.add('assistant', stripCitations(historyAnswer)) // source ids are per turn
      m.totalMS = ms(started)
      await this.trySend(ctx, {type: 'metrics', turn_id: turn, metrics: metricsJSON(m)})
      await this.trySend(ctx, {type: 'turn_complete', turn_id: turn})
      s.log.info({turn_id: turn, mode: m.mode, searches: m.searches, sources: m.sources, invalid_citations: m.invalidCitations.length, stt_ms: m.sttMS,
        retrieval_ms: round3(m.retrievalMS), web_search_ms: round3(m.webSearchMS), tool_decision_ms: m.toolDecisionMS ?? 0, llm_first_text_ms: m.llmFirstTextMS,
        llm_total_ms: m.llmTotalMS, first_tts_ms: m.firstTTSMS, first_audio_ms: m.firstAudioMS, total_ms: m.totalMS, tool_calls: m.toolCalls, tool_ms: round3(m.toolMS),
        action: m.action ?? '', action_ms: round3(m.actionMS ?? 0), tool_route: m.toolRoute ?? '', route_ms: m.routeMS ?? 0}, 'turn complete')
    } finally {
      this.acts?.discard(turn) // a proposal is confirmable only if its turn completed
      llmCancel()
      workCancel()
    }
  }

  // retrieve runs the plan's up-front searches with the user's words. It
  // returns [evidence for Gemini, number of sources]. Search failures are
  // reported to the client and the model is told about them.
  async retrieve(ctx, plan, tools, prompt) {
    if (plan.preSearchDocs) {
      let sources = []
      let err = null
      try {
        sources = await tools.searchDocs(ctx, prompt, '', 0)
      } catch (e) {
        err = e
      }
      if (plan.skipGemini) return ['', sources.length] // no consent: passages are only shown on screen
      if (err) return [`(Document search failed: ${err.message}. Tell the user the documents could not be searched.)`, 0]
      if (sources.length === 0) return ['(No relevant passages were found in the uploaded documents. Say so; do not answer from general knowledge as if it came from the documents.)', 0]
      return [evidence(sources), sources.length]
    }
    if (plan.preSearchWeb) {
      let sources
      try {
        sources = await tools.searchWeb(ctx, prompt, 0)
      } catch (e) {
        return [`(Web search failed: ${e.message}. Tell the user the web search did not work; do not invent current information or sources.)`, 0]
      }
      if (sources.length === 0) return ['(The web search returned no results. Say so.)', 0]
      return [evidence(sources), sources.length]
    }
    return ['', 0]
  }
}

// finite replaces -Inf (silence) so stats can be encoded as JSON, as Go's
// encoder would have failed on them. The values only feed the debug panel.
function finite(stats) {
  const out = {...stats}
  for (const k of ['peak_dbfs', 'rms_dbfs']) if (!Number.isFinite(out[k])) out[k] = -999
  return out
}

export {Context, hasCode, Channel}
