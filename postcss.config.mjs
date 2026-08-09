/**
 * Tailwind v4, and nothing else.
 *
 * The canvas, the node card and every React Flow selector stay in
 * `src/app/globals.css` — see DESIGN.md for which system owns what. Tailwind is
 * here for the interactive primitives (tooltip, toast, dialog, menu, combobox),
 * where the accessibility work is worth buying rather than writing.
 */
const config = {
  plugins: { '@tailwindcss/postcss': {} },
}

export default config
