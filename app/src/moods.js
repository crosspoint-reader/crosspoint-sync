// Emoji for Hardcover's mood tags (shared by the book page and Stats). Hardcover
// files pace ("fast-paced") under moods too; those are split out as pace.
const EMOJI = {
  adventurous: '🗺️',
  challenging: '🧗',
  dark: '🌑',
  emotional: '🥹',
  funny: '😂',
  hopeful: '🌅',
  informative: '💡',
  inspiring: '✨',
  lighthearted: '🎈',
  mysterious: '🔍',
  reflective: '🪞',
  relaxing: '🛋️',
  sad: '😢',
  tense: '😬',
  romantic: '💕',
  cozy: '☕',
  scary: '👻',
  'fast-paced': '⚡',
  'medium-paced': '🚶',
  'slow-paced': '🐢',
}

export const moodEmoji = (mood) => EMOJI[mood.toLowerCase()] ?? '📖'
export const isPace = (mood) => /-paced$/i.test(mood)
