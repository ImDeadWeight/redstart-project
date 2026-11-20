/** @type {import('tailwindcss').Config} */
const colors = require('tailwindcss/colors')

module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Help text across the launcher is zinc-500. Tailwind's #71717a reads at
        // about 3.9:1 on the zinc-900 cards, under the 4.5:1 small text needs;
        // this lighter grey reads at about 5.6:1 and keeps it a step below
        // zinc-400. (zinc-600 text was moved to zinc-500 for the same reason.)
        zinc: { ...colors.zinc, 500: '#8e8e96' },
      },
    },
  },
  plugins: [],
}
