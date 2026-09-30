class PcmProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const { inputSampleRate, targetSampleRate } = options.processorOptions
    this.ratio = inputSampleRate / targetSampleRate
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0]
    const output = outputs[0]?.[0]
    if (output) output.fill(0)
    if (!input) return true

    const length = Math.floor(input.length / this.ratio)
    if (!length) return true
    const samples = new Int16Array(length)
    for (let index = 0; index < length; index += 1) {
      const sample = input[Math.floor(index * this.ratio)] || 0
      samples[index] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)))
    }
    this.port.postMessage(samples.buffer, [samples.buffer])
    return true
  }
}

registerProcessor('campuspilot-pcm', PcmProcessor)