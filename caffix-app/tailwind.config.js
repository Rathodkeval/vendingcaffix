/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        cream: {
          light: '#FAF6F0',
          DEFAULT: '#F5E6D3',
          dark: '#EED9C4',
        },
        coffee: {
          light: '#8C6246',
          DEFAULT: '#4E3629',
          dark: '#2C1E17',
        },
        gold: {
          light: '#DCC39A',
          DEFAULT: '#C9A66B',
          dark: '#B08E55',
        },
        success: '#2E7D32',
      },
      fontFamily: {
        sans: ['Outfit', 'Inter', 'sans-serif'],
      },
      aspectRatio: {
        '5/3': '5 / 3',
      },
    },
  },
  plugins: [],
}
