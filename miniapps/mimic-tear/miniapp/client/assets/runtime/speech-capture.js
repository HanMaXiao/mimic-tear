/**
 * 麦克风录音 → 宿主语音识别。
 *
 * 浏览器负责录音，宿主负责转写——这是宿主划的界：页面拥有麦克风和交互，宿主只做识别。
 * 宿主把这段做成了可复制的捕获助手（`miniapp-creator/references/audio-capture.ts`），
 * 本文件是它的 JS 版，改动有两处：
 *
 * 1. 录音不假设 AudioContext 的采样率就是 16 kHz。宿主要的是 16 kHz 单声道 16 位小端，
 *    而 AudioContext 常常按硬件的 44.1/48 kHz 跑，所以这里在停止时自己做重采样，
 *    而不是把 48 kHz 的样本谎报成 16 kHz。
 * 2. 停止录音的路必须独立于「麦克风权限还没批下来」这件事：用户按下停止时，
 *    `getUserMedia` 可能还在等系统的权限弹窗，这时停止要把这段录音整个作废，
 *    不能留着麦克风一直开。
 *
 * 宿主侧的 `audio-capture.ts` 与 MiniMax Pet 的 `speech-input.mjs` 均出自 MiniMax，
 * MIT 许可（Copyright (c) 2026 MiniMax），此处按其思路重写。
 */

/** 宿主识别服务要的音频格式。 */
export const SPEECH_AUDIO_FORMAT = Object.freeze({
  sampleRate: 16000,
  channelCount: 1,
  sampleFormat: 's16',
});

const BUFFER_SIZE = 4096;

/** 一段录音的最长时长（毫秒）。超过就自动停，避免忘关麦。 */
export const MAX_RECORDING_MS = 60000;

/** 宿主语音接口会返回的失败码。 */
const HOST_ERROR_CODES = new Set([
  'invalid_request',
  'not_permitted',
  'audio_too_large',
  'busy',
  'runtime_unavailable',
  'transcription_failed',
  'result_unknown',
]);

/**
 * 把失败翻译成一句能直接给人看的话。
 *
 * @param {any} error
 * @param {'capture'|'transcribing'} phase
 * @returns {string}
 */
export function speechErrorCode(error, phase) {
  const code = error?.code || error?.message;
  if (HOST_ERROR_CODES.has(code)) return code;
  if (['NotAllowedError', 'PermissionDeniedError', 'SecurityError'].includes(error?.name)) return 'not_permitted';
  if (['NotFoundError', 'DevicesNotFoundError', 'NotReadableError', 'TrackStartError', 'OverconstrainedError'].includes(error?.name)) {
    return 'microphone_unavailable';
  }
  return phase === 'transcribing' ? 'result_unknown' : 'capture_failed';
}

/**
 * 把一段失败翻译成人话。
 *
 * @param {string} code
 * @returns {string}
 */
export function describeSpeechError(code) {
  const table = {
    not_permitted: '宿主没有放开麦克风——在插件详情里打开「使用麦克风」开关。',
    microphone_unavailable: '找不到可用的麦克风。',
    capture_failed: '录音没能开始。',
    no_audio: '没有录到声音。',
    busy: '上一次转写还没结束。',
    runtime_unavailable: '宿主的语音识别没开或没有登录。',
    transcription_failed: '语音服务没给出结果，录音可以重发。',
    result_unknown: '宿主没能把识别结果送回来。',
    audio_too_large: '录音太长了。',
    unsupported: '这个宿主版本不支持语音识别。',
  };
  return table[code] ?? '语音识别没有完成。';
}

/**
 * 把采集到的浮点样本重采样成 16 kHz 单声道 16 位小端。
 *
 * @param {Float32Array[]} chunks
 * @param {number} length 样本总数
 * @param {number} sampleRate 采集时的采样率
 * @returns {Int16Array}
 */
export function toPcm16k(chunks, length, sampleRate) {
  const samples = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    samples.set(chunk, offset);
    offset += chunk.length;
  }

  const ratio = sampleRate / SPEECH_AUDIO_FORMAT.sampleRate;
  const out = new Int16Array(Math.max(0, Math.floor(length / ratio)));
  for (let i = 0; i < out.length; i += 1) {
    const start = i * ratio;
    let sample;
    if (ratio >= 1) {
      // 降采样：把源区间按权重平均掉，含小数边——直接丢样本会丢掉高频。
      const end = Math.min(length, (i + 1) * ratio);
      let sum = 0;
      for (let j = Math.floor(start); j < Math.ceil(end); j += 1) {
        const weight = Math.min(end, j + 1) - Math.max(start, j);
        sum += (Number.isFinite(samples[j]) ? samples[j] : 0) * weight;
      }
      sample = sum / (end - start);
    } else {
      // 升采样：在两个源样本之间线性插值。
      const left = Math.floor(start);
      const right = Math.min(length - 1, left + 1);
      const fraction = start - left;
      sample = samples[left] * (1 - fraction) + samples[right] * fraction;
    }
    sample = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0;
    out[i] = Math.round(sample < 0 ? sample * 32768 : sample * 32767);
  }
  return out;
}

