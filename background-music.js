export const createBackgroundMusicController = (audio, { volume = 0.16 } = {}) => {
  if (!audio || typeof audio.play !== 'function' || typeof audio.pause !== 'function') {
    throw new TypeError('A playable audio element is required.');
  }

  audio.loop = true;
  audio.preload = 'auto';
  audio.volume = volume;

  let enabled = true;
  let started = false;

  const play = async () => {
    if (!enabled || !started) return false;
    try {
      await audio.play();
      return true;
    } catch {
      return false;
    }
  };

  return {
    start() {
      started = true;
      return play();
    },
    setEnabled(nextEnabled) {
      enabled = Boolean(nextEnabled);
      if (!enabled) {
        audio.pause();
        return Promise.resolve(false);
      }
      return play();
    },
    stop() {
      started = false;
      audio.pause();
      audio.currentTime = 0;
    },
  };
};
