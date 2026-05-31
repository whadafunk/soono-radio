/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        zinc: {
          950: '#09090b',
        },
        brand: {
          300: '#a5f3f3',
          400: '#67e0e0',
          500: '#36c8c8',
          600: '#0d9488',
          700: '#0a7571',
          800: '#085f5c',
          900: '#053d3a',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
