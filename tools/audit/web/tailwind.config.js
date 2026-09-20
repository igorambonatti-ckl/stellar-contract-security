/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'DM Sans', 'system-ui', 'sans-serif'],
      },
      colors: {
        brand: {
          50:  '#E8F0FE',
          100: '#C5D8FC',
          200: '#93B8FA',
          300: '#5A91F7',
          400: '#3578F5',
          500: '#1B6EF3',
          600: '#1452C4',
          700: '#0F3D96',
          800: '#0A2B6B',
          900: '#061A43',
        },
        surface: {
          DEFAULT: '#FFFFFF',
          secondary: '#F5F7FA',
        },
        ink: {
          DEFAULT: '#0D1117',
          muted: '#6B7280',
        },
        line: '#E5E7EB',
        success: '#22C55E',
        danger:  '#EF4444',
      },
      boxShadow: {
        card:       '0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)',
        'card-hover': '0 4px 12px rgba(0,0,0,0.08), 0 2px 4px rgba(0,0,0,0.04)',
      },
    },
  },
  plugins: [],
};
