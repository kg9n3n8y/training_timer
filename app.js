(() => {
  const startButton = document.getElementById('startButton');
  const phaseLabel = document.getElementById('phaseLabel');
  const countdownLabel = document.getElementById('countdownLabel');
  const progressRing = document.getElementById('progressRing');
  const timerCard = document.querySelector('.timer-card');
  const copyUrlBtn = document.getElementById('copyUrlBtn');
  const resetConfigBtn = document.getElementById('resetConfigBtn');
  const workSlider = document.getElementById('workSlider');
  const restSlider = document.getElementById('restSlider');
  const setSlider = document.getElementById('setSlider');
  const workSecondsValue = document.getElementById('workSecondsValue');
  const restSecondsValue = document.getElementById('restSecondsValue');
  const setCountValue = document.getElementById('setCountValue');
  const phaseLiveRegion = document.getElementById('phaseLiveRegion');
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;

  const ONE_SECOND_MS = 1000;
  const COUNTDOWN_SECONDS = 3;

  const WORK_MIN_SECONDS = 10;
  const WORK_MAX_SECONDS = 60;
  const WORK_STEP_SECONDS = 10;
  const REST_MIN_SECONDS = 10;
  const REST_MAX_SECONDS = 60;
  const REST_STEP_SECONDS = 10;
  const SET_MIN_COUNT = 1;
  const SET_MAX_COUNT = 10;

  const DEFAULT_WORK_SECONDS = 30;
  const DEFAULT_REST_SECONDS = 30;
  const DEFAULT_SET_COUNT = 3;

  const CONFIG_STORAGE_KEY = 'trainingTimerConfig:v1';

  const storage = (() => {
    try {
      return window.localStorage;
    } catch (_) {
      return null;
    }
  })();

  let workSeconds = DEFAULT_WORK_SECONDS;
  let restSeconds = DEFAULT_REST_SECONDS;
  let setCount = DEFAULT_SET_COUNT;
  let phases = [];
  let totalSeconds = 0;

  let isRunning = false;
  let isCountdown = false;
  let currentIndex = 0;
  let phaseEndTs = 0;
  let timerRaf = 0;
  let totalStartTs = 0;
  let countdownStartTs = 0;
  let countdownRaf = 0;
  let audioCtx = null;

  const BELL_PARTIALS = [
    { ratio: 1, gain: 1, decay: 1.9, detune: -6 },
    { ratio: 2.01, gain: 0.55, decay: 1.7, detune: 4 },
    { ratio: 2.71, gain: 0.3, decay: 1.6, detune: -2 },
    { ratio: 3.8, gain: 0.2, decay: 1.45, detune: 3 },
    { ratio: 5.15, gain: 0.12, decay: 1.3, detune: -4 },
  ];

  const BELL_CONFIGS = {
    work: {
      baseFrequency: 987.77,
      strikes: 2,
      strikeInterval: 0.12,
      decay: 1.4,
      level: 0.85,
    },
    rest: {
      baseFrequency: 659.25,
      strikes: 1,
      strikeInterval: 0,
      decay: 1.6,
      level: 0.7,
    },
    finish: {
      baseFrequency: 1318.5,
      strikes: 3,
      strikeInterval: 0.14,
      decay: 1.7,
      level: 0.95,
    },
    default: {
      baseFrequency: 880,
      strikes: 1,
      strikeInterval: 0,
      decay: 1.5,
      level: 0.75,
    },
  };

  function clampNumber(value, min, max, fallback, step = 1) {
    if (!Number.isFinite(value)) return fallback;
    const rounded = Math.round(value / step) * step;
    return Math.min(max, Math.max(min, rounded));
  }

  function getSliderValue(slider, fallback, min, max, step) {
    if (!slider) return fallback;
    const raw = Number(slider.value);
    return clampNumber(raw, min, max, fallback, step);
  }

  function loadStoredConfig() {
    if (!storage) return null;
    try {
      const raw = storage.getItem(CONFIG_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed;
    } catch (_) {
      return null;
    }
  }

  function saveStoredConfig(config) {
    if (!storage) return;
    try {
      storage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(config));
    } catch (_) {}
  }

  function applyStoredConfigToSliders(config) {
    if (!config) return;
    const nextWork = clampNumber(
      config.workSeconds,
      WORK_MIN_SECONDS,
      WORK_MAX_SECONDS,
      DEFAULT_WORK_SECONDS,
      WORK_STEP_SECONDS
    );
    const nextRest = clampNumber(
      config.restSeconds,
      REST_MIN_SECONDS,
      REST_MAX_SECONDS,
      DEFAULT_REST_SECONDS,
      REST_STEP_SECONDS
    );
    const nextSets = clampNumber(
      config.setCount,
      SET_MIN_COUNT,
      SET_MAX_COUNT,
      DEFAULT_SET_COUNT
    );
    if (workSlider) workSlider.value = String(nextWork);
    if (restSlider) restSlider.value = String(nextRest);
    if (setSlider) setSlider.value = String(nextSets);
  }

  function applyDefaultConfigToSliders() {
    if (workSlider) workSlider.value = String(DEFAULT_WORK_SECONDS);
    if (restSlider) restSlider.value = String(DEFAULT_REST_SECONDS);
    if (setSlider) setSlider.value = String(DEFAULT_SET_COUNT);
  }

  applyStoredConfigToSliders(loadStoredConfig());

  function buildPhases(workSec, restSec, sets) {
    const result = [];
    for (let i = 0; i < sets; i += 1) {
      result.push({
        type: 'work',
        duration: workSec,
        setIndex: i + 1,
        label: `トレーニング ${i + 1}/${sets}`,
      });
      if (i < sets - 1) {
        result.push({
          type: 'rest',
          duration: restSec,
          setIndex: i + 1,
          label: `休憩 ${i + 1}/${sets}`,
        });
      }
    }
    return result;
  }

  function getTotalSeconds(sequence) {
    return sequence.reduce((sum, phase) => sum + phase.duration, 0);
  }

  function updateProgress(totalElapsedSec) {
    const progressDeg = totalSeconds
      ? Math.min(360, (totalElapsedSec / totalSeconds) * 360)
      : 0;
    progressRing.style.background = `conic-gradient(var(--accent) ${progressDeg}deg, var(--track) ${progressDeg}deg)`;
  }

  function updatePhaseLabel(text, announce = true) {
    phaseLabel.textContent = text;
    if (announce && phaseLiveRegion) {
      phaseLiveRegion.textContent = `${text}`;
    }
  }

  function updateConfigDisplay() {
    if (workSlider) {
      workSlider.value = String(workSeconds);
      workSlider.setAttribute('aria-valuenow', String(workSeconds));
      workSlider.setAttribute('aria-valuetext', `${workSeconds}秒`);
    }
    if (restSlider) {
      restSlider.value = String(restSeconds);
      restSlider.setAttribute('aria-valuenow', String(restSeconds));
      restSlider.setAttribute('aria-valuetext', `${restSeconds}秒`);
    }
    if (setSlider) {
      setSlider.value = String(setCount);
      setSlider.setAttribute('aria-valuenow', String(setCount));
      setSlider.setAttribute('aria-valuetext', `${setCount}セット`);
    }
    if (workSecondsValue) workSecondsValue.textContent = String(workSeconds);
    if (restSecondsValue) restSecondsValue.textContent = String(restSeconds);
    if (setCountValue) setCountValue.textContent = String(setCount);
  }

  function persistCurrentConfig() {
    saveStoredConfig({
      workSeconds,
      restSeconds,
      setCount,
    });
  }

  function applyConfig(options = {}) {
    const { persist = true } = options;
    workSeconds = getSliderValue(
      workSlider,
      DEFAULT_WORK_SECONDS,
      WORK_MIN_SECONDS,
      WORK_MAX_SECONDS,
      WORK_STEP_SECONDS
    );
    restSeconds = getSliderValue(
      restSlider,
      DEFAULT_REST_SECONDS,
      REST_MIN_SECONDS,
      REST_MAX_SECONDS,
      REST_STEP_SECONDS
    );
    setCount = getSliderValue(
      setSlider,
      DEFAULT_SET_COUNT,
      SET_MIN_COUNT,
      SET_MAX_COUNT,
      1
    );
    phases = buildPhases(workSeconds, restSeconds, setCount);
    totalSeconds = getTotalSeconds(phases);
    reset();
    updateConfigDisplay();
    if (persist) {
      persistCurrentConfig();
    }
  }

  function formatSeconds(sec) {
    return Math.max(0, Math.ceil(sec)).toString();
  }

  function announceConfig() {
    if (!phaseLiveRegion) return;
    phaseLiveRegion.textContent = `トレーニング${workSeconds}秒、休憩${restSeconds}秒、${setCount}セットでタイマーを設定しました`;
  }

  function tryVibrate(patternInput) {
    if (navigator.vibrate) {
      try {
        navigator.vibrate(patternInput);
      } catch (_) {}
    }
  }

  function prepareAudioContext() {
    if (audioCtx || !AudioContextClass) return;
    try {
      audioCtx = new AudioContextClass();
    } catch (_) {
      audioCtx = null;
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
  }

  function applyMasterEnvelope(gainNode, startTime, envelope) {
    const epsilon = 0.0001;
    if (!envelope) {
      gainNode.gain.setValueAtTime(epsilon, startTime);
      gainNode.gain.exponentialRampToValueAtTime(0.4, startTime + 0.015);
      gainNode.gain.exponentialRampToValueAtTime(epsilon, startTime + 1.2);
      return;
    }
    const {
      attack = 0.012,
      decay = 0.18,
      sustain = 0.4,
      release = 1.2,
      peak = 0.5,
      sustainLevel = 0.18,
    } = envelope;
    gainNode.gain.cancelScheduledValues(startTime);
    gainNode.gain.setValueAtTime(epsilon, startTime);
    gainNode.gain.exponentialRampToValueAtTime(Math.max(peak, epsilon * 2), startTime + attack);
    gainNode.gain.linearRampToValueAtTime(Math.max(sustainLevel, epsilon * 2), startTime + attack + decay);
    gainNode.gain.setValueAtTime(Math.max(sustainLevel, epsilon * 2), startTime + attack + decay + sustain);
    gainNode.gain.exponentialRampToValueAtTime(
      epsilon,
      startTime + attack + decay + sustain + release
    );
  }

  function strikeBell(targetNode, baseFrequency, startTime, options = {}) {
    const { decay = 1.5, level = 0.8 } = options;
    const epsilon = 0.0001;
    BELL_PARTIALS.forEach((partial, index) => {
      const oscillator = audioCtx.createOscillator();
      oscillator.type = 'sine';
      const freq = baseFrequency * partial.ratio;
      oscillator.frequency.setValueAtTime(freq, startTime);
      if (typeof partial.detune === 'number') {
        oscillator.detune.setValueAtTime(partial.detune * 10, startTime);
      }
      const gainNode = audioCtx.createGain();
      const peak = Math.max(partial.gain * level, epsilon * 2);
      const partialDecay = Math.max(partial.decay * decay, 0.4);
      const attack = 0.008 + index * 0.002;
      gainNode.gain.setValueAtTime(epsilon, startTime);
      gainNode.gain.exponentialRampToValueAtTime(peak, startTime + attack);
      gainNode.gain.exponentialRampToValueAtTime(
        epsilon,
        startTime + partialDecay
      );
      oscillator.connect(gainNode).connect(targetNode);
      oscillator.start(startTime);
      oscillator.stop(startTime + partialDecay + 0.4);
    });
  }

  function playPhaseSound(phaseType) {
    if (!AudioContextClass) return;
    if (!audioCtx) {
      prepareAudioContext();
    }
    if (!audioCtx) return;
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
      if (audioCtx.state !== 'running') {
        return;
      }
    }
    const now = audioCtx.currentTime;
    const preset = BELL_CONFIGS[phaseType] || BELL_CONFIGS.default;
    const masterGain = audioCtx.createGain();
    applyMasterEnvelope(masterGain, now, {
      attack: 0.01,
      decay: 0.2,
      sustain: 0.45,
      release: preset.decay + 0.6,
      peak: 0.55 * preset.level,
      sustainLevel: 0.2 * preset.level,
    });
    masterGain.connect(audioCtx.destination);

    const filterNode = audioCtx.createBiquadFilter();
    filterNode.type = 'lowpass';
    filterNode.frequency.setValueAtTime(5200, now);
    filterNode.Q.setValueAtTime(1.2, now);
    filterNode.connect(masterGain);

    for (let i = 0; i < preset.strikes; i += 1) {
      const strikeTime = now + i * (preset.strikeInterval || 0);
      strikeBell(filterNode, preset.baseFrequency, strikeTime, {
        decay: preset.decay,
        level: preset.level * (i === 0 ? 1 : 0.75),
      });
    }
  }

  function reset() {
    stopCountdown();
    isRunning = false;
    cancelAnimationFrame(timerRaf);
    timerRaf = 0;
    currentIndex = 0;
    phaseEndTs = 0;
    totalStartTs = 0;
    startButton.textContent = 'スタート';
    startButton.setAttribute('aria-label', 'タイマー開始');
    updatePhaseLabel('タップで開始', false);
    countdownLabel.textContent = String(totalSeconds);
    updateProgress(0);
  }

  function startCountdown() {
    if (isRunning || isCountdown) return;
    isCountdown = true;
    startButton.textContent = 'ストップ';
    startButton.setAttribute('aria-label', 'タイマー停止');
    updatePhaseLabel('準備');
    countdownLabel.textContent = String(COUNTDOWN_SECONDS);
    updateProgress(0);
    countdownStartTs = performance.now();
    countdownRaf = requestAnimationFrame(countdownLoop);
    tryVibrate(30);
  }

  function stopCountdown() {
    if (!isCountdown) return;
    isCountdown = false;
    cancelAnimationFrame(countdownRaf);
    countdownRaf = 0;
    countdownStartTs = 0;
  }

  function countdownLoop(now) {
    if (!isCountdown) return;
    const elapsedSec = (now - countdownStartTs) / ONE_SECOND_MS;
    const remaining = COUNTDOWN_SECONDS - elapsedSec;
    if (remaining <= 0) {
      stopCountdown();
      beginSession(now);
      return;
    }
    countdownLabel.textContent = String(Math.max(1, Math.ceil(remaining)));
    countdownRaf = requestAnimationFrame(countdownLoop);
  }

  function beginSession(startTimestamp = performance.now()) {
    if (isRunning) return;
    if (!phases.length) return;
    isRunning = true;
    currentIndex = 0;
    totalStartTs = startTimestamp;
    const first = phases[currentIndex];
    updatePhaseLabel(first.label);
    phaseEndTs = totalStartTs + first.duration * ONE_SECOND_MS;
    countdownLabel.textContent = String(first.duration);
    updateProgress(0);
    timerRaf = requestAnimationFrame(loop);
    tryVibrate([60, 40, 60]);
    playPhaseSound(first.type);
  }

  function finish() {
    isRunning = false;
    cancelAnimationFrame(timerRaf);
    timerRaf = 0;
    updatePhaseLabel('完了!');
    countdownLabel.textContent = '0';
    tryVibrate([80, 60, 80, 60, 120]);
    playPhaseSound('finish');
    setTimeout(() => {
      reset();
    }, 1500);
  }

  function loop() {
    const now = performance.now();
    const totalElapsedSec = (now - totalStartTs) / ONE_SECOND_MS;
    updateProgress(totalElapsedSec);

    const currentPhase = phases[currentIndex];
    const remainingCurrent = (phaseEndTs - now) / ONE_SECOND_MS;
    countdownLabel.textContent = formatSeconds(remainingCurrent);

    if (remainingCurrent <= 0) {
      currentIndex += 1;
      if (currentIndex >= phases.length) {
        finish();
        return;
      }
      const nextPhase = phases[currentIndex];
      updatePhaseLabel(nextPhase.label);
      phaseEndTs = now + nextPhase.duration * ONE_SECOND_MS;
      countdownLabel.textContent = String(nextPhase.duration);
      const vibePattern = nextPhase.type === 'work' ? [100, 50, 100] : [60, 40, 60];
      tryVibrate(vibePattern);
      playPhaseSound(nextPhase.type);
    }

    timerRaf = requestAnimationFrame(loop);
  }

  function onButtonClick() {
    prepareAudioContext();
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    if (isRunning || isCountdown) {
      reset();
    } else {
      startCountdown();
    }
  }

  if (startButton) {
    startButton.addEventListener(
      'click',
      (event) => {
        event.stopPropagation();
        onButtonClick();
      },
      { passive: true }
    );
  }

  if (timerCard) {
    timerCard.addEventListener(
      'click',
      () => {
        onButtonClick();
      },
      { passive: true }
    );
    timerCard.tabIndex = 0;
    timerCard.setAttribute('role', 'button');
    timerCard.setAttribute('aria-label', 'タイマーの開始と停止');
    timerCard.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onButtonClick();
      }
    });
  }

  if (workSlider) {
    workSlider.addEventListener('input', () => {
      applyConfig({ persist: false });
    });
    workSlider.addEventListener('change', () => {
      const next = getSliderValue(
        workSlider,
        DEFAULT_WORK_SECONDS,
        WORK_MIN_SECONDS,
        WORK_MAX_SECONDS,
        WORK_STEP_SECONDS
      );
      if (next !== workSeconds) {
        applyConfig();
      } else {
        persistCurrentConfig();
      }
      announceConfig();
    });
  }

  if (restSlider) {
    restSlider.addEventListener('input', () => {
      applyConfig({ persist: false });
    });
    restSlider.addEventListener('change', () => {
      const next = getSliderValue(
        restSlider,
        DEFAULT_REST_SECONDS,
        REST_MIN_SECONDS,
        REST_MAX_SECONDS,
        REST_STEP_SECONDS
      );
      if (next !== restSeconds) {
        applyConfig();
      } else {
        persistCurrentConfig();
      }
      announceConfig();
    });
  }

  if (setSlider) {
    setSlider.addEventListener('input', () => {
      applyConfig({ persist: false });
    });
    setSlider.addEventListener('change', () => {
      const next = getSliderValue(
        setSlider,
        DEFAULT_SET_COUNT,
        SET_MIN_COUNT,
        SET_MAX_COUNT,
        1
      );
      if (next !== setCount) {
        applyConfig();
      } else {
        persistCurrentConfig();
      }
      announceConfig();
    });
  }

  if (resetConfigBtn) {
    resetConfigBtn.addEventListener(
      'click',
      () => {
        applyDefaultConfigToSliders();
        applyConfig();
        announceConfig();
      },
      { passive: true }
    );
  }

  if (copyUrlBtn) {
    copyUrlBtn.addEventListener(
      'click',
      async () => {
        const url = window.location.href;
        try {
          await navigator.clipboard.writeText(url);
          copyUrlBtn.textContent = 'コピーしました';
          setTimeout(() => {
            copyUrlBtn.textContent = 'URLをコピー';
          }, 1500);
        } catch (_) {
          const ta = document.createElement('textarea');
          ta.value = url;
          document.body.appendChild(ta);
          ta.select();
          try {
            document.execCommand('copy');
          } catch (_) {}
          document.body.removeChild(ta);
          copyUrlBtn.textContent = 'コピーしました';
          setTimeout(() => {
            copyUrlBtn.textContent = 'URLをコピー';
          }, 1500);
        }
      },
      { passive: true }
    );
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./service-worker.js').catch(() => {});
    });
  }

  document.addEventListener('visibilitychange', () => {
    if (!isRunning) return;
    if (document.hidden) {
      reset();
    }
  });

  applyConfig();
  announceConfig();
})();
