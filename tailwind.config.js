/** @type {import('tailwindcss').Config} */

const arcoColor = (cssVariable) => ({ opacityValue }) => {
  if (opacityValue === undefined) return `var(${cssVariable})`;

  const opacity = Number(opacityValue);
  const percentage = Number.isNaN(opacity) ? `calc(${opacityValue} * 100%)` : `${opacity * 100}%`;
  return `color-mix(in srgb, var(${cssVariable}) ${percentage}, transparent)`;
};

export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        'dark-bg': arcoColor('--color-bg-2'),
        'brand-green': arcoColor('--primary-6'),
        'glass-border': arcoColor('--color-border-2'),
        'text-primary': arcoColor('--color-text-1'),
        'text-secondary': arcoColor('--color-text-2'),
        'document-paper': arcoColor('--cmhub-document-paper'),
        'document-ink': arcoColor('--cmhub-document-ink'),
        white: arcoColor('--color-fill-2'),
        black: arcoColor('--color-text-1'),
        red: {
          200: arcoColor('--danger-3'),
          300: arcoColor('--danger-4'),
          400: arcoColor('--danger-5'),
          500: arcoColor('--danger-6'),
          950: arcoColor('--danger-10'),
        },
        green: {
          400: arcoColor('--success-5'),
          500: arcoColor('--success-6'),
        },
        amber: {
          200: arcoColor('--warning-3'),
        },
      },
      borderRadius: {
        '4xl': '2rem',
      },
      blur: {
        '4xl': '2rem',
      },
    },
  },
  plugins: [],
};
