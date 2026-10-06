// The one runtime of the show-me slide deck and written report. scripts/build.mjs minifies it into both
// built templates, and test/show-me-templates.test.ts holds it to 2 KB and to the report's formatters.
//
// 1. Every element with data-f and a data-v gets its text from the raw CLI value in data-v, formatted
//    exactly as src/report/client/format.ts formats it, so the deck, the written report and the orangu
//    report agree. "a+b" in data-v is a sum the report also shows (files changed = edited + written).
// 2. The theme lives in the hash (#theme=dark), as in the report. Light is the default. T toggles it.
// 3. In the deck: arrow keys, PageUp/PageDown, Space, J/K, Home and End move between slides, and the slide
//    across the middle of the viewport is written to the hash as n=<slide>.
;(() => {
  const d = document
  const root = d.documentElement
  const tok = (n) =>
    n >= 1e9 ? (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + 'B'
    : n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 2) + 'M'
    : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'k'
    : String(Math.round(n))
  const ms = (v) => {
    if (v < 1e3) return Math.round(v) + 'ms'
    const s = v / 1e3
    if (s < 60) return s.toFixed(s < 10 ? 1 : 0) + 's'
    const m = Math.floor(s / 60)
    if (m < 60) return m + 'm ' + Math.round(s % 60) + 's'
    const h = Math.floor(m / 60)
    return h < 24 ? h + 'h ' + (m % 60) + 'm' : Math.floor(h / 24) + 'd ' + (h % 24) + 'h'
  }
  const iso = (v) => new Date(v).toISOString()
  const formats = {
    tok,
    ms,
    pct: (n) => (n * 100).toFixed(0) + '%',
    num: (n) => n.toLocaleString('en-US'),
    date: (v) => iso(v).slice(0, 10),
    time: (v) => iso(v).slice(0, 16).replace('T', ' '),
  }
  for (const el of d.querySelectorAll('[data-f][data-v]')) {
    const format = formats[el.dataset.f]
    const value = el.dataset.v.split('+').reduce((sum, part) => sum + Number(part), 0)
    if (format && el.dataset.v && isFinite(value)) el.textContent = format(value)
  }

  const hash = new URLSearchParams(location.hash.slice(1))
  const button = d.getElementById('theme')
  let dark = hash.get('theme') === 'dark'
  let slide = 0
  const write = () => {
    const next = new URLSearchParams()
    if (slide) next.set('n', slide)
    if (dark) next.set('theme', 'dark')
    history.replaceState(null, '', '#' + next)
  }
  const paint = () => {
    if (dark) root.dataset.theme = 'dark'
    else delete root.dataset.theme
    if (button) button.textContent = '\u25d0 theme \u00b7 ' + (dark ? 'dark' : 'light')
  }
  const toggle = () => {
    dark = !dark
    paint()
    write()
  }
  paint()
  if (button) button.addEventListener('click', toggle)

  // every slide is visible: the scope variants live inside the slides, never as whole slides
  const slides = [...d.querySelectorAll('.slide')]
  const count = slides.length
  let at = 0
  // smooth by the CSS scroll-behavior when the reader moves; instant for the slide in the hash on load
  const go = (i, behavior) => {
    at = Math.max(0, Math.min(count - 1, i))
    slides[at].scrollIntoView({ behavior })
  }
  slides.forEach((s, i) => {
    s.setAttribute('aria-label', i + 1 + ' of ' + count)
    const page = s.querySelector('.pg')
    if (page) page.textContent = i + 1 + ' / ' + count
  })
  if (count) {
    go((+hash.get('n') || 1) - 1, 'instant')
    const seen = new IntersectionObserver(
      (entries) => {
        for (const e of entries)
          // the current slide is the one across the middle of the viewport: a full-height slide is then more
          // than half visible, and a tall stacked card on a phone still counts
          if (e.isIntersecting) {
            slide = (at = slides.indexOf(e.target)) + 1
            write()
          }
      },
      { rootMargin: '-45% 0px -45% 0px' },
    )
    for (const s of slides) seen.observe(s)
  }
  d.addEventListener('keydown', (e) => {
    const k = e.key
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (/^t$/i.test(k)) toggle()
    else if (!count) return
    else if (/^(Arrow(Right|Down)|PageDown|j)$/i.test(k) || (k == ' ' && !e.shiftKey)) go(at + 1)
    else if (/^(Arrow(Left|Up)|PageUp|k| )$/i.test(k)) go(at - 1)
    else if (k == 'Home') go(0)
    else if (k == 'End') go(count - 1)
    else return
    e.preventDefault()
  })
})()
