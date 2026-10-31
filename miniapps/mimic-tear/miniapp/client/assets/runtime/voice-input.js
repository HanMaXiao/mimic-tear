/**
 * 语音输入。
 *
 * 麦克风在页面这一侧，识别在宿主那一侧（`window.mcode.miniapp.speech.transcribe`）。
 * 识别出来的文字只填进给大哥的输入框，**不自动发送**——说话不是拍板，
 * 这条边界和桌宠一样：它替你把话写好，发送仍然是你按。
 *
 * 这一层同时负责录音期间的状态提示。宿主不会替页面显示「正在录音」，
 * 所以页面必须自己说清楚现在处于哪一步，否则用户不知道麦克风还开着没有。
 */

import { el, toast } from '../shared/dom.js';
import {
  describeSpeechError,
  speechErrorCode,
  startSpeechCapture,
  transcribeSpeech,
} from './speech-capture.js';

/** @type {any} */
let capture = null;
let phase = 'idle';

/**
 * 现在的录音状态。
 *
 * @returns {'idle'|'recording'|'transcribing'}
 */
export function voicePhase() {
  return phase;
}

/**
 * 把界面切到某个状态。
 *
 * @param {'idle'|'recording'|'transcribing'} next
 */
function applyPhase(next) {
  phase = next;
  const start = el('voice-start');
  const stop = el('voice-stop');
  const cancel = el('voice-cancel');
  const message = el('voice-message');
  const partial = el('voice-partial');

  if (start) start.disabled = next !== 'idle';
  if (stop) stop.disabled = next !== 'recording';
  if (cancel) cancel.disabled = next === 'idle';
  if (message) {
    message.textContent = {
      idle: '',
      recording: '正在录音，说完点「停止并转写」。',
      transcribing: '正在转写…',
    }[next] ?? '';
    message.dataset.state = next;
  }
  if (partial && next !== 'transcribing') partial.textContent = '';
}

/**
 * 宿主支不支持语音识别。
 *
 * @returns {boolean}
 */
export function voiceSupported() {
  const host = globalThis.window?.mcode?.miniapp;
  if (host?.capabilities?.has) return host.capabilities.has('speech.transcribe') === true;
  return typeof host?.speech?.transcribe === 'function';
}

/**
 * 开始录音。
 */
export async function startVoice() {
  if (phase !== 'idle') return;
  if (!voiceSupported()) {
    toast('这个宿主版本不支持语音识别', 'error');
    applyPhase('idle');
    return;
  }

  applyPhase('recording');
  try {
    capture = await startSpeechCapture();
  } catch (error) {
    capture = null;
    const code = speechErrorCode(error, 'capture');
    applyPhase('idle');
    toast(describeSpeechError(code), 'error');
  }
}

/**
 * 停止录音并转写，结果填进给大哥的输入框。
 */
export async function stopVoice() {
  if (phase !== 'recording' || !capture) return;
  const current = capture;
  capture = null;

  let audio;
  try {
    audio = current.stop();
  } catch (error) {
    applyPhase('idle');
    toast(describeSpeechError(speechErrorCode(error, 'capture')), 'error');
    return;
  }

  if (!audio.length) {
    applyPhase('idle');
    toast(describeSpeechError('no_audio'), 'error');
    return;
  }

  applyPhase('transcribing');
  const partial = el('voice-partial');
  try {
    const result = await transcribeSpeech(audio, {
      onPartial: (text) => {
        if (partial && typeof text === 'string') partial.textContent = text;
      },
    });
    const input = el('chat-input');
    if (input) {
      const existing = input.value.trim();
      input.value = existing ? `${existing}\n${result.text}` : result.text;
      input.focus();
    }
    applyPhase('idle');
    toast('识别好了，内容在输入框里，确认后再发送');
  } catch (error) {
    const code = speechErrorCode(error, 'transcribing');
    applyPhase('idle');
    toast(describeSpeechError(code), 'error');
  }
}

/**
 * 取消这一轮录音。
 */
export function cancelVoice() {
  try {
    capture?.cancel();
  } catch {
    // 取消失败也要把状态收回去，不能让界面停在「正在录音」。
  }
  capture = null;
  applyPhase('idle');
}

/**
 * 把按钮绑上。
 */
export function initVoiceInput() {
  el('voice-start')?.addEventListener('click', () => { void startVoice(); });
  el('voice-stop')?.addEventListener('click', () => { void stopVoice(); });
  el('voice-cancel')?.addEventListener('click', () => { cancelVoice(); });

  if (!voiceSupported()) {
    const start = el('voice-start');
    if (start) {
      start.disabled = true;
      start.title = '这个宿主版本不支持语音识别';
    }
  }
}
