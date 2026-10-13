// Builds rooms off the main thread for Endless mode: generation takes a second or two,
// and doing it here keeps the game responsive.  game.js only boots the game when there's
// a document, so in a worker it just defines the generator.
importScripts('game.js');
self.onmessage = (e) => {
  const { id, seed, index, twist } = e.data;
  const lv = generateLevel(seed, index, twist || null);
  self.postMessage({ id, level: serializeLevel(lv) });
};