/**
 * 打开麦克风并开始录音。
 *
 * 返回的句柄自己管住「停止」：无论用户是点停止还是这一轮超时，麦克风一定会被释放。
 *
 * @param {{getUserMedia?:Function, createAudioContext?:Function, setTimeout?:Function}} [dependencies]
 *   测试时替换浏览器边界。
 * @returns {Promise<{stop:Function, cancel:Function, level:number}>}
 */
export async function startSpeechCapture(dependencies = {}) {
  const getUserMedia = dependencies.getUserMedia
    ?? ((constraints) => globalThis.navigator?.mediaDevices?.getUserMedia(constraints));
  const createAudioContext = dependencies.createAudioContext
    ?? (() => {
      const AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext;
      return new AudioContextClass({ sampleRate: SPEECH_AUDIO_FORMAT.sampleRate });
    });
  const schedule = dependencies.setTimeout ?? globalThis.setTimeout.bind(globalThis);

  const context = createAudioContext();
  if (!Number.isFinite(context.sampleRate) || context.sampleRate <= 0) {
    throw Object.assign(new Error('Invalid microphone sample rate'), { name: 'NotReadableError' });
  }

  let stream = null;
  let source = null;
  let processor = null;
  let mute = null;
  let released = false;
  let timer = null;
  const chunks = [];
  let frames = 0;
  let level = 0;

  const release = () => {
    if (released) return;
    released = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (processor) processor.onaudioprocess = null;
    for (const node of [source, processor, mute]) {
      try { node?.disconnect(); } catch { /* 继续释放剩下的资源。 */ }
    }
    for (const track of stream?.getTracks?.() ?? []) {
      try { track.stop(); } catch { /* 继续释放剩下的资源。 */ }
    }
    try { void context.close().catch(() => {}); } catch { /* 忽略关闭失败。 */ }
  };

  const stop = () => {
    const pcm = frames > 0 ? toPcm16k(chunks, frames, context.sampleRate) : new Int16Array(0);
    release();
    chunks.length = 0;
    return pcm;
  };

  const cancel = () => {
    release();
    chunks.length = 0;
    frames = 0;
  };

  // 权限弹窗可能一直不回来，所以麦克风的打开与停止要分开处理：
  // 先拿到 AudioContext（同步，不需要权限），再去要麦克风。
  const resumed = Promise.resolve(context.resume());
  let media;
  try {
    media = getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        autoGainControl: true,
        noiseSuppression: true,
      },
    });
  } catch (error) {
    media = Promise.reject(error);
  }

  try {
    stream = await media;
    await resumed;
  } catch (error) {
    release();
    throw error;
  }

  const tracks = stream?.getAudioTracks?.() ?? stream?.getTracks?.() ?? [];
  if (!tracks.length || tracks.every((track) => track.readyState === 'ended')) {
    release();
    throw Object.assign(new Error('No active microphone'), { name: 'NotFoundError' });
  }

  source = context.createMediaStreamSource(stream);
  processor = context.createScriptProcessor(BUFFER_SIZE, 1, 1);
  mute = context.createGain();
  mute.gain.value = 0;

  processor.onaudioprocess = (event) => {
    if (released) return;
    try {
      const input = event.inputBuffer;
      const length = input.length;
      const mono = new Float32Array(length);
      const channels = input.numberOfChannels;
      for (let channel = 0; channel < channels; channel += 1) {
        const values = input.getChannelData(channel);
        for (let i = 0; i < length; i += 1) mono[i] += (Number.isFinite(values[i]) ? values[i] : 0) / channels;
      }
      chunks.push(mono);
      frames += length;

      let sum = 0;
      for (let i = 0; i < mono.length; i += 1) sum += mono[i] ** 2;
      level = Math.min(1, Math.sqrt(sum / Math.max(1, mono.length)) / 0.15);
    } catch {
      // 采集循环里抛错就当这一块丢了，不能让整段录音崩掉。
    }
  };

  source.connect(processor);
  processor.connect(mute);
  mute.connect(context.destination);

  timer = schedule(() => {
    // 超时自动收尾：麦克风不会一直开着。
    stop();
  }, MAX_RECORDING_MS);

  return {
    stop,
    cancel,
    get level() {
      return level;
    },
  };
}

/**
 * 把一段录音交给宿主识别。
 *
 * @param {Int16Array} audio
 * @param {{getMiniApp?:Function, onPartial?:Function}} [options]
 * @returns {Promise<{text:string}>}
 */
export async function transcribeSpeech(audio, options = {}) {
  const getMiniApp = options.getMiniApp ?? (() => globalThis.window?.mcode?.miniapp);
  const host = getMiniApp();
  const speech = host?.speech;
  if (!speech || typeof speech.transcribe !== 'function') {
    throw Object.assign(new Error('unsupported'), { code: 'unsupported' });
  }
  const onPartial = typeof options.onPartial === 'function' ? options.onPartial : undefined;
  const result = await speech.transcribe(
    { audio, format: { ...SPEECH_AUDIO_FORMAT } },
    onPartial ? { onPartial } : {},
  );
  if (!result || typeof result.text !== 'string') {
    throw Object.assign(new Error('result_unknown'), { code: 'result_unknown' });
  }
  return result;
}
