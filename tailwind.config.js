/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'dark-bg': '#101412',
        'brand-green': '#80ff00',
        'glass-border': '#ffffff',
        'text-primary': '#FFFFFF',
        'text-secondary': '#E0E0E0',
      },
      borderRadius: {
        '4xl': '2rem',
      },
      blur: {
        '4xl': '2rem',
      }
    },
  },
  plugins: [],
}
