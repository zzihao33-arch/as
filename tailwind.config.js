/** @type {import('tailwindcss').Config} */

const tokenColor = (cssVariable) => ({ opacityValue }) => {
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
        canvas: tokenColor('--cmhub-surface-canvas'),
        surface: tokenColor('--cmhub-surface-base'),
        'surface-raised': tokenColor('--cmhub-surface-raised'),
        'surface-selected': tokenColor('--cmhub-surface-selected'),
        foreground: tokenColor('--cmhub-text-primary'),
        muted: tokenColor('--cmhub-text-secondary'),
        subtle: tokenColor('--cmhub-text-tertiary'),
        border: tokenColor('--cmhub-line-subtle'),
        primary: {
          DEFAULT: tokenColor('--cmhub-interactive-primary'),
          hover: tokenColor('--cmhub-interactive-primary-hover'),
          active: tokenColor('--cmhub-interactive-primary-active'),
          foreground: tokenColor('--cmhub-text-on-accent'),
        },
        success: tokenColor('--cmhub-success'),
        warning: tokenColor('--cmhub-warning'),
        danger: tokenColor('--cmhub-danger'),
        'document-paper': tokenColor('--cmhub-document-paper'),
        'document-ink': tokenColor('--cmhub-document-ink'),
        'dark-bg': tokenColor('--cmhub-surface-canvas'),
        'brand-green': tokenColor('--cmhub-interactive-primary'),
        'glass-border': tokenColor('--cmhub-line-subtle'),
        'text-primary': tokenColor('--cmhub-text-primary'),
        'text-secondary': tokenColor('--cmhub-text-secondary'),
        white: tokenColor('--cmhub-surface-base'),
        black: tokenColor('--cmhub-text-primary'),
        red: {
          200: tokenColor('--cmhub-danger-subtle'),
          300: tokenColor('--cmhub-danger-subtle'),
          400: tokenColor('--cmhub-danger'),
          500: tokenColor('--cmhub-danger'),
          950: tokenColor('--cmhub-danger'),
        },
        green: {
          400: tokenColor('--cmhub-success'),
          500: tokenColor('--cmhub-success'),
        },
        amber: {
          200: tokenColor('--cmhub-warning-subtle'),
        },
      },
      borderRadius: {
        control: 'var(--cmhub-control-radius)',
        panel: 'var(--cmhub-panel-radius)',
        pill: 'var(--cmhub-radius-pill)',
        '4xl': '2rem',
      },
      spacing: {
        'cm-1': 'var(--cmhub-space-1)',
        'cm-2': 'var(--cmhub-space-2)',
        'cm-3': 'var(--cmhub-space-3)',
        'cm-4': 'var(--cmhub-space-4)',
        'cm-5': 'var(--cmhub-space-5)',
        'cm-6': 'var(--cmhub-space-6)',
        'cm-8': 'var(--cmhub-space-8)',
        page: 'var(--cmhub-page-gutter)',
        section: 'var(--cmhub-space-section)',
      },
      transitionDuration: {
        micro: 'var(--cmhub-duration-micro)',
        short: 'var(--cmhub-duration-short)',
        standard: 'var(--cmhub-duration-standard)',
      },
      transitionTimingFunction: {
        'cm-out': 'var(--cmhub-ease-out)',
        'cm-in-out': 'var(--cmhub-ease-in-out)',
      },
      blur: {
        '4xl': '2rem',
      },
    },
  },
  plugins: [],
};
