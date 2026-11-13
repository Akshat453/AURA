// Pacer schedules downlink audio frames so a device's playback buffer holds
// about lead of audio and never more than lead (times in milliseconds).
//
// Device contract (docs/DEVICE_PROTOCOL.md): the device starts or resumes
// playback once it has buffered lead_ms (or tts_end arrived) and plays one
// frame per frame_ms; if its buffer empties before tts_end it counts an
// underrun and re-buffers lead_ms before resuming.
//
// The pacer models that buffer: buffered(t) = sent·frame − (t − start). Frame
// n is due once sending it keeps the buffer at or below lead, so the first
// lead/frame frames go out at once and later frames one per frame, anchored to
// start (no cumulative drift). When frames arrive late the modelled buffer
// goes negative: the device has underrun, so the pacer re-anchors and
// prefills lead again instead of bursting to "catch up".
export class Pacer {
  constructor(frameMs, leadMs) {
    this.frame = frameMs
    this.lead = leadMs
    this.start = 0
    this.sent = 0
    this.underruns = 0 // estimated by the server; the device reports actual counts
    this.maxBuffered = 0
  }

  // due returns when (epoch ms) the next frame may be sent, given now.
  due(now) {
    if (this.sent === 0) {
      this.start = now
      return now
    }
    const buffered = this.sent * this.frame - (now - this.start)
    if (buffered < 0) {
      this.underruns++
      this.start = now
      this.sent = 0
      return now
    }
    // Sending frame n raises the buffer to (n+1)·frame − elapsed; keep it ≤ lead.
    return this.start + (this.sent + 1) * this.frame - this.lead
  }

  // markSent records that a frame was written at now.
  markSent(now) {
    this.sent++
    const b = this.sent * this.frame - (now - this.start)
    if (b > this.maxBuffered) this.maxBuffered = b
  }
}
