/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './public/**/*.html',
    './public/**/*.js',
  ],
  theme: {
    extend: {},
  },
  corePlugins: {
    preflight: false, // base.css handles reset
  },
}
