export const createSuccessSoundController = (audio, { volume = 0.7 } = {}) => {
  if (!audio || typeof audio.play !== 'function' || typeof audio.pause !== 'function') {
    throw new TypeError('A playable audio element is required.');
  }

  audio.preload = 'auto';
  audio.volume = volume;

  let enabled = true;

  return {
    async play() {
      if (!enabled) return false;
      audio.currentTime = 0;
      try {
        await audio.play();
        return true;
      } catch {
        return false;
      }
    },
    setEnabled(nextEnabled) {
      enabled = Boolean(nextEnabled);
      if (!enabled) audio.pause();
    },
  };
};
